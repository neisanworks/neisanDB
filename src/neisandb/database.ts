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

    find(): Array<Model> | null;
    find(id: number): Model | null;
    find(params: Partial<z.infer<Schema>>): Array<Model> | null;
    find(params: Partial<z.infer<Schema>>, limit: 1): Model | null;
    find(params: Partial<z.infer<Schema>>, limit: number): Array<Model> | null;
    find(params?: number | Partial<z.infer<Schema>>, limit?: number): Array<Model> | Model | null {
        if (!params) {
            return Object.entries(this.data).map(
                ([id, record]) => new this.model(record, Number(id))
            );
        }

        if (typeof params === "number") {
            return this.data[params] ? new this.model(this.data[params], params) : null;
        }

        const filtered = Object.entries(this.data).filter(([, record]) => {
            for (const param in params) {
                if (record[param] !== params[param]) {
                    return false;
                }
            }
            return true;
        });
        const limited = filtered.map(([id, record]) => new this.model(record, Number(id)));
        if (limited.length < 1) return null;

        if (limit === 1) {
            return limited.at(0) ?? null;
        }

        return limited.slice(0, Math.min(limit ?? Infinity, limited.length));
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

        const id = this.nextID();
        this.data[id] = parsed.data;

        const filewrite = this.write();
        if (!filewrite.success) return filewrite;

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
            if (Object.values(this.data).some((record) => record[unique] === parsed.data[unique] && record.id !== item.id)) {
                return {
                    success: false,
                    errors: { [unique]: 'Already in use' }
                };
            }
        }

        this.data[item.id] = parsed.data;

        const filewrite = this.write();
        if (!filewrite.success) return filewrite;

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
