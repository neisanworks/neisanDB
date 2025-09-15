import * as z from "zod/v4";

// Utility Types
export type Prettier<T extends Record<string | number | symbol, any>> = {
    [K in keyof T]: T[K];
} & {};

export type MethodSuccess = { success: true };
export type MethodReturn<Return> = Prettier<MethodSuccess & { data: Return }>;
export type MethodFailure = { success: false; errors: Record<string, any> };

// Database Types
export interface DBProperties {
    folder: string;
    autoload: boolean;
}

export type DBOptions = Partial<DBProperties>;

export type DatabaseClass = Prettier<
    DBProperties & {
        collection<
            Schema extends z.ZodObject,
            Model extends Prettier<{ id: number } & z.infer<Schema>>
        >(
            options: DSOptions<Schema, Model>
        ): DatastoreClass<Schema, Model>;
    }
>;

// Model Types
export type DBModelProperties<Schema extends z.ZodObject> = Prettier<
    { id: number } & z.infer<Schema>
>;
export type DBModel<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>> = new (
    data: z.infer<Schema>,
    id: number
) => Model;

// Datastore Types
export interface DSProperties<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>> {
    name: string;
    schema: Schema;
    model: DBModel<Schema, Model>;
    uniques: Array<keyof z.infer<Schema>>;
    autoload: boolean;
}

export type DSOptions<
    Schema extends z.ZodObject,
    Model extends DBModelProperties<Schema>
> = Prettier<
    Omit<DSProperties<Schema, Model>, "autoload" | "uniques"> &
        Partial<Pick<DSProperties<Schema, Model>, "autoload" | "uniques">>
>;

export type DatastoreClass<
    Schema extends z.ZodObject,
    Model extends DBModelProperties<Schema>
> = Prettier<
    DSProperties<Schema, Model> & {
        // Find One Methods
        findOne(id: number): Model | null;
        findOne(params: Partial<z.infer<Schema>>): Model | null;
        findOne(filter: (entries: [id: number, doc: z.infer<Schema>]) => boolean): Model | null;
        findOneAndUpdate(
            id: number,
            update: Partial<z.infer<Schema>>
        ): MethodFailure | MethodReturn<Model>;
        findOneAndDelete(id: number): MethodFailure | MethodReturn<Model>;

        // Find Many Methods
        find(): Array<Model> | null;
        find(params: Partial<z.infer<Schema>>): Array<Model> | null;
        find(params: Partial<z.infer<Schema>>, limit: number): Array<Model> | null;
        find(filter: (entries: [id: number, doc: z.infer<Schema>]) => boolean): Array<Model> | null;
        find(
            filter: (entries: [id: number, doc: z.infer<Schema>]) => boolean,
            limit: number
        ): Array<Model> | null;
        findAndUpdate(
            params: Partial<z.infer<Schema>>,
            update: Partial<z.infer<Schema>>
        ): MethodFailure | MethodReturn<Array<Model>>;
        findAndUpdate(
            filter: (entries: [id: number, doc: z.infer<Schema>]) => boolean,
            update: Partial<z.infer<Schema>>
        ): MethodFailure | MethodReturn<Array<Model>>;
        findAndDelete(params: Partial<z.infer<Schema>>): MethodFailure | MethodReturn<Array<Model>>;
        findAndDelete(
            filter: (entries: [id: number, doc: z.infer<Schema>]) => boolean
        ): MethodFailure | MethodReturn<Array<Model>>;

        // Create Methods
        create(data: z.infer<Schema>): MethodFailure | MethodReturn<Model>;

        // Save Methods
        save(item: Model): MethodFailure | MethodReturn<Model>;
    }
>;
