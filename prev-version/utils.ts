// import { existsSync, mkdirSync, writeFileSync, type WriteFileOptions } from "fs";
// import { dirname } from "path";
// import type {
//     DBModel,
//     DBModelProperties,
//     ModelMap,
//     PartialSchema,
//     SchemaPredicate
// } from "./types.js";
// import z from "zod/v4";

// export function ensureDir(directory: string): string {
//     if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
//     return directory;
// }

// export function ensureFile(
//     filepath: string,
//     defaultContent: any,
//     options: WriteFileOptions = { encoding: "utf-8" }
// ): string {
//     if (!existsSync(filepath)) {
//         const directory = dirname(filepath);
//         ensureDir(directory);

//         const content =
//             typeof defaultContent === "object"
//                 ? JSON.stringify(defaultContent, null, 2)
//                 : defaultContent;
//         writeFileSync(filepath, content, options);
//     }
//     return filepath;
// }

// export function isPartialLookup<Schema extends z.ZodObject>(
//     lookup: unknown,
//     schema: Schema
// ): lookup is PartialSchema<Schema> {
//     if (!lookup || typeof lookup !== "object" || Array.isArray(lookup)) return false;

//     const keys = schema.keyof();
//     return Object.keys(lookup).every((key) => keys.safeParse(key).success);
// }

// export function deepMatch(item: any, partial: any): boolean {
//     if (typeof partial !== "object" || partial === null) {
//         if (typeof partial === "string") {
//             return typeof item === "string" ? item.toLowerCase() === partial.toLowerCase() : false;
//         }

//         return item === partial;
//     }

//     if (partial instanceof Date) {
//         return item instanceof Date
//             ? item.getTime() === partial.getTime()
//             : new Date(item).getTime() === partial.getTime();
//     }

//     if (Array.isArray(partial)) {
//         if (!Array.isArray(item)) return false;

//         return partial.every((lookup) => item.some((value) => deepMatch(value, lookup)));
//     }

//     return Object.entries(partial).every(([key, value]) => {
//         return deepMatch(item?.[key], value);
//     });
// }

// export function isSchemaPredicate<
//     Schema extends z.ZodObject,
//     Model extends DBModelProperties<Schema>
// >(func: unknown, model: DBModel<Schema, Model>): func is SchemaPredicate<Schema> {
//     const SchemaPredicateSchema = z.function({
//         input: [z.instanceof(model)],
//         output: z.union([z.boolean(), z.promise(z.boolean())])
//     });
//     return SchemaPredicateSchema.safeParse(func).success;
// }

// export function isModelMapper<
//     Schema extends z.ZodObject,
//     Model extends DBModelProperties<Schema>,
//     T
// >(arg: unknown, model: DBModel<Schema, Model>): arg is ModelMap<Schema, Model, T> {
//     const ModelMatchFunctionSchema = z.function({
//         input: [z.instanceof(model)],
//         output: z.union([z.any(), z.promise(z.any())])
//     });
//     return ModelMatchFunctionSchema.safeParse(arg).success;
// }

// export function isAsync<Args extends Array<any>, T>(
//     func: (...args: Args) => T | Promise<T>
// ): func is (...args: Args) => Promise<T> {
//     return func.constructor.name === "AsyncFunction";
// }

// export function isSync<Args extends Array<any>, T>(
//     func: (...args: Args) => T | Promise<T>
// ): func is (...args: Args) => T {
//     return func.constructor.name !== "AsyncFunction";
// }
