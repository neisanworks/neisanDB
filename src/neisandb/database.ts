import {
    closeSync,
    fsyncSync,
    openSync,
    readFileSync,
    renameSync,
    writeFileSync,
    writeSync
} from "fs";
import { dirname, join } from "path";
import z from "zod";
import type {
    DBOptions,
    DBModelProperties,
    DSOptions,
    DBModel,
    MethodFailure,
    MethodSuccess,
    PartialSchema,
    FilterLookup,
    SchemaErrors,
    MethodReturn,
    Prettier
} from "../types.js";
import { deepMatch, ensureDir, ensureFile, isPartialLookup } from "../utils.js";

export class Database {
    folder: string;
    autoload: boolean;

    constructor(params: DBOptions) {
        this.folder = ensureDir(params.folder ?? join(process.cwd(), "neisandb"));
        this.autoload = params.autoload ?? true;
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
    private data: Record<number, z.core.output<Schema>> = {};

    readonly name: string;
    readonly path: string;
    readonly autoload: boolean;

    readonly schema: Schema;
    readonly shape: Shape;
    readonly model: DBModel<Schema, Model>;

    readonly uniques: Array<keyof z.core.output<Schema>>;
    private readonly indexes: Array<keyof z.core.output<Schema>>;
    private index = new Map<keyof z.core.output<Schema>, Map<any, Array<number>>>();

    private read(): MethodFailure | MethodSuccess {
        try {
            this.data = JSON.parse(readFileSync(this.path, { encoding: "utf-8" }) ?? "{}");
            this.buildIndex();
            return { success: true };
        } catch {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }
    }

    private buildIndex(): void {
        this.index.clear();

        this.indexes.forEach((key) => {
            const map = new Map<any, Array<number>>();
            Object.entries(this.data).forEach(([id, doc]) => {
                const value = doc[key];
                map.set(value, [...(map.get(value) ?? []), Number(id)]);
            });

            this.index.set(key, map);
        });
    }

    private write(): MethodFailure | MethodSuccess {
        const folder = dirname(this.path);
        const temppath = join(folder, `${this.name}.${Date.now()}-${Math.random()}.tmp`);
        const file = openSync(temppath, "w");

        try {
            writeSync(file, JSON.stringify(this.data, null, 2));
            fsyncSync(file);
        } catch {
            return { success: false, errors: { general: "Failed to write datastore file" } };
        } finally {
            closeSync(file);
        }

        renameSync(temppath, this.path);

        const directory = openSync(folder, "r");
        try {
            fsyncSync(directory);
        } catch {
            return { success: false, errors: { general: "Failed to sync directory" } };
        } finally {
            closeSync(directory);
        }

        this.buildIndex();

        return { success: true };
    }

    private limited(
        results: Array<[string, z.core.output<Schema>]>,
        limit?: number
    ): Array<Model> | undefined {
        const limited = limit && results.length > limit ? results.slice(0, limit) : results;
        if (limited.length === 0) return;

        return limited.map(([id, record]) => new this.model(record, Number(id)));
    }

    private get ready(): boolean {
        if (Object.keys(this.data).length === 0) {
            const read = this.read();
            if (!read.success) return false;
        }

        return true;
    }

    private get nextID(): number {
        if (!this.ready) return 0;

        const ids = Object.keys(this.data).map(Number);
        return ids.length ? Math.max(...ids) + 1 : 1;
    }

    load() {
        this.read();
        return this.ready;
    }

    constructor(database: Database, params: DSOptions<Schema, Model>) {
        this.name = params.name;
        this.path = ensureFile(join(database.folder, `${this.name}.json`), JSON.stringify({}));
        this.autoload = params.autoload ?? database.autoload;

        this.schema = params.schema;
        this.shape = this.schema.shape;
        this.model = params.model;

        this.uniques = params.uniques ?? [];
        this.indexes = params.indexes ?? [];

        if (this.autoload) this.read();
    }

    findOne(id: number): Model | undefined;
    findOne(params: PartialSchema<Schema>): Model | undefined;
    findOne(filter: FilterLookup<Schema>): Model | undefined;
    findOne(lookup: number | PartialSchema<Schema> | FilterLookup<Schema>): Model | undefined {
        if (!this.ready) return;

        if (typeof lookup === "number") {
            const record = this.data[lookup];
            return record ? new this.model(record, lookup) : undefined;
        }

        if (isPartialLookup(lookup, this.schema)) {
            for (const key of this.index.keys()) {
                if (!Object.hasOwn(lookup, key)) continue;

                const value = lookup[key];
                const matchedIDs = this.index.get(key)!.get(value);
                if (!matchedIDs) continue;

                for (const id of matchedIDs) {
                    const record = this.data[id];
                    if (!record) continue;

                    if (this.uniques.includes(key)) {
                        return new this.model(record, id);
                    }

                    const matches = Object.entries(lookup).every(
                        ([k, v]) => record[k as keyof typeof lookup] === v
                    );
                    if (matches) return new this.model(record, id);
                }
            }
        }

        const results = Object.entries(this.data).filter(([id, doc]) => {
            if (typeof lookup === "function") return lookup({ id: Number(id), doc });

            return deepMatch(doc, lookup);
        });
        const match = results.at(0);

        return match ? new this.model(match[1], Number(match[0])) : undefined;
    }

    findOneAndUpdate(
        id: number,
        update: PartialSchema<Schema>
    ): MethodFailure<Record<"general", string> | SchemaErrors<Schema>> | MethodReturn<Model> {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        if (!this.data[id]) {
            return { success: false, errors: { general: "Document Not Found" } };
        }

        const parse = this.schema.safeParse(update);
        if (!parse.success) {
            const errors: SchemaErrors<Schema> = {};
            z.treeifyError(
                parse.error,
                (issue) => (errors[issue.path[0] as keyof z.infer<Schema>] = issue.message)
            );
            return { success: false, errors };
        }

        const cache = this.data;
        this.data[id] = { ...this.data[id], ...parse.data };
        const write = this.write();
        if (!write.success) {
            this.data = cache;
            return write;
        }

        return { success: true, data: new this.model(this.data[id], id) };
    }

    findOneAndDelete(id: number): MethodFailure | MethodReturn<Model> {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        if (!this.data[id]) {
            return { success: false, errors: { general: "Document Not Found" } };
        }

        const cache = this.data;
        const data = this.data[id];
        delete this.data[id];
        const write = this.write();
        if (!write.success) {
            this.data = cache;
            return write;
        }

        return { success: true, data: new this.model(data, id) };
    }

    find(): Array<Model> | undefined;
    find(params: PartialSchema<Schema>): Array<Model> | undefined;
    find(params: PartialSchema<Schema>, limit: number): Array<Model> | undefined;
    find(filter: FilterLookup<Schema>): Array<Model> | undefined;
    find(filter: FilterLookup<Schema>, limit: number): Array<Model> | undefined;
    find(
        lookup?: PartialSchema<Schema> | FilterLookup<Schema>,
        limit?: number
    ): Array<Model> | undefined {
        if (!this.ready) return;

        if (!lookup) {
            return Object.entries(this.data).map(
                ([id, record]) => new this.model(record, Number(id))
            );
        }

        if (isPartialLookup(lookup, this.schema)) {
            for (const key of this.index.keys()) {
                if (!Object.hasOwn(lookup, key)) continue;

                const value = lookup[key];
                const matchedIDs = this.index.get(key)!.get(value);
                if (!matchedIDs) continue;

                const matches = matchedIDs
                    .map((id) => {
                        const record = this.data[id];
                        if (!record) return;

                        if (this.uniques.includes(key)) {
                            return [String(id), record] as [string, z.core.output<Schema>];
                        }

                        const matches = Object.entries(lookup).every(
                            ([k, v]) => record[k as keyof typeof lookup] === v
                        );
                        if (matches) return [String(id), record] as [string, z.core.output<Schema>];
                    })
                    .filter((item) => item !== undefined);

                if (matches.length > 0) return this.limited(matches);
            }
        }

        const results = Object.entries(this.data).filter(([id, doc]) => {
            if (typeof lookup === "function") return lookup({ id: Number(id), doc });

            return deepMatch(doc, lookup);
        });
        return this.limited(results, limit);
    }

    findAndUpdate(
        params: PartialSchema<Schema>,
        update: PartialSchema<Schema>
    ): MethodFailure<Record<"general", string> | SchemaErrors<Schema>> | MethodReturn<Array<Model>>;
    findAndUpdate(
        filter: FilterLookup<Schema>,
        update: PartialSchema<Schema>
    ): MethodFailure<Record<"general", string> | SchemaErrors<Schema>> | MethodReturn<Array<Model>>;
    findAndUpdate(
        lookup: PartialSchema<Schema> | FilterLookup<Schema>,
        update: PartialSchema<Schema>
    ):
        | MethodFailure<Record<"general", string> | SchemaErrors<Schema>>
        | MethodReturn<Array<Model>> {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        const parse = this.schema.safeParse(update);
        if (!parse.success) {
            const errors: SchemaErrors<Schema> = {};
            z.treeifyError(
                parse.error,
                (issue) => (errors[issue.path[0] as keyof z.infer<Schema>] = issue.message)
            );
            return { success: false, errors };
        }

        if (isPartialLookup(lookup, this.schema)) {
            for (const key of this.index.keys()) {
                if (!Object.hasOwn(lookup, key)) continue;

                const value = lookup[key];
                const matchedIDs = this.index.get(key)!.get(value);
                if (!matchedIDs) continue;

                const matches = matchedIDs
                    .map((id) => {
                        const record = this.data[id];
                        if (!record) return;

                        if (this.uniques.includes(key)) {
                            return [String(id), record] as [string, z.core.output<Schema>];
                        }

                        const matches = Object.entries(lookup).every(
                            ([k, v]) => record[k as keyof typeof lookup] === v
                        );
                        if (matches) return [String(id), record] as [string, z.core.output<Schema>];
                    })
                    .filter((item) => item !== undefined);

                if (matches.length > 0) {
                    const cache = this.data;
                    const updated = matches.map<[id: string, doc: z.infer<Schema>]>(([id, doc]) => [
                        id,
                        { ...doc, ...parse.data }
                    ]);
                    for (const [id, doc] of updated) {
                        this.data[Number(id)] = doc;
                    }
                    const write = this.write();
                    if (!write.success) {
                        this.data = cache;
                        return write;
                    }

                    return {
                        success: true,
                        data: updated.map(([id, doc]) => new this.model(doc, Number(id)))
                    };
                }
            }
        }

        const results = Object.entries(this.data).filter(([id, doc]) => {
            if (typeof lookup === "function") return lookup({ id: Number(id), doc });

            return deepMatch(doc, lookup);
        });

        const cache = this.data;
        const updated = results.map<[id: string, doc: z.infer<Schema>]>(([id, doc]) => [
            id,
            { ...doc, ...parse.data }
        ]);
        for (const [id, doc] of updated) {
            this.data[Number(id)] = doc;
        }
        const write = this.write();
        if (!write.success) {
            this.data = cache;
            return write;
        }

        return { success: true, data: updated.map(([id, doc]) => new this.model(doc, Number(id))) };
    }

    findAndDelete(params: PartialSchema<Schema>): MethodFailure | MethodReturn<Array<Model>>;
    findAndDelete(filter: FilterLookup<Schema>): MethodFailure | MethodReturn<Array<Model>>;
    findAndDelete(
        lookup: PartialSchema<Schema> | FilterLookup<Schema>
    ): MethodFailure | MethodReturn<Array<Model>> {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        if (isPartialLookup(lookup, this.schema)) {
            for (const key of this.index.keys()) {
                if (!Object.hasOwn(lookup, key)) continue;

                const value = lookup[key];
                const matchedIDs = this.index.get(key)!.get(value);
                if (!matchedIDs) continue;

                const matches = matchedIDs
                    .map((id) => {
                        const record = this.data[id];
                        if (!record) return;

                        if (this.uniques.includes(key)) {
                            return [String(id), record] as [string, z.core.output<Schema>];
                        }

                        const matches = Object.entries(lookup).every(
                            ([k, v]) => record[k as keyof typeof lookup] === v
                        );
                        if (matches) return [String(id), record] as [string, z.core.output<Schema>];
                    })
                    .filter((item) => item !== undefined);

                if (matches.length > 0) {
                    const cache = this.data;
                    for (const [id] of matches) {
                        delete this.data[Number(id)];
                    }
                    const write = this.write();
                    if (!write.success) {
                        this.data = cache;
                        return write;
                    }

                    return {
                        success: true,
                        data: matches.map(([id, doc]) => new this.model(doc, Number(id)))
                    };
                }
            }
        }

        const results = Object.entries(this.data).filter(([id, doc]) => {
            if (typeof lookup === "function") return lookup({ id: Number(id), doc });

            return deepMatch(doc, lookup);
        });

        const cache = this.data;
        for (const [id] of results) {
            delete this.data[Number(id)];
        }
        const write = this.write();
        if (!write.success) {
            this.data = cache;
            return write;
        }

        return { success: true, data: results.map(([id, doc]) => new this.model(doc, Number(id))) };
    }

    create(
        doc: z.core.input<Schema>
    ): MethodFailure<Record<"general", string> | SchemaErrors<Schema>> | MethodReturn<Model>;
    create(
        docs: Array<z.core.input<Schema>>
    ): MethodFailure<Record<"general", string> | SchemaErrors<Schema>> | MethodReturn<Array<Model>>;
    create(
        docs: z.core.input<Schema> | Array<z.core.input<Schema>>
    ):
        | MethodFailure<Record<"general", string> | SchemaErrors<Schema>>
        | MethodReturn<Model>
        | MethodReturn<Array<Model>> {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        if (Array.isArray(docs) && docs.length === 0) {
            return { success: false, errors: { general: "No documents provided" } };
        }

        const cache = this.data;
        const created: Array<[number, z.core.output<Schema>]> = [];

        for (const doc of Array.isArray(docs) ? docs : [docs]) {
            const parse = this.schema.safeParse(doc);
            if (!parse.success) {
                const errors: SchemaErrors<Schema> = {};
                z.treeifyError(
                    parse.error,
                    (issue) => (errors[issue.path[0] as keyof z.infer<Schema>] = issue.message)
                );
                return { success: false, errors };
            }

            for (const unique of this.uniques) {
                if (
                    Object.values(this.data).some((record) => record[unique] === parse.data[unique])
                ) {
                    return {
                        success: false,
                        errors: { [unique]: "Already in use" } as SchemaErrors<Schema>
                    };
                }
            }

            const id = this.nextID;
            this.data[id] = parse.data;
            created.push([id, parse.data]);
        }

        if (created.length === 0) {
            return { success: false, errors: { general: "Failed to create document" } };
        }

        const write = this.write();
        if (!write.success) {
            this.data = cache;
            return write;
        }

        const models = created.map(([id, doc]) => new this.model(doc, id));
        if (Array.isArray(docs)) {
            return { success: true, data: models };
        }

        return { success: true, data: models[0] as Model };
    }

    save(
        model: Model
    ): MethodFailure<Record<"general", string> | SchemaErrors<Schema>> | MethodReturn<Model> {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        const parse = this.schema.safeParse(model);
        if (!parse.success) {
            const errors: SchemaErrors<Schema> = {};
            z.treeifyError(
                parse.error,
                (issue) => (errors[issue.path[0] as keyof z.infer<Schema>] = issue.message)
            );
            return { success: false, errors };
        }

        for (const unique of this.uniques) {
            if (
                Object.entries(this.data).some(
                    ([id, record]) =>
                        record[unique] === parse.data[unique] && Number(id) !== model.id
                )
            ) {
                return {
                    success: false,
                    errors: { [unique]: "Already in use" } as SchemaErrors<Schema>
                };
            }
        }

        const cache = this.data;
        this.data[model.id] = parse.data;
        const write = this.write();
        if (!write.success) {
            this.data = cache;
            return write;
        }

        return { success: true, data: new this.model(parse.data, model.id) };
    }

    delete(model: Model): MethodFailure | MethodSuccess {
        if (!this.ready) {
            return {
                success: false,
                errors: { general: `Failed to read datastore file: ${this.path}` }
            };
        }

        const cache = this.data;
        delete this.data[model.id];
        const write = this.write();
        if (!write.success) {
            this.data = cache;
            return write;
        }

        return { success: true };
    }
}

export abstract class CollectionModel<Schema extends z.ZodObject> {
    id: number;
    schema: Schema;

    constructor(schema: Schema, id: number) {
        this.id = id;
        this.schema = schema;
    }

    get json(): Prettier<{ id: number } & z.core.output<Schema>> {
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
