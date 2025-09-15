import * as pt from "path";
import * as fs from "fs";
import z from "zod";
import type {
    DatabaseClass,
    DatastoreClass,
    DBModel,
    DBModelProperties,
    DBOptions,
    DSOptions,
    MethodFailure,
    MethodReturn,
    MethodSuccess
} from "../types";

export class Database implements DatabaseClass {
    folder: string;
    autoload: boolean;

    constructor(params: DBOptions) {
        this.folder = params.folder ?? pt.join(process.cwd(), "neisandb");
        this.autoload = params.autoload ?? true;

        if (!fs.existsSync(this.folder)) {
            fs.mkdirSync(this.folder, { recursive: true });
        }
    }

    collection<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>>(
        options: DSOptions<Schema, Model>
    ): DatastoreClass<Schema, Model> {
        return new Datastore(this, options);
    }
}

class Datastore<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>>
    implements DatastoreClass<Schema, Model>
{
    readonly path: string;
    private data: Record<number, z.infer<Schema>> = {};

    autoload: boolean;
    readonly name: string;
    readonly schema: Schema;
    readonly model: DBModel<Schema, Model>;

    readonly uniques: Array<keyof z.infer<Schema>>;

    constructor(database: Database, params: DSOptions<Schema, Model>) {
        this.autoload = params.autoload ?? database.autoload;
        this.name = params.name;
        this.schema = params.schema;
        this.model = params.model;
        this.uniques = params.uniques ?? [];

        this.path = pt.join(database.folder, `${this.name}.json`);
        if (!fs.existsSync(this.path)) {
            fs.writeFileSync(this.path, JSON.stringify({}), { encoding: "utf-8" });
        }

        if (this.autoload) {
            const fileread = this.read();
            if (!fileread.success) {
                throw new Error(fileread.errors.general);
            }
            this.data = fileread.data;
        }
    }

    findOne(id: number): Model | null;
    findOne(params: Partial<z.infer<Schema>>): Model | null;
    findOne(filter: (entries: [id: number, doc: z.infer<Schema>]) => boolean): Model | null;
    findOne(
        lookup:
            | number
            | Partial<z.infer<Schema>>
            | ((entries: [id: number, doc: z.infer<Schema>]) => boolean)
    ): Model | null {
        if (typeof lookup === "number") {
            return this.data[lookup] ? new this.model(this.data[lookup], lookup) : null;
        } else if (typeof lookup === "function") {
            const results = Object.entries(this.data)
                .filter(([id, record]) => lookup([Number(id), record]))
                .sort(([a], [b]) => Number(a) - Number(b));
            return results.length > 0 ? new this.model(results[0][1], Number(results[0][0])) : null;
        } else {
            const results = Object.entries(this.data)
                .filter(([id, record]) => {
                    for (const param in lookup) {
                        if (record[param] !== lookup[param]) {
                            return false;
                        }
                    }
                    return true;
                })
                .sort(([a], [b]) => Number(a) - Number(b));
            return results.length > 0 ? new this.model(results[0][1], Number(results[0][0])) : null;
        }
    }

    findOneAndUpdate(
        id: number,
        update: Partial<z.infer<Schema>>
    ): MethodFailure | MethodReturn<Model> {
        if (!this.data[id]) {
            return { success: false, errors: { general: "Record ID Does Not Exist" } };
        }

        const parse = this.schema.safeParse(update);
        if (!parse.success) {
            const errors: Partial<Record<keyof z.infer<Schema>, string>> = {};
            z.treeifyError(
                parse.error,
                (issue) => (errors[issue.path[0] as keyof z.infer<Schema>] = issue.message)
            );
            return { success: false, errors };
        }

        const olddata = this.data;
        this.data[id] = { ...this.data[id], ...parse.data };
        const filewrite = this.write();
        if (!filewrite.success) {
            this.data = olddata;
            return filewrite;
        }

        return { success: true, data: new this.model(this.data[id], id) };
    }

    findOneAndDelete(id: number): MethodFailure | MethodReturn<Model> {
        if (!this.data[id]) {
            return { success: false, errors: { general: "Record ID Does Not Exist" } };
        }

        const olddata = this.data;
        const data = this.data[id];
        delete this.data[id];
        const filewrite = this.write();
        if (!filewrite.success) {
            this.data = olddata;
            return filewrite;
        }

        return { success: true, data: new this.model(data, id) };
    }

    find(): Array<Model> | null;
    find(params: Partial<z.infer<Schema>>): Array<Model> | null;
    find(params: Partial<z.infer<Schema>>, limit: number): Array<Model> | null;
    find(filter: (entries: [id: number, doc: z.infer<Schema>]) => boolean): Array<Model> | null;
    find(
        filter: (entries: [id: number, doc: z.infer<Schema>]) => boolean,
        limit: number
    ): Array<Model> | null;
    find(
        lookup?:
            | Partial<z.infer<Schema>>
            | ((entries: [id: number, doc: z.infer<Schema>]) => boolean),
        limit?: number
    ): Array<Model> | null {
        if (Object.keys(this.data).length < 1) return null;

        if (!lookup) {
            return Object.entries(this.data).map(
                ([id, record]) => new this.model(record, Number(id))
            );
        }

        if (typeof lookup === "function") {
            const results = Object.entries(this.data)
                .filter(([id, record]) => lookup([Number(id), record]))
                .sort(([a], [b]) => Number(a) - Number(b));
            const limited = results.slice(0, Math.min(limit ?? Infinity, results.length));
            return limited.length > 0
                ? limited.map(([id, record]) => new this.model(record, Number(id)))
                : null;
        }

        const results = Object.entries(this.data)
            .filter(([id, record]) => {
                for (const param in lookup) {
                    if (record[param] !== lookup[param]) {
                        return false;
                    }
                }
                return true;
            })
            .sort(([a], [b]) => Number(a) - Number(b));
        const limited = results.slice(0, Math.min(limit ?? Infinity, results.length));
        return limited.length > 0
            ? limited.map(([id, record]) => new this.model(record, Number(id)))
            : null;
    }

    findAndUpdate(
        params: Partial<z.infer<Schema>>,
        update: Partial<z.infer<Schema>>
    ): MethodFailure | MethodReturn<Array<Model>>;
    findAndUpdate(
        filter: (entries: [id: number, doc: z.infer<Schema>]) => boolean,
        update: Partial<z.infer<Schema>>
    ): MethodFailure | MethodReturn<Array<Model>>;
    findAndUpdate(
        lookup:
            | Partial<z.infer<Schema>>
            | ((entries: [id: number, doc: z.infer<Schema>]) => boolean),
        update: Partial<z.infer<Schema>>
    ): MethodFailure | MethodReturn<Array<Model>> {
        const results = Object.entries(this.data).filter(([id, record]) => {
            if (typeof lookup === "function") return lookup([Number(id), record]);

            for (const param in lookup) {
                if (record[param] !== lookup[param]) {
                    return false;
                }
            }
            return true;
        });
        if (results.length < 1) {
            return { success: false, errors: { general: "No records found" } };
        }

        const olddata = this.data;
        for (const [id, record] of results) {
            this.data[Number(id)] = { ...record, ...update };
        }
        const filewrite = this.write();
        if (!filewrite.success) {
            this.data = olddata;
            return filewrite;
        }

        return {
            success: true,
            data: results.map(([id, record]) => new this.model(record, Number(id)))
        };
    }

    findAndDelete(params: Partial<z.infer<Schema>>): MethodFailure | MethodReturn<Array<Model>>;
    findAndDelete(
        filter: (entries: [id: number, doc: z.infer<Schema>]) => boolean
    ): MethodFailure | MethodReturn<Array<Model>>;
    findAndDelete(
        lookup:
            | Partial<z.infer<Schema>>
            | ((entries: [id: number, doc: z.infer<Schema>]) => boolean)
    ): MethodFailure | MethodReturn<Array<Model>> {
        const results = Object.entries(this.data).filter(([id, record]) => {
            if (typeof lookup === "function") return lookup([Number(id), record]);

            for (const param in lookup) {
                if (record[param] !== lookup[param]) {
                    return false;
                }
            }
            return true;
        });
        if (results.length < 1) {
            return { success: false, errors: { general: "No records found" } };
        }

        const olddata = this.data;
        for (const [id] of results) {
            delete this.data[Number(id)];
        }
        const filewrite = this.write();
        if (!filewrite.success) {
            this.data = olddata;
            return filewrite;
        }

        return {
            success: true,
            data: results.map(([id, record]) => new this.model(record, Number(id)))
        };
    }

    create(data: z.core.output<Schema>): MethodFailure | MethodReturn<Model> {
        const parsed = this.schema.safeParse(data);
        if (!parsed.success) {
            const errors: Partial<Record<keyof z.infer<Schema>, string>> = {};
            z.treeifyError(
                parsed.error,
                (issue) => (errors[issue.path[0] as keyof z.infer<Schema>] = issue.message)
            );
            return { success: false, errors };
        }

        for (const unique of this.uniques) {
            if (Object.values(this.data).some((record) => record[unique] === parsed.data[unique])) {
                return {
                    success: false,
                    errors: { [unique]: "Already in use" }
                };
            }
        }

        const olddata = this.data;
        const id = this.nextID();
        this.data[id] = parsed.data;

        const filewrite = this.write();
        if (!filewrite.success) {
            this.data = olddata;
            return filewrite;
        }

        return { success: true, data: new this.model(parsed.data, id) };
    }

    save(item: Model): MethodFailure | MethodReturn<Model> {
        const parsed = this.schema.safeParse(item);
        if (!parsed.success) {
            const errors: Partial<Record<keyof z.infer<Schema>, string>> = {};
            z.treeifyError(
                parsed.error,
                (issue) => (errors[issue.path[0] as keyof z.infer<Schema>] = issue.message)
            );
            return { success: false, errors };
        }

        for (const unique of this.uniques) {
            if (
                Object.entries(this.data).some(
                    ([id, record]) =>
                        record[unique] === parsed.data[unique] && Number(id) !== item.id
                )
            ) {
                return {
                    success: false,
                    errors: { [unique]: "Already in use" }
                };
            }
        }

        const olddata = this.data;
        this.data[item.id] = parsed.data;

        const filewrite = this.write();
        if (!filewrite.success) {
            this.data = olddata;
            return filewrite;
        }

        return { success: true, data: new this.model(parsed.data, item.id) };
    }

    private read(): MethodFailure | MethodReturn<Record<number, z.infer<Schema>>> {
        try {
            return {
                success: true,
                data: JSON.parse(fs.readFileSync(this.path, { encoding: "utf-8" }))
            };
        } catch {
            return { success: false, errors: { general: "Could not read file" } };
        }
    }

    private write(): MethodFailure | MethodSuccess {
        try {
            fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), { encoding: "utf-8" });
            return { success: true };
        } catch {
            return { success: false, errors: { general: "Could not write to file" } };
        }
    }

    private nextID(): number {
        const keys = Object.keys(this.data).map(Number);
        return keys.length ? Math.max(...keys) + 1 : 0;
    }
}
