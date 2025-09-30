import * as z from "zod/v4";

// Utility Types
export type Prettier<T extends Record<string | number | symbol, any>> = {
    [K in keyof T]: T[K];
} & {};
export type DeepPartial<T extends Record<string | number | symbol, any>> = {
    [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// Zod Types
export type ParseFailure<Schema extends z.ZodObject> = z.ZodSafeParseError<
    | z.core.output<Schema>
    | z.core.$InferObjectOutput<
          { [k in keyof Schema["shape"]]: z.ZodOptional<Schema["shape"][k]> },
          {}
      >
>;
export type Doc<Schema extends z.ZodObject> = z.core.output<Schema>;
export type DocWithID<Schema extends z.ZodObject> = Prettier<{ id: number } & Doc<Schema>>;
export type SchemaKey<Schema extends z.ZodObject> = keyof z.core.output<Schema>;

// Method Return Types
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
    uniques?: Array<keyof z.core.output<Schema>>;
    indexes?: Array<keyof z.core.output<Schema>>;
    concurrencyLimit?: number;
}
export type PartialSchema<Schema extends z.ZodObject> = DeepPartial<z.core.output<Schema>>;
export type SchemaPredicate<Schema extends z.ZodObject> = (
    record: z.core.output<Schema>,
    id: number
) => boolean | Promise<boolean>;
export type SyncSchemaPredicate<Schema extends z.ZodObject> = (
    record: z.core.output<Schema>,
    id: number
) => boolean;
export type Lookup<Schema extends z.ZodObject> = PartialSchema<Schema> | SchemaPredicate<Schema>;
export type SyncLookup<Schema extends z.ZodObject> =
    | PartialSchema<Schema>
    | SyncSchemaPredicate<Schema>;
export type RecordUpdate<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>> =
    | PartialSchema<Schema>
    | ((model: Model) => Model);

export type ModelMap<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>, T> = (
    model: Model
) => T | Promise<T>;

// Database Model Types
export type DBModelProperties<Schema extends z.ZodObject> = {
    id: number;
} & z.infer<Schema>;
export type DBModel<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>> = new (
    data: z.core.output<Schema>,
    id: number
) => Model;
