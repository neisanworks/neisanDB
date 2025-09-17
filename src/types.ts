import * as z from "zod/v4";

// Utility Types
export type Prettier<T extends Record<string | number | symbol, any>> = {
    [K in keyof T]: T[K];
} & {};


export type MethodSuccess = { success: true };
export type MethodReturn<Return> = Prettier<MethodSuccess & { data: Return }>;
export type MethodFailure<
    Errors extends Record<string, string | undefined> = Record<"general", string>
> = {
    success: false;
    errors: Errors;
};
export type SchemaErrors<Schema extends z.ZodObject> = Partial<
    Record<keyof z.core.output<Schema>, string>
>;

export type PartialSchema<Schema extends z.ZodObject> = Partial<z.core.output<Schema>>;
export type FilterLookup<Schema extends z.ZodObject> = (record: {
    id: number;
    doc: z.core.output<Schema>;
}) => boolean;


// Database Types
export interface DBOptions {
    folder?: string;
    autoload?: boolean;
}


// Datastore Types
export interface DSOptions<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>> {
    name: string;
    schema: Schema;
    model: DBModel<Schema, Model>;
    autoload?: boolean;
    uniques?: Array<keyof z.infer<Schema>>;
}


// Database Model Types
export type DBModelProperties<Schema extends z.ZodObject> = {
    id: number;
} & z.infer<Schema>;
export type DBModel<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>> = new (
    data: z.core.output<Schema>,
    id: number
) => Model;
