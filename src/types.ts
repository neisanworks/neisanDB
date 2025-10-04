import type { LimitFunction } from "p-limit";
import * as z from "zod/v4";

// Utility Types
export type Prettier<T extends Record<string | number | symbol, any>> = {
    [K in keyof T]: T[K];
} & {};

export type DeepPartial<T extends Record<string | number | symbol, any>> = {
    [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// Method Return
export type Success = { success: true };
export type Return<T> = { success: true; data: T };
export type Failure<T extends object = GeneralError> = { success: false; errors: T };
export type GeneralError = { general: string };

// Zod Types
export type Doc<Schema extends z.ZodObject> = z.core.output<Schema>;
export type DocWithID<Schema extends z.ZodObject> = Prettier<{ id: number } & Doc<Schema>>;
export type Key<Schema extends z.ZodObject> = keyof z.core.output<Schema>;
export type ParseFailure<Schema extends z.ZodObject> = z.ZodSafeParseError<
    | z.core.output<Schema>
    | z.core.$InferObjectOutput<
          { [k in keyof Schema["shape"]]: z.ZodOptional<Schema["shape"][k]> },
          {}
      >
>;
export type ParseErrors<Schema extends z.ZodObject> = Partial<Record<Key<Schema>, string>>;
export type PartialSchema<Schema extends z.ZodObject> = DeepPartial<z.core.output<Schema>>;

// Database Types
export interface DBOptions {
    folder?: string;
    autoload?: boolean;
    concurrencyLimit?: number;
}

// Datastore Types
export type SchemaPredicate<Schema extends z.ZodObject> = (
    record: z.core.output<Schema>,
    id: number
) => Promise<boolean>;
export type Lookup<Schema extends z.ZodObject> = PartialSchema<Schema> | SchemaPredicate<Schema>;
export type ModelTransformation<
    Schema extends z.ZodObject,
    Model extends DBModelProperties<Schema>,
    T
> = (model: Model) => Promise<T>;
export type ModelUpdateFunction<
    Schema extends z.ZodObject,
    Model extends DBModelProperties<Schema>
> = (model: Model) => Promise<Model>;
export type ModelUpdate<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>> =
    | PartialSchema<Schema>
    | ModelUpdateFunction<Schema, Model>;

// Database Model Types
export type DBModelProperties<Schema extends z.ZodObject> = {
    id: number;
} & z.infer<Schema>;
export type DBModel<Schema extends z.ZodObject, Model extends DBModelProperties<Schema>> = new (
    data: z.core.output<Schema>,
    id: number
) => Model;

// Datastore Storage Engine Types
export interface DSEngineOptions<Schema extends z.ZodObject> {
    folder: string;
    name: string;
    schema: Schema;
    debug?: boolean;
}
export interface DSEngine<Schema extends z.ZodObject> extends Readonly<DSEngineOptions<Schema>> {
    readonly path: string;
    readonly limiter: LimitFunction;
    write(data: Map<number, Doc<Schema>>): Promise<Failure | Success>;
    read(): Promise<Failure | Return<Map<number, Doc<Schema>>>>;
}

// Data File Types
export const DatastoreDataSchema = <Schema extends z.ZodObject>(schema: Schema) => {
    return z.map(z.number(), schema);
};
export const DatastoreSchema = z.map(z.number(), z.object());
