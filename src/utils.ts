import z from "zod/v4";
import type {
    DBModel,
    DBModelProperties,
    DeepPartial,
    ModelTransformation,
    ModelUpdateFunction,
    SchemaPredicate
} from "./types.js";

// Deep Partial
function unwrappedSchema(schema: z.ZodType, forced?: boolean) {
    if (schema instanceof z.ZodArray && !forced) return schema;

    while ("unwrap" in schema && typeof schema.unwrap === "function") {
        schema = schema.unwrap();
    }
    return schema;
}

function deepKeyMatch(item: unknown, schema: z.ZodType): boolean {
    const rawschema = unwrappedSchema(schema);
    if (rawschema instanceof z.ZodObject) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            return false;
        }

        const shape = rawschema.shape;
        return Object.entries(item).every(([key, value]) => {
            if (!(key in shape)) return false;
            if (!deepKeyMatch(value, shape[key])) return false;

            return true;
        });
    } else if (rawschema instanceof z.ZodArray) {
        if (item && !Array.isArray(item)) return false;
    }
    return true;
}

export function isDeepPartial<Schema extends z.ZodObject>(
    item: unknown,
    schema: Schema
): item is DeepPartial<z.core.output<Schema>> {
    return deepKeyMatch(item, schema);
}

export const isDeepMatch = async (full: unknown, partial: unknown): Promise<boolean> => {
    if (full === partial) return true;

    if (partial instanceof Date) {
        if (typeof full !== "string" && typeof full !== "number" && !(full instanceof Date)) {
            return false;
        }
        return new Date(full).getTime() === partial.getTime();
    } else if (full instanceof Date) {
        if (
            typeof partial !== "string" &&
            typeof partial !== "number" &&
            !(partial instanceof Date)
        ) {
            return false;
        }
        return new Date(partial).getTime() === full.getTime();
    }

    if (typeof full === "object" && typeof partial === "object") {
        // If either are null and did not pass full === partial, they fail
        if (full === null || partial === null) return false;

        if (Array.isArray(partial)) {
            if (!Array.isArray(full)) return false;
            // If array contains symbols or constructs, they can't be verified and fails
            // The item doesn't have to be in the same index; it just needs to be present
            const fullSet = new Set(full);
            return partial.every((item) => fullSet.has(item));
        }

        for (const [key, value] of Object.entries(partial)) {
            if (!(key in full)) return false;
            const match = await isDeepMatch((full as Record<string, unknown>)[key], value);
            if (!match) return false;
        }
        return true;
    }

    return false;
};

// Model Transformation
const ModelTransformationSchema = <
    Schema extends z.ZodObject,
    Model extends DBModelProperties<Schema>
>(
    model: DBModel<Schema, Model>
) => {
    return z.function({
        input: [z.instanceof(model)],
        output: z.promise(z.any())
    });
};
export function isModelTransformation<
    Schema extends z.ZodObject,
    Model extends DBModelProperties<Schema>,
    T
>(func: unknown, model: DBModel<Schema, Model>): func is ModelTransformation<Schema, Model, T> {
    return ModelTransformationSchema(model).safeParse(func).success;
}

// Schema Predicate
const SchemaPredicateSchema = <Schema extends z.ZodObject>(schema: Schema) => {
    return z.function({
        input: [schema, z.number()],
        output: z.promise(z.boolean())
    });
};
export function isSchemaPredicate<Schema extends z.ZodObject>(
    item: unknown,
    schema: Schema
): item is SchemaPredicate<Schema> {
    return SchemaPredicateSchema(schema).safeParse(item).success;
}

// Model Update
const ModelUpdateFunctionSchema = <
    Schema extends z.ZodObject,
    Model extends DBModelProperties<Schema>
>(
    model: DBModel<Schema, Model>
) => {
    return z.function({
        input: [z.instanceof(model)],
        output: z.promise(z.instanceof(model))
    });
};
export function isModelUpdateFunction<
    Schema extends z.ZodObject,
    Model extends DBModelProperties<Schema>
>(func: unknown, model: DBModel<Schema, Model>): func is ModelUpdateFunction<Schema, Model> {
    return ModelUpdateFunctionSchema(model).safeParse(func).success;
}

// Data File Schema
export const DatastoreDataSchema = <Schema extends z.ZodObject>(schema: Schema) => {
    return z.map(z.number(), schema);
};

export const DatastoreSchema = z.map(z.number(), z.object());
