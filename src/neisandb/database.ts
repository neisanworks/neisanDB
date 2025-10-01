import { Mutex } from "async-mutex";
import { closeSync, openSync, readFileSync } from "fs";
import { open, rename } from "fs/promises";
import pLimit, { type LimitFunction } from "p-limit";
import { dirname, join } from "path";
import z from "zod/v4";
import type {
    DBModel,
    DBModelProperties,
    DBOptions,
    Doc,
    DocWithID,
    DSOptions,
    Lookup,
    MethodFailure,
    MethodReturn,
    MethodSuccess,
    ModelMap,
    ParseFailure,
    PartialSchema,
    RecordUpdate,
    SchemaErrors,
    SchemaKey,
    SchemaPredicate,
    SyncLookup,
    SyncSchemaPredicate
} from "../types.js";
import {
    deepMatch,
    ensureDir,
    ensureFile,
    isAsync,
    isModelMapper,
    isPartialLookup,
    isSchemaPredicate,
    isSync
} from "../utils.js";

export class Database {
    readonly folder: string;
    readonly autoload: boolean;
    readonly limiter: LimitFunction;

    constructor(params: DBOptions) {
        this.folder = ensureDir(params.folder ?? join(process.cwd(), "neisandb"));
        this.autoload = params.autoload ?? true;
        this.limiter = pLimit(params.concurrencyLimit ?? 10);
    }

    collection<
        Shape extends z.ZodRawShape,
        Schema extends z.ZodObject<Shape>,
        Model extends DBModelProperties<Schema>
    >(options: DSOptions<Schema, Model>): Datastore<Shape, Schema, Model> {
        return new Datastore(this, options);
    }
}

class Datastore<
    Shape extends z.ZodRawShape,
    Schema extends z.ZodObject<Shape>,
    Model extends DBModelProperties<Schema>
> {
    private lastID: number = 0;
    private data = new Map<number, Doc<Schema>>();
    private locks = new Map<number, { mutex: Mutex; lastUsed: Date }>();

    readonly name: string;
    readonly path: string;
    readonly autoload: boolean;
    readonly limiter: LimitFunction;

    readonly schema: Schema;
    readonly shape: Shape;
    readonly model: DBModel<Schema, Model>;

    readonly uniques: Set<SchemaKey<Schema>>;
    readonly indexes: Set<SchemaKey<Schema>>;

    private readonly index = new Map<SchemaKey<Schema>, Map<any, Set<number>>>();

    private get dataString(): string {
        return JSON.stringify(Object.fromEntries(this.data), null, 2);
    }

    private get ready(): boolean {
        if (this.data.size === 0) {
            const read = this.readSync();
            if (!read.success) return false;
        }

        return true;
    }

    private get nextID(): number {
        const lastID = this.lastID;
        this.lastID++;
        return lastID + 1;
    }

    constructor(database: Database, params: DSOptions<Schema, Model>) {
        this.name = params.name;
        this.path = ensureFile(join(database.folder, `${this.name}.json`), JSON.stringify({}));
        this.autoload = params.autoload ?? database.autoload;
        this.limiter = database.limiter;
        this.schema = params.schema;
        this.shape = params.schema.shape;
        this.model = params.model;
        this.uniques = new Set(params.uniques);
        this.indexes = new Set(params.indexes);

        if (this.autoload) this.read();

        setInterval(() => {
            if (this.locks.size === 0) return;

            this.locks.forEach(({ mutex, lastUsed }, id) => {
                if (lastUsed.getTime() + 1000 * 60 * 5 > Date.now() && !mutex.isLocked()) {
                    this.locks.delete(id);
                }
            });
        }, 1000 * 60);
    }

    private readSync(): MethodFailure | MethodSuccess {
        const file = openSync(this.path, "r");
        try {
            const dataString = readFileSync(file, { encoding: "utf-8" });
            this.setData(JSON.parse(dataString));
            this.lastID = Math.max(...this.data.keys(), 0);
            return { success: true };
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, errors: { general: message } };
        } finally {
            closeSync(file);
        }
    }

    private async read(): Promise<MethodFailure | MethodSuccess> {
        const file = await open(this.path, "r");
        try {
            const dataString = await file.readFile({ encoding: "utf-8" });
            this.setData(JSON.parse(dataString));
            this.lastID = Math.max(...this.data.keys(), 0);
            return { success: true };
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, errors: { general: message } };
        } finally {
            await file.close();
        }
    }

    private setData(data: unknown) {
        const parsed = data && typeof data === "object" ? data : {};
        Object.entries(parsed).forEach(([id, record]) =>
            this.data.set(Number(id), record as Doc<Schema>)
        );
        this.reindex();
    }

    private reindex(): void {
        this.index.clear();

        this.indexes.forEach((key) => {
            const map = new Map<any, Set<number>>();
            this.data.forEach((record, id) => {
                const value = record[key];
                if (!map.has(value)) {
                    map.set(value, new Set([id]));
                } else {
                    map.get(value)?.add(id);
                }
            });

            this.index.set(key, map);
        });
    }

    private async write(): Promise<MethodFailure | MethodSuccess> {
        const folder = dirname(this.path);
        const temppath = join(folder, `${this.name}.${Date.now()}-${Math.random()}.tmp`);

        const tempfile = await open(temppath, "w");
        try {
            await tempfile.writeFile(this.dataString);
            await tempfile.sync();
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, errors: { general: message } };
        } finally {
            await tempfile.close();
        }

        try {
            await rename(temppath, this.path);
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, errors: { general: message } };
        }

        const directory = await open(folder, "r");
        try {
            await directory.sync();
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, errors: { general: message } };
        } finally {
            await directory.close();
        }

        this.reindex();
        return { success: true };
    }

    private lock(id: number): Mutex {
        if (!this.locks.has(id)) {
            this.locks.set(id, { mutex: new Mutex(), lastUsed: new Date() });
        }

        const mutex = this.locks.get(id)!;
        mutex.lastUsed = new Date();
        this.locks.set(id, mutex);

        return this.locks.get(id)!.mutex;
    }

    loadSync(): MethodFailure | MethodSuccess {
        return this.readSync();
    }

    async load(): Promise<MethodFailure | MethodSuccess> {
        return await this.read();
    }

    private schemaErrorFailure(parsed: ParseFailure<Schema>): MethodFailure<SchemaErrors<Schema>> {
        const errors: SchemaErrors<Schema> = {};
        z.treeifyError(parsed.error, (issue) => {
            const path = issue.path.at(0);
            if (path) errors[path as SchemaKey<Schema>] = issue.message;
        });
        return { success: false, errors };
    }

    existsSync(id: number): boolean;
    existsSync(params: PartialSchema<Schema>): boolean;
    existsSync(predicate: SyncSchemaPredicate<Schema>): boolean;
    existsSync(lookup: number | SyncLookup<Schema>): boolean {
        if (!this.ready) return false;

        if (typeof lookup === "number") {
            return this.data.has(lookup);
        }

        let exists: boolean = false;
        const checkExistence = (ids: Iterable<number>) => {
            Array.from(ids).forEach((id) => {
                if (exists) return;

                const record = this.data.get(id);
                if (!record) return;

                if (typeof lookup === "function") {
                    exists = lookup(record, id);
                } else {
                    exists = deepMatch(record, lookup);
                }
            });
        };

        if (isPartialLookup(lookup, this.schema)) {
            const indexed = new Set<SchemaKey<Schema>>();
            Object.keys(lookup).forEach((key) => {
                if (this.indexes.has(key as SchemaKey<Schema>)) {
                    indexed.add(key as SchemaKey<Schema>);
                }
            });
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const valueIDMap = this.index.get(key)!;
                    const ids = valueIDMap.get(lookup[key]);
                    if (!ids) return false;

                    if (this.uniques.has(key)) {
                        checkExistence(ids);
                        return exists;
                    }

                    checkExistence(ids);
                    if (!exists) continue;

                    return exists;
                }
            }
        }

        checkExistence(this.data.keys());
        return exists;
    }

    async exists(id: number): Promise<boolean>;
    async exists(params: PartialSchema<Schema>): Promise<boolean>;
    async exists(predicate: SchemaPredicate<Schema>): Promise<boolean>;
    async exists(lookup: number | Lookup<Schema>): Promise<boolean> {
        if (!this.ready) return false;

        if (typeof lookup === "number") {
            return this.data.has(lookup);
        }

        let exists = false;
        const checkExistence = async (ids: Iterable<number>) => {
            await Promise.all(
                Array.from(ids).map((id) =>
                    this.limiter(async () => {
                        if (exists) return;

                        return this.lock(id).runExclusive(async () => {
                            if (exists) return;

                            const record = this.data.get(id);
                            if (!record) return;

                            if (typeof lookup === "function") {
                                exists = isSync(lookup)
                                    ? lookup(record, id)
                                    : await lookup(record, id);
                            } else {
                                exists = deepMatch(record, lookup);
                            }
                        });
                    })
                )
            );
        };

        if (isPartialLookup(lookup, this.schema)) {
            const indexed = new Set<SchemaKey<Schema>>();
            Object.keys(lookup).forEach((key) => {
                if (this.indexes.has(key as SchemaKey<Schema>)) {
                    indexed.add(key as SchemaKey<Schema>);
                }
            });
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const valueIDMap = this.index.get(key)!;
                    const ids = valueIDMap.get(lookup[key]);
                    if (!ids) return false;

                    if (this.uniques.has(key)) {
                        await checkExistence(ids);
                        return exists;
                    }

                    await checkExistence(ids);
                    if (!exists) continue;

                    return exists;
                }
            }
        }

        await checkExistence(this.data.keys());
        return exists;
    }

    findOneSync(id: number): Model | undefined;
    findOneSync(params: PartialSchema<Schema>): Model | undefined;
    findOneSync(predicate: SyncSchemaPredicate<Schema>): Model | undefined;
    findOneSync(lookup: number | SyncLookup<Schema>): Model | undefined {
        if (!this.ready) return;

        if (typeof lookup === "number") {
            const record = this.data.get(lookup);
            return record ? new this.model(record, lookup) : undefined;
        }

        const matchedRecord = (ids: Iterable<number>) => {
            for (const id of ids) {
                const record = this.data.get(id);
                if (!record) continue;

                if (typeof lookup === "function") {
                    const matches = lookup(record, id);
                    if (matches) return new this.model(record, id);
                } else {
                    const matches = Object.entries(lookup).every(
                        ([k, v]) => record[k as keyof typeof lookup] === v
                    );
                    if (matches) return new this.model(record, id);
                }
            }
        };

        if (isPartialLookup(lookup, this.schema)) {
            const indexed = new Set<SchemaKey<Schema>>();
            Object.keys(lookup).forEach((key) => {
                if (this.indexes.has(key as SchemaKey<Schema>)) {
                    indexed.add(key as SchemaKey<Schema>);
                }
            });
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const valueIDMap = this.index.get(key)!;
                    const ids = valueIDMap.get(lookup[key]);
                    if (!ids) continue;

                    if (this.uniques.has(key)) {
                        return matchedRecord(ids);
                    }

                    const matched = matchedRecord(ids);
                    if (!matched) continue;

                    return matched;
                }
            }
        }

        return matchedRecord(this.data.keys());
    }

    async findOne(id: number): Promise<Model | undefined>;
    async findOne(params: PartialSchema<Schema>): Promise<Model | undefined>;
    async findOne(predicate: SchemaPredicate<Schema>): Promise<Model | undefined>;
    async findOne(lookup: number | Lookup<Schema>): Promise<Model | undefined> {
        if (!this.ready) return;

        if (typeof lookup === "number") {
            const record = this.data.get(lookup);
            if (!record) return;

            return new this.model(record, lookup);
        }

        let model: Model | undefined = undefined;
        const findMatching = async (iterable: Iterable<number>) => {
            await Promise.all(
                Array.from(iterable).map((id) =>
                    this.limiter(async () => {
                        if (model) return;

                        return this.lock(id).runExclusive(async () => {
                            if (model) return;

                            const record = this.data.get(id);
                            if (!record) return;

                            if (
                                (typeof lookup === "function" &&
                                    ((isAsync(lookup) && (await lookup(record, id))) ||
                                        (isSync(lookup) && lookup(record, id)))) ||
                                deepMatch(record, lookup)
                            ) {
                                model = new this.model(record, id);
                            }
                        });
                    })
                )
            );
        };

        if (isPartialLookup(lookup, this.schema)) {
            const indexed = new Set<SchemaKey<Schema>>();
            Object.keys(lookup).forEach((key) => {
                if (this.indexes.has(key as SchemaKey<Schema>)) {
                    indexed.add(key as SchemaKey<Schema>);
                }
            });
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const valueIDMap = this.index.get(key)!;
                    const ids = valueIDMap.get(lookup[key]);
                    if (!ids) continue;

                    if (this.uniques.has(key)) {
                        await findMatching(ids);
                        return model;
                    }

                    await findMatching(ids);
                    if (!model) continue;

                    return model;
                }
            }
        }

        await findMatching(this.data.keys());
        return model;
    }

    async findOneAndUpdate(
        id: number,
        update: RecordUpdate<Schema, Model>
    ): Promise<
        MethodFailure<Record<"general", string> | SchemaErrors<Schema>> | MethodReturn<Model>
    > {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        const writeUpdate = async (
            id: number,
            update: Doc<Schema>,
            fallback: Doc<Schema>
        ): Promise<MethodFailure | MethodReturn<Model>> => {
            this.data.set(id, update);
            const write = await this.write();
            if (!write.success) {
                this.data.set(id, fallback);
                return write;
            }

            return { success: true, data: new this.model(update, id) };
        };

        return this.lock(id).runExclusive(async () => {
            const record = this.data.get(id);
            if (!record) {
                return {
                    success: false,
                    errors: { general: `${this.name} with id ${id} not found` }
                };
            }

            if (typeof update === "object") {
                const parsed = await this.schema.partial().safeParseAsync(update);
                if (!parsed.success) {
                    return this.schemaErrorFailure(parsed);
                }

                const updated: Doc<Schema> = {
                    ...record,
                    ...parsed.data
                };
                return await writeUpdate(id, updated, record);
            } else {
                const oldModel = new this.model(record, id);
                const updatedModel = update(oldModel);

                const parsed = await this.schema.safeParseAsync(updatedModel);
                if (!parsed.success) {
                    return this.schemaErrorFailure(parsed);
                }

                return await writeUpdate(id, parsed.data, record);
            }
        });
    }

    async findOneAndDelete(id: number): Promise<MethodFailure | MethodReturn<Model>> {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        return this.lock(id).runExclusive(async () => {
            const record = this.data.get(id);
            if (!record) {
                return {
                    success: false,
                    errors: { general: `Failed to find ${this.name} with id ${id}` }
                };
            }

            this.data.delete(id);
            const write = await this.write();
            if (!write.success) {
                this.data.set(id, record);
                return write;
            }

            return { success: true, data: new this.model(record, id) };
        });
    }

    findSync(): Array<Model> | undefined;
    findSync(params: PartialSchema<Schema>): Array<Model> | undefined;
    findSync(params: PartialSchema<Schema>, limit: number): Array<Model> | undefined;
    findSync(predicate: SyncSchemaPredicate<Schema>): Array<Model> | undefined;
    findSync(predicate: SyncSchemaPredicate<Schema>, limit: number): Array<Model> | undefined;
    findSync(lookup?: SyncLookup<Schema>, limit?: number): Array<Model> | undefined {
        if (!this.ready) return;

        if (!lookup) {
            return Array.from(this.data).map(([id, record]) => {
                return new this.model(record, id);
            });
        }

        const findMatches = (ids: Iterable<number>): Array<Model> | undefined => {
            const matches = Array.from(ids)
                .filter((id) => {
                    const record = this.data.get(id);
                    if (!record) return false;

                    if (typeof lookup === "function") {
                        return lookup(record, id);
                    } else {
                        return Object.entries(lookup).every(([k, v]) => {
                            return record[k as keyof typeof lookup] === v;
                        });
                    }
                })
                .slice(0, limit)
                .map((id) => new this.model(this.data.get(id)!, id));

            return matches.length > 0 ? matches : undefined;
        };

        if (isPartialLookup(lookup, this.schema)) {
            const indexed = new Set<SchemaKey<Schema>>();
            Object.keys(lookup).forEach((key) => {
                if (this.index.has(key as SchemaKey<Schema>)) {
                    indexed.add(key as SchemaKey<Schema>);
                }
            });
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const valueIDMap = this.index.get(key)!;
                    const ids = valueIDMap.get(lookup[key as SchemaKey<Schema>]);
                    if (!ids) continue;

                    if (this.uniques.has(key)) {
                        return findMatches(ids);
                    }

                    const matches = findMatches(ids);
                    if (!matches) continue;

                    return matches;
                }
            }
        }

        return findMatches(this.data.keys());
    }

    async find(): Promise<Array<Model> | undefined>;
    async find(params: PartialSchema<Schema>): Promise<Array<Model> | undefined>;
    async find(params: PartialSchema<Schema>, limit: number): Promise<Array<Model> | undefined>;
    async find(predicate: SchemaPredicate<Schema>): Promise<Array<Model> | undefined>;
    async find(
        predicate: SchemaPredicate<Schema>,
        limit: number
    ): Promise<Array<Model> | undefined>;
    async find(lookup?: Lookup<Schema>, limit?: number): Promise<Array<Model> | undefined> {
        if (!this.ready) return;

        const models: Array<Model> = [];

        const concurrentPushMatching = async (iterable: Iterable<number>) => {
            await Promise.all(
                Array.from(iterable).map((id) =>
                    this.limiter(async () => {
                        if (limit && models.length >= limit) return;

                        await this.lock(id).runExclusive(async () => {
                            if (limit && models.length >= limit) return;

                            const record = this.data.get(id);
                            if (!record) return;

                            if (!lookup) {
                                models.push(new this.model(record, id));
                            } else if (typeof lookup === "function") {
                                if (
                                    (isAsync(lookup) && (await lookup(record, id))) ||
                                    (isSync(lookup) && lookup(record, id))
                                ) {
                                    models.push(new this.model(record, id));
                                }
                            } else if (deepMatch(record, lookup)) {
                                models.push(new this.model(record, id));
                            }
                        });
                    })
                )
            );
        };

        if (!lookup) {
            await concurrentPushMatching(this.data.keys());

            return models.length > 0 ? models : undefined;
        }

        if (isPartialLookup(lookup, this.schema)) {
            const indexed = new Set<SchemaKey<Schema>>();
            Object.keys(lookup).forEach((key) => {
                if (this.indexes.has(key as SchemaKey<Schema>)) {
                    indexed.add(key as SchemaKey<Schema>);
                }
            });
            if (indexed.size > 0) {
                for (const indexKey of indexed) {
                    const valueMap: Map<any, Set<number>> | undefined = this.index.get(indexKey);
                    if (!valueMap || valueMap.size === 0) continue;

                    const ids: Set<number> | undefined = valueMap.get(lookup[indexKey]);
                    if (!ids) continue;

                    if (this.uniques.has(indexKey)) {
                        await concurrentPushMatching(ids);

                        return models.length > 0 ? models : undefined;
                    }

                    await concurrentPushMatching(ids);

                    if (models.length === 0) continue;

                    return models.length > 0 ? models : undefined;
                }
            }

            await concurrentPushMatching(this.data.keys());

            return models.length > 0 ? models : undefined;
        }

        await concurrentPushMatching(this.data.keys());

        return models.length > 0 ? models : undefined;
    }

    async findAndMap<T>(map: ModelMap<Schema, Model, T>): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        params: PartialSchema<Schema>,
        map: ModelMap<Schema, Model, T>
    ): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        predicate: SchemaPredicate<Schema>,
        map: ModelMap<Schema, Model, T>
    ): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        arg_1: Lookup<Schema> | ModelMap<Schema, Model, T>,
        arg_2?: ModelMap<Schema, Model, T>
    ): Promise<Array<T> | undefined> {
        if (!this.ready) return;

        const mappedModels = async (
            models: Iterable<Model> | undefined,
            mapper: ModelMap<Schema, Model, T>
        ) => {
            if (!models) return;

            const results: Array<T> = [];
            await Promise.all(
                Array.from(models).map((model) =>
                    this.limiter(async () => {
                        let result: T | undefined = undefined;

                        if (isSync(mapper)) {
                            result = mapper(model);
                        } else {
                            result = await mapper(model);
                        }

                        if (result) results.push(result);
                    })
                )
            );
            return results.length > 0 ? results : undefined;
        };

        if (isSchemaPredicate(arg_1, this.model)) {
            if (!arg_2) return;

            const models = await this.find(arg_1);
            return await mappedModels(models, arg_2);
        }

        if (isModelMapper(arg_1, this.model)) {
            const models = await this.find();
            return await mappedModels(models, arg_1);
        }

        if (isPartialLookup(arg_1, this.schema)) {
            if (!arg_2) return;

            const models = await this.find(arg_1);
            return await mappedModels(models, arg_2);
        }
    }

    async findAndUpdate(
        params: PartialSchema<Schema>,
        update: RecordUpdate<Schema, Model>
    ): Promise<
        MethodFailure<Record<"general", string> | SchemaErrors<Schema>> | MethodReturn<Array<Model>>
    >;
    async findAndUpdate(
        predicate: SchemaPredicate<Schema>,
        update: RecordUpdate<Schema, Model>
    ): Promise<
        MethodFailure<Record<"general", string> | SchemaErrors<Schema>> | MethodReturn<Array<Model>>
    >;
    async findAndUpdate(
        lookup: Lookup<Schema>,
        update: RecordUpdate<Schema, Model>
    ): Promise<
        MethodFailure<Record<"general", string> | SchemaErrors<Schema>> | MethodReturn<Array<Model>>
    > {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        let partialUpdate: PartialSchema<Schema>;
        if (typeof update === "object") {
            const parsed = await this.schema.partial().safeParseAsync(update);
            if (!parsed.success) {
                return this.schemaErrorFailure(parsed);
            }

            partialUpdate = parsed.data as PartialSchema<Schema>;
        }

        let errors: SchemaErrors<Schema> | undefined = undefined;
        const cache = new Map<number, Doc<Schema>>();

        const matches: Array<Model> = [];

        const concurrentUpdateMatching = async (iterable: Iterable<number>) => {
            await Promise.all(
                Array.from(iterable).map((id) =>
                    this.limiter(async () => {
                        if (errors) return;

                        await this.lock(id).runExclusive(async () => {
                            if (errors) return;

                            const record = this.data.get(id);
                            if (!record) return;

                            const isMatch: boolean = isPartialLookup(lookup, this.schema)
                                ? deepMatch(record, lookup)
                                : isAsync(lookup)
                                  ? await lookup(record, id)
                                  : isSync(lookup)
                                    ? lookup(record, id)
                                    : false;
                            if (!isMatch) return;

                            if (typeof update === "function") {
                                const oldModel = new this.model(record, id);
                                const updatedModel = update(oldModel);

                                const parsed = await this.schema.safeParseAsync(updatedModel);
                                if (!parsed.success) {
                                    errors = this.schemaErrorFailure(parsed).errors;
                                    return;
                                }

                                cache.set(id, record);
                                this.data.set(id, parsed.data);
                                matches.push(new this.model(parsed.data, id));
                            } else {
                                if (!partialUpdate) {
                                    const parsed = await this.schema
                                        .partial()
                                        .safeParseAsync(update);
                                    if (!parsed.success) {
                                        errors = this.schemaErrorFailure(parsed).errors;
                                        return;
                                    }

                                    partialUpdate = parsed.data as PartialSchema<Schema>;
                                }

                                const updatedRecord: Doc<Schema> = {
                                    ...record,
                                    ...partialUpdate
                                };

                                cache.set(id, record);
                                this.data.set(id, updatedRecord);
                                matches.push(new this.model(updatedRecord, id));
                            }
                        });
                    })
                )
            );
        };

        const finalize = async (): Promise<
            MethodFailure<{ general: string } | SchemaErrors<Schema>> | MethodReturn<Array<Model>>
        > => {
            if (errors) {
                cache.forEach((cache, id) => this.data.set(id, cache));
                return { success: false, errors };
            }
            if (matches.length === 0) {
                return { success: false, errors: { general: "No Document Matches" } };
            }

            const write = await this.write();
            if (!write.success) {
                cache.forEach((cache, id) => this.data.set(id, cache));
                return write;
            }

            return { success: true, data: matches };
        };

        if (isPartialLookup(lookup, this.schema)) {
            const indexed = new Set<SchemaKey<Schema>>();
            Object.keys(lookup).forEach((key) => {
                if (this.indexes.has(key as SchemaKey<Schema>)) {
                    indexed.add(key as SchemaKey<Schema>);
                }
            });
            if (indexed.size > 0) {
                for (const indexKey of indexed) {
                    const valueMap: Map<any, Set<number>> = this.index.get(indexKey)!;
                    if (valueMap.size === 0) continue;

                    const ids: Set<number> | undefined = valueMap.get(lookup[indexKey]);
                    if (!ids) continue;

                    if (this.uniques.has(indexKey)) {
                        await concurrentUpdateMatching(ids);

                        return await finalize();
                    }

                    await concurrentUpdateMatching(ids);

                    if (errors) {
                        cache.forEach((cache, id) => this.data.set(id, cache));
                        return { success: false, errors };
                    }
                    if (matches.length === 0) continue;

                    const write = await this.write();
                    if (!write.success) {
                        cache.forEach((cached, id) => this.data.set(id, cached));
                        return write;
                    }

                    return { success: true, data: matches };
                }
            }

            await concurrentUpdateMatching(this.data.keys());

            return await finalize();
        }

        await concurrentUpdateMatching(this.data.keys());

        return await finalize();
    }

    async findAndDelete(
        params: PartialSchema<Schema>
    ): Promise<MethodFailure | MethodReturn<Array<Model>>>;
    async findAndDelete(
        predicate: SchemaPredicate<Schema>
    ): Promise<MethodFailure | MethodReturn<Array<Model>>>;
    async findAndDelete(
        lookup: Lookup<Schema>
    ): Promise<MethodFailure | MethodReturn<Array<Model>>> {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        const cache = new Map<number, Doc<Schema>>();
        const matches: Array<Model> = [];
        const concurrentDeletion = async (ids: Iterable<number>) => {
            await Promise.all(
                Array.from(ids).map((id) =>
                    this.limiter(async () =>
                        this.lock(id).runExclusive(async () => {
                            const record = this.data.get(id);
                            if (!record) return;

                            const isMatch: boolean = isPartialLookup(lookup, this.schema)
                                ? deepMatch(record, lookup)
                                : isAsync(lookup)
                                  ? await lookup(record, id)
                                  : isSync(lookup)
                                    ? lookup(record, id)
                                    : false;
                            if (!isMatch) return;

                            cache.set(id, record);
                            this.data.delete(id);
                            matches.push(new this.model(record, id));
                        })
                    )
                )
            );
        };

        const finalize = async (): Promise<MethodFailure | MethodReturn<Array<Model>>> => {
            if (matches.length === 0) {
                return { success: false, errors: { general: "No Document Matches" } };
            }

            const write = await this.write();
            if (!write.success) {
                await Promise.all(
                    Array.from(cache.keys()).map((id) =>
                        this.limiter(async () =>
                            this.lock(id).runExclusive(async () =>
                                this.data.set(id, cache.get(id)!)
                            )
                        )
                    )
                );
                return write;
            }

            return { success: true, data: matches };
        };

        if (isPartialLookup(lookup, this.schema)) {
            const indexed = new Set<SchemaKey<Schema>>();
            Object.keys(lookup).forEach((key) => {
                if (this.indexes.has(key as SchemaKey<Schema>)) {
                    indexed.add(key as SchemaKey<Schema>);
                }
            });
            if (indexed.size > 0) {
                for (const indexKey of indexed) {
                    const valueMap: Map<any, Set<number>> = this.index.get(indexKey)!;
                    if (valueMap.size === 0) continue;

                    const ids: Set<number> | undefined = valueMap.get(lookup[indexKey]);
                    if (!ids) continue;

                    if (this.uniques.has(indexKey)) {
                        await concurrentDeletion(ids);

                        return await finalize();
                    }

                    await concurrentDeletion(ids);

                    if (matches.length === 0) continue;

                    const write = await this.write();
                    if (!write.success) {
                        await Promise.all(
                            Array.from(cache.keys()).map((id) =>
                                this.limiter(async () =>
                                    this.lock(id).runExclusive(async () =>
                                        this.data.set(id, cache.get(id)!)
                                    )
                                )
                            )
                        );
                        return write;
                    }

                    return { success: true, data: matches };
                }
            }

            await concurrentDeletion(this.data.keys());

            return await finalize();
        }

        await concurrentDeletion(this.data.keys());

        return await finalize();
    }

    async create(
        record: z.core.input<Schema>
    ): Promise<
        MethodFailure<SchemaErrors<Schema> | Record<"general", string>> | MethodReturn<Model>
    > {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        const nextID = this.nextID;
        return this.lock(nextID).runExclusive(async () => {
            const parse = await this.schema.safeParseAsync(record);
            if (!parse.success) {
                return this.schemaErrorFailure(parse);
            }

            let error: MethodFailure<SchemaErrors<Schema>> | undefined;
            await Promise.all(
                Array.from(this.uniques).map((key) =>
                    this.limiter(async () => {
                        if (error) return;

                        if (
                            Array.from(this.data.values()).some(
                                (record) => record[key] === parse.data[key]
                            )
                        ) {
                            error = {
                                success: false,
                                errors: {
                                    [key]: "Already in use"
                                } as SchemaErrors<Schema>
                            };
                        }
                    })
                )
            );

            if (error) return error;

            this.data.set(nextID, parse.data);
            const write = await this.write();
            if (!write.success) {
                this.data.delete(nextID);
                return write;
            }

            return { success: true, data: new this.model(parse.data, nextID) };
        });
    }
}

export abstract class CollectionModel<Schema extends z.ZodObject> {
    id: number;
    schema: Schema;

    constructor(schema: Schema, id: number) {
        this.id = id;
        this.schema = schema;
    }

    get json(): DocWithID<Schema> {
        const parsed = this.schema.safeParse(this);
        if (!parsed.success) {
            const errors: SchemaErrors<Schema> = {};
            z.treeifyError(
                parsed.error,
                (issue) => (errors[issue.path[0] as keyof z.infer<Schema>] = issue.message)
            );
            throw new Error(JSON.stringify(errors));
        }
        return {
            id: this.id,
            ...parsed.data
        };
    }
}
