import { Mutex } from "async-mutex";
import pLimit, { type LimitFunction } from "p-limit";
import path from "path";
import z from "zod/v4";
import { type JSONStorageEngine, MsgPackStorageEngine } from "./storage-engines/index.js";
import type {
    DBModel,
    DBModelProperties,
    DBOptions,
    Doc,
    DocWithID,
    DSEngineOptions,
    Failure,
    GeneralError,
    Key,
    Lookup,
    ModelTransformation,
    ModelUpdate,
    ParseErrors,
    ParseFailure,
    PartialSchema,
    Return,
    SchemaPredicate,
    Success
} from "../types.js";
import {
    isDeepPartial,
    isModelTransformation,
    isDeepMatch,
    isModelUpdateFunction
} from "../utils.js";

export class Database {
    readonly folder: string;
    readonly autoload: boolean;
    readonly limiter: LimitFunction;

    constructor(params: DBOptions) {
        this.folder = params.folder ?? path.join(process.cwd(), "neisandb");
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

export interface DSOptions<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>> {
    name: string;
    schema: Schema;
    model: DBModel<Schema, Model>;
    autoload?: boolean;
    uniques?: Array<keyof z.core.output<Schema>>;
    indexes?: Array<keyof z.core.output<Schema>>;
    engine?: new (
        options: DSEngineOptions<Schema>
    ) => MsgPackStorageEngine<Schema> | JSONStorageEngine<Schema>;
}

class Datastore<
    Shape extends z.ZodRawShape,
    Schema extends z.ZodObject<Shape>,
    Model extends DBModelProperties<Schema>
> {
    private engine: MsgPackStorageEngine<Schema> | JSONStorageEngine<Schema>;
    private lastID: number = 0;
    private data = new Map<number, Doc<Schema>>();
    private locks = new Map<number, { mutex: Mutex; lastUsed: Date }>();

    readonly autoload: boolean;
    readonly limiter: LimitFunction;

    readonly schema: Schema;
    readonly shape: Shape;
    readonly model: DBModel<Schema, Model>;

    readonly uniques: Set<Key<Schema>>;
    readonly indexes: Set<Key<Schema>>;

    private readonly index = new Map<Key<Schema>, Map<any, Set<number>>>();

    constructor(database: Database, options: DSOptions<Schema, Model>) {
        const engineoptions: DSEngineOptions<Schema> = {
            folder: database.folder,
            name: options.name,
            schema: options.schema,
            debug: false
        };
        this.engine = options.engine
            ? new options.engine(engineoptions)
            : new MsgPackStorageEngine(engineoptions);

        this.autoload = options.autoload ?? database.autoload;
        this.limiter = database.limiter;
        this.schema = options.schema;
        this.shape = options.schema.shape;
        this.model = options.model;
        this.uniques = new Set(options.uniques);
        this.indexes = new Set(options.indexes);

        if (this.autoload) this.read();
    }

    private async read(): Promise<Failure | Success> {
        const read = await this.engine.read();
        if (!read.success) {
            return read;
        }

        this.data = read.data;
        return { success: true };
    }

    async isReady(): Promise<boolean> {
        if (this.data.size === 0) {
            const read = await this.read();
            if (!read.success) return false;
        }

        return true;
    }

    notReadyFailure(): Failure {
        return {
            success: false,
            errors: { general: `Failed to read datastore file: ${this.engine.path}` }
        };
    }

    noRecordFailure(id: number): Failure {
        return {
            success: false,
            errors: { general: `Failed to find ${this.engine.name} with id ${id}` }
        };
    }

    noMatchFailure(): Failure {
        return { success: false, errors: { general: "No Document Matches" } };
    }

    schemaFailure(failure: ParseFailure<Schema>): Failure<ParseErrors<Schema>> {
        const errors: ParseErrors<Schema> = {};
        z.treeifyError(failure.error, (issue) => {
            const path = issue.path.at(0);
            if (path) errors[path as Key<Schema>] = issue.message;
        });
        return { success: false, errors };
    }

    uniqueConflictFailure(key: Key<Schema>): Failure<ParseErrors<Schema>> {
        return {
            success: false,
            errors: { [key]: "Conflict as unique key" }
        } as Failure<ParseErrors<Schema>>;
    }

    async load(): Promise<Failure | Success> {
        return await this.read();
    }

    private get nextID(): number {
        const lastID = this.lastID;
        this.lastID++;
        return lastID + 1;
    }

    private async write(): Promise<Failure | Success> {
        const write = await this.engine.write(this.data);
        if (!write.success) return write;

        this.index.clear();
        await Promise.all(
            Array.from(this.indexes).map((key) =>
                this.limiter(() => {
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
                })
            )
        );

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

    private isIndexed(partial: PartialSchema<Schema>): Set<Key<Schema>> {
        const indexed = new Set<Key<Schema>>();
        Object.keys(partial).forEach((key) => {
            if (this.indexes.has(key as Key<Schema>)) {
                indexed.add(key as Key<Schema>);
            }
        });
        return indexed;
    }

    private indexIDs(lookup: PartialSchema<Schema>, key: Key<Schema>): Set<number> | undefined {
        const valueIDMap = this.index.get(key)!;
        return valueIDMap.get(lookup[key]);
    }

    private async concurrent<T, U>(
        items: Iterable<T>,
        callback: (item: T, index: number, array: Array<T>) => Promise<U>
    ): Promise<Array<U>> {
        return Promise.all(
            Array.from(items).map((item, index, array) =>
                this.limiter(async () => await callback(item, index, array))
            )
        );
    }

    async exists(id: number): Promise<boolean>;
    async exists(params: PartialSchema<Schema>): Promise<boolean>;
    async exists(predicate: SchemaPredicate<Schema>): Promise<boolean>;
    async exists(lookup: number | Lookup<Schema>): Promise<boolean> {
        if (!(await this.isReady())) return false;

        if (typeof lookup === "number") {
            return this.data.has(lookup);
        }

        let exists: boolean = false;
        const check = async (ids: Iterable<number>) => {
            await this.concurrent(ids, async (id) => {
                if (exists) return;

                return this.lock(id).runExclusive(async () => {
                    if (exists) return;

                    const record = this.data.get(id);
                    if (!record) return;

                    if (typeof lookup === "function") {
                        exists = await lookup(record, id);
                    } else {
                        exists = await isDeepMatch(record, lookup);
                    }
                });
            });
        };

        if (isDeepPartial(lookup, this.schema)) {
            const indexed = this.isIndexed(lookup);
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const ids = this.indexIDs(lookup, key);
                    if (!ids) continue;

                    if (this.uniques.has(key)) {
                        await check(ids);
                        return exists;
                    }

                    await check(ids);
                    if (!exists) continue;

                    return exists;
                }
            }
        }

        await check(this.data.keys());
        return exists;
    }

    async count(params: PartialSchema<Schema>): Promise<number>;
    async count(predicate: SchemaPredicate<Schema>): Promise<number>;
    async count(lookup: Lookup<Schema>): Promise<number> {
        if (!(await this.isReady())) return 0;

        let matched: number = 0;
        const check = async (ids: Iterable<number>) => {
            await this.concurrent(ids, async (id) =>
                this.lock(id).runExclusive(async () => {
                    const record = this.data.get(id);
                    if (!record) return;

                    if (typeof lookup === "function") {
                        if (await lookup(record, id)) matched++;
                    } else {
                        if (await isDeepMatch(record, lookup)) matched++;
                    }
                })
            );
        };

        if (isDeepPartial(lookup, this.schema)) {
            const indexed = this.isIndexed(lookup);
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const ids = this.indexIDs(lookup, key);
                    if (!ids) continue;

                    if (this.uniques.has(key)) {
                        await check(ids);
                        return matched;
                    }

                    await check(ids);
                    if (matched === 0) continue;

                    return matched;
                }
            }
        }

        await check(this.data.keys());
        return matched;
    }

    async findOne(id: number): Promise<Model | undefined>;
    async findOne(params: PartialSchema<Schema>): Promise<Model | undefined>;
    async findOne(predicate: SchemaPredicate<Schema>): Promise<Model | undefined>;
    async findOne(lookup: number | Lookup<Schema>): Promise<Model | undefined> {
        if (!(await this.isReady())) return;

        if (typeof lookup === "number") {
            const record = this.data.get(lookup);
            if (!record) return;

            return new this.model(record, lookup);
        }

        let model: Model | undefined = undefined;
        const check = async (ids: Iterable<number>) => {
            await this.concurrent(ids, async (id) => {
                if (model) return;

                return this.lock(id).runExclusive(async () => {
                    if (model) return;

                    const record = this.data.get(id);
                    if (!record) return;

                    let matched: boolean = false;
                    if (typeof lookup === "function") {
                        matched = await lookup(record, id);
                    } else {
                        matched = await isDeepMatch(record, lookup);
                    }

                    if (matched) model = new this.model(record, id);
                });
            });
        };

        if (isDeepPartial(lookup, this.schema)) {
            const indexed = this.isIndexed(lookup);
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const ids = this.indexIDs(lookup, key);
                    if (!ids) continue;

                    if (this.uniques.has(key)) {
                        await check(ids);
                        return model;
                    }

                    await check(ids);
                    if (!model) continue;

                    return model;
                }
            }
        }

        await check(this.data.keys());
        return model;
    }

    async findOneAndMutate<T>(
        id: number,
        transformer: ModelTransformation<Schema, Model, T>
    ): Promise<T | undefined>;
    async findOneAndMutate<T>(
        params: PartialSchema<Schema>,
        transformer: ModelTransformation<Schema, Model, T>
    ): Promise<T | undefined>;
    async findOneAndMutate<T>(
        predicate: SchemaPredicate<Schema>,
        transformer: ModelTransformation<Schema, Model, T>
    ): Promise<T | undefined>;
    async findOneAndMutate<T>(
        lookup: number | Lookup<Schema>,
        transformer: ModelTransformation<Schema, Model, T>
    ): Promise<T | undefined> {
        if (!(await this.isReady())) return;

        if (typeof lookup === "number") {
            const record = this.data.get(lookup);
            if (!record) return;

            return await transformer(new this.model(record, lookup));
        }

        if (isDeepPartial(lookup, this.schema)) {
            const model = await this.findOne(lookup);
            if (!model) return;

            return await transformer(model);
        }

        const model = await this.findOne(lookup);
        if (!model) return;

        return await transformer(model);
    }

    async checkUniques(
        data: Map<number, Doc<Schema>>,
        checked: PartialSchema<Schema>,
        id: number
    ): Promise<Failure<ParseErrors<Schema>> | undefined> {
        let error: Failure<ParseErrors<Schema>> | undefined = undefined;
        await this.concurrent(this.uniques, async (unique) => {
            if (error) return;

            let conflict: boolean = false;
            await this.concurrent(data.entries(), async ([recordID, record]) => {
                if (conflict) return;
                conflict = record[unique] === checked[unique] && recordID !== id;
            });
            if (conflict) {
                error = this.uniqueConflictFailure(unique);
            }
        });
        if (error) return error;
    }

    async findOneAndUpdate(
        id: number,
        update: ModelUpdate<Schema, Model>
    ): Promise<Failure<GeneralError | ParseErrors<Schema>> | Return<Model>> {
        if (!(await this.isReady())) return this.notReadyFailure();

        const push = async (
            update: Doc<Schema>,
            fallback: Doc<Schema>
        ): Promise<Failure | Return<Model>> => {
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
                return this.noRecordFailure(id);
            }

            let updated: Doc<Schema>;
            if (typeof update === "object") {
                const parsed = await this.schema.partial().safeParseAsync(update);
                if (!parsed.success) {
                    return this.schemaFailure(parsed);
                }

                updated = {
                    ...record,
                    ...parsed.data
                };
            } else {
                const oldModel = new this.model(record, id);
                const updatedModel = await update(oldModel);

                const parsed = await this.schema.safeParseAsync(updatedModel);
                if (!parsed.success) {
                    return this.schemaFailure(parsed);
                }
                updated = parsed.data;
            }

            const conflict = await this.checkUniques(this.data, updated, id);
            if (conflict) return conflict;

            return push(updated, record);
        });
    }

    async findOneAndDelete(id: number): Promise<Failure | Return<Model>> {
        if (!(await this.isReady())) return this.notReadyFailure();

        return this.lock(id).runExclusive(async () => {
            const record = this.data.get(id);
            if (!record) {
                return this.noRecordFailure(id);
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

    async find(): Promise<Array<Model> | undefined>;
    async find(limit: number): Promise<Array<Model> | undefined>;
    async find(limit: number, offset: number): Promise<Array<Model> | undefined>;
    async find(params: PartialSchema<Schema>): Promise<Array<Model> | undefined>;
    async find(params: PartialSchema<Schema>, limit: number): Promise<Array<Model> | undefined>;
    async find(
        params: PartialSchema<Schema>,
        limit: number,
        offset: number
    ): Promise<Array<Model> | undefined>;
    async find(predicate: SchemaPredicate<Schema>): Promise<Array<Model> | undefined>;
    async find(
        predicate: SchemaPredicate<Schema>,
        limit: number
    ): Promise<Array<Model> | undefined>;
    async find(
        predicate: SchemaPredicate<Schema>,
        limit: number,
        offset: number
    ): Promise<Array<Model> | undefined>;
    async find(
        arg_1?: number | Lookup<Schema>,
        arg_2?: number,
        arg_3?: number
    ): Promise<Array<Model> | undefined> {
        if (!(await this.isReady())) return;

        let lookup: Lookup<Schema> | undefined = undefined;
        let limit: number | undefined = undefined;
        let offset: number = 0;

        if (!!arg_3 && !!arg_2 && !!arg_1) {
            offset = Math.max(arg_3, 0);
            limit = Math.max(arg_2, 0);

            if (typeof arg_1 === "number") {
                throw new Error(
                    `Invalid argument passed to ${this.engine.name} .find(...) method: arg_1`
                );
            }
            lookup = arg_1;
        } else if (!!arg_2 && !!arg_1) {
            if (typeof arg_1 === "number") {
                offset = Math.max(arg_2, 0);
                limit = Math.max(arg_1, 0);
            } else {
                limit = Math.max(arg_2, 0);
                lookup = arg_1;
            }
        } else if (!!arg_1) {
            if (typeof arg_1 === "number") {
                limit = Math.max(arg_1, 0);
            } else {
                lookup = arg_1;
            }
        }

        const models: Array<Model> = [];
        const results = () => (models.length > 0 ? models : undefined);
        const check = async (ids: Iterable<number>) => {
            await this.concurrent(ids, async (id, index) => {
                if (offset > index) return;
                if (limit && models.length >= limit) return;

                await this.lock(id).runExclusive(async () => {
                    if (limit && models.length >= limit) return;

                    const record = this.data.get(id);
                    if (!record) return;

                    if (!lookup) {
                        models.push(new this.model(record, id));
                    } else if (typeof lookup === "function") {
                        if (await lookup(record, id)) {
                            models.push(new this.model(record, id));
                        }
                    } else if (await isDeepMatch(record, lookup)) {
                        models.push(new this.model(record, id));
                    }
                });
            });
        };

        if (!lookup) {
            await check(this.data.keys());
            return results();
        }

        if (isDeepPartial(lookup, this.schema)) {
            const indexed = this.isIndexed(lookup);
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const ids = this.indexIDs(lookup, key);
                    if (!ids) continue;

                    if (this.uniques.has(key)) {
                        await check(ids);
                        return results();
                    }

                    await check(ids);
                    if (!results()) continue;

                    return results();
                }
            }
        }

        await check(this.data.keys());
        return results();
    }

    async findAndMap<T>(map: ModelTransformation<Schema, Model, T>): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        map: ModelTransformation<Schema, Model, T>,
        limit: number,
        offset: number
    ): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        params: PartialSchema<Schema>,
        map: ModelTransformation<Schema, Model, T>
    ): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        params: PartialSchema<Schema>,
        map: ModelTransformation<Schema, Model, T>,
        limit: number
    ): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        params: PartialSchema<Schema>,
        map: ModelTransformation<Schema, Model, T>,
        limit: number,
        offset: number
    ): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        predicate: SchemaPredicate<Schema>,
        map: ModelTransformation<Schema, Model, T>
    ): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        predicate: SchemaPredicate<Schema>,
        map: ModelTransformation<Schema, Model, T>,
        limit: number
    ): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        predicate: SchemaPredicate<Schema>,
        map: ModelTransformation<Schema, Model, T>,
        limit: number,
        offset: number
    ): Promise<Array<T> | undefined>;
    async findAndMap<T>(
        arg_1: ModelTransformation<Schema, Model, T> | Lookup<Schema>,
        arg_2?: number | ModelTransformation<Schema, Model, T>,
        arg_3?: number,
        arg_4?: number
    ): Promise<Array<T> | undefined> {
        if (!(await this.isReady())) return;

        let lookup: Lookup<Schema> | undefined = undefined;
        let transformation: ModelTransformation<Schema, Model, T>;
        let limit: number | undefined = undefined;
        let offset: number = 0;

        if (!!arg_4 && !!arg_3 && !!arg_2) {
            offset = Math.max(arg_4, 0);
            limit = Math.max(arg_3, 0);
            if (!isModelTransformation(arg_2, this.model)) {
                throw new Error(
                    `Invalid argument passed to ${this.engine.name} .findAndMap(...) method: arg_2`
                );
            }
            transformation = arg_2;
            if (isModelTransformation(arg_1, this.model)) {
                throw new Error(
                    `Invalid argument passed to ${this.engine.name} .findAndMap(...) method: arg_1`
                );
            }
            lookup = arg_1;
        } else if (!!arg_3 && !!arg_2) {
            if (isModelTransformation(arg_1, this.model)) {
                offset = Math.max(arg_3, 0);
                if (isModelTransformation(arg_2, this.model)) {
                    throw new Error(
                        `Invalid argument passed to ${this.engine.name} .findAndMap(...) method: arg_2`
                    );
                }
                limit = Math.max(arg_2, 0);
                transformation = arg_1;
            } else {
                limit = Math.max(arg_3, 0);
                if (!isModelTransformation(arg_2, this.model)) {
                    throw new Error(
                        `Invalid argument passed to ${this.engine.name} .findAndMap(...) method: arg_2`
                    );
                }
                transformation = arg_2;
                if (isModelTransformation(arg_1, this.model)) {
                    throw new Error(
                        `Invalid argument passed to ${this.engine.name} .findAndMap(...) method: arg_1`
                    );
                }
                lookup = arg_1;
            }
        } else if (!!arg_2) {
            if (isModelTransformation(arg_1, this.model)) {
                if (isModelTransformation(arg_2, this.model)) {
                    throw new Error(
                        `Invalid argument passed to ${this.engine.name} .findAndMap(...) method: arg_2`
                    );
                }
                limit = Math.max(arg_2, 0);
                transformation = arg_1;
            } else {
                if (!isModelTransformation(arg_2, this.model)) {
                    throw new Error(
                        `Invalid argument passed to ${this.engine.name} .findAndMap(...) method: arg_2`
                    );
                }
                transformation = arg_2;
                lookup = arg_1;
            }
        } else {
            if (!isModelTransformation(arg_1, this.model)) {
                throw new Error(
                    `Invalid argument passed to ${this.engine.name} .findAndMap(...) method: arg_1`
                );
            }
            transformation = arg_1;
        }

        const transform = async (models: Array<Model> | undefined) => {
            if (!models) return;

            return Promise.all(
                models.map((model) => this.limiter(async () => transformation(model)))
            );
        };

        if (!lookup) {
            const models = limit ? await this.find(limit, offset) : await this.find();
            return transform(models);
        } else if (isDeepPartial(lookup, this.schema)) {
            const models = limit ? await this.find(lookup, limit, offset) : await this.find(lookup);
            return transform(models);
        } else {
            const models = limit ? await this.find(lookup, limit, offset) : await this.find(lookup);
            return transform(models);
        }
    }

    async reset<T extends GeneralError | ParseErrors<Schema>>(
        fallback: Map<number, Doc<Schema>>,
        failure: Failure<T>
    ): Promise<Failure<T>> {
        await this.concurrent(fallback.keys(), async (id) =>
            this.lock(id).runExclusive(async () => {
                const cached = fallback.get(id);
                if (cached) this.data.set(id, cached);
            })
        );
        return failure;
    }

    async save<T>(fallback: Map<number, Doc<Schema>>, data: T): Promise<Failure | Return<T>> {
        const write = await this.write();
        if (!write.success) {
            return this.reset(fallback, write);
        }

        return { success: true, data };
    }

    async findAndUpdate(
        params: PartialSchema<Schema>,
        update: ModelUpdate<Schema, Model>
    ): Promise<Failure<GeneralError | ParseErrors<Schema>> | Return<Array<Model>>>;
    async findAndUpdate(
        predicate: SchemaPredicate<Schema>,
        update: ModelUpdate<Schema, Model>
    ): Promise<Failure<GeneralError | ParseErrors<Schema>> | Return<Array<Model>>>;
    async findAndUpdate(
        lookup: Lookup<Schema>,
        update: ModelUpdate<Schema, Model>
    ): Promise<Failure<GeneralError | ParseErrors<Schema>> | Return<Array<Model>>> {
        if (!(await this.isReady())) return this.notReadyFailure();

        let partial: PartialSchema<Schema>;
        if (typeof update === "object") {
            const parsed = await this.schema.partial().safeParseAsync(update);
            if (!parsed.success) {
                return this.schemaFailure(parsed);
            }

            partial = parsed.data as PartialSchema<Schema>;
        }

        let errors: Failure<ParseErrors<Schema>> | undefined = undefined;
        const cache = new Map<number, Doc<Schema>>();
        const matches: Array<Model> = [];

        const match = async (ids: Iterable<number>) => {
            await this.concurrent(ids, async (id) => {
                if (errors) return;

                return this.lock(id).runExclusive(async () => {
                    if (errors) return;

                    const record = this.data.get(id);
                    if (!record) return;

                    let matched: boolean = false;
                    if (isDeepPartial(lookup, this.schema)) {
                        matched = await isDeepMatch(record, lookup);
                    } else {
                        matched = await lookup(record, id);
                    }

                    if (!match) return;

                    let updated: Doc<Schema>;
                    if (isModelUpdateFunction(update, this.model)) {
                        const model = new this.model(record, id);
                        const change = await update(model);

                        const parsed = await this.schema.safeParseAsync(change);
                        if (!parsed.success) {
                            errors = this.schemaFailure(parsed);
                            return;
                        }
                        updated = parsed.data;
                    } else {
                        updated = { ...record, ...partial };
                    }

                    errors = await this.checkUniques(this.data, updated, id);
                    if (errors) return;

                    cache.set(id, record);
                    this.data.set(id, updated);
                    matches.push(new this.model(updated, id));
                });
            });
        };

        const result = async (ids: Iterable<number>) => {
            await match(ids);
            if (errors) return this.reset(cache, errors);
            if (matches.length === 0) return this.noMatchFailure();

            return this.save(cache, matches);
        };

        if (isDeepPartial(lookup, this.schema)) {
            const indexed = this.isIndexed(lookup);
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const ids = this.indexIDs(lookup, key);
                    if (!ids) continue;

                    if (this.uniques.has(key)) return result(ids);

                    await match(ids);
                    if (errors) return this.reset(cache, errors);
                    if (matches.length === 0) continue;

                    return this.save(cache, matches);
                }
            }
        }

        return result(this.data.keys());
    }

    async findAndDelete(params: PartialSchema<Schema>): Promise<Failure | Return<Array<Model>>>;
    async findAndDelete(
        predicate: SchemaPredicate<Schema>
    ): Promise<Failure | Return<Array<Model>>>;
    async findAndDelete(lookup: Lookup<Schema>): Promise<Failure | Return<Array<Model>>> {
        if (!(await this.isReady())) return this.notReadyFailure();

        const cache = new Map<number, Doc<Schema>>();
        const matches: Array<Model> = [];

        const match = async (ids: Iterable<number>) => {
            await this.concurrent(ids, async (id) =>
                this.lock(id).runExclusive(async () => {
                    const record = this.data.get(id);
                    if (!record) return;

                    let matched: boolean = false;
                    if (isDeepPartial(lookup, this.schema)) {
                        matched = await isDeepMatch(record, lookup);
                    } else {
                        matched = await lookup(record, id);
                    }
                    if (!matched) return;

                    cache.set(id, record);
                    this.data.delete(id);
                    matches.push(new this.model(record, id));
                })
            );
        };

        const result = async (ids: Iterable<number>) => {
            await match(ids);
            if (matches.length === 0) return this.noMatchFailure();

            return this.save(cache, matches);
        };

        if (isDeepPartial(lookup, this.schema)) {
            const indexed = this.isIndexed(lookup);
            if (indexed.size > 0) {
                for (const key of indexed) {
                    const ids = this.indexIDs(lookup, key);
                    if (!ids) continue;

                    if (this.uniques.has(key)) return result(ids);

                    await match(ids);
                    if (matches.length === 0) continue;

                    return this.save(cache, matches);
                }
            }
        }

        return result(this.data.keys());
    }

    async create(
        record: z.core.input<Schema>
    ): Promise<Failure<GeneralError | ParseErrors<Schema>> | Return<Model>> {
        if (!(await this.isReady())) return this.notReadyFailure();

        const id = this.nextID;
        return this.lock(id).runExclusive(async () => {
            const parsed = await this.schema.safeParseAsync(record);
            if (!parsed.success) return this.schemaFailure(parsed);

            const conflict = await this.checkUniques(this.data, parsed.data, id);
            if (conflict) return conflict;

            this.data.set(id, parsed.data);
            const write = await this.write();
            if (!write.success) {
                this.data.delete(id);
                return write;
            }

            return { success: true, data: new this.model(parsed.data, id) };
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
            const errors: ParseErrors<Schema> = {};
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
