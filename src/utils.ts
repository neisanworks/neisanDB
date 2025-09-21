import { existsSync, mkdirSync, writeFileSync, type WriteFileOptions } from "fs";
import { dirname } from "path";

export function ensureDir(directory: string): string {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    return directory;
}

export function ensureFile(
    filepath: string,
    defaultContent: any,
    options: WriteFileOptions = { encoding: "utf-8" }
): string {
    if (!existsSync(filepath)) {
        const directory = dirname(filepath);
        ensureDir(directory);

        const content =
            typeof defaultContent === "object"
                ? JSON.stringify(defaultContent, null, 2)
                : defaultContent;
        writeFileSync(filepath, content, options);
    }
    return filepath;
}

export function deepMatch(item: any, partial: any): boolean {
    if (typeof partial !== "object" || partial === null) {
        if (typeof partial === "string") {
            return typeof item === "string" ? item.toLowerCase() === partial.toLowerCase() : false;
        }

        return item === partial;
    }

    if (partial instanceof Date) {
        return item instanceof Date
            ? item.getTime() === partial.getTime()
            : new Date(item).getTime() === partial.getTime();
    }

    if (Array.isArray(partial)) {
        if (!Array.isArray(item)) return false;

        return partial.every((lookup) => item.some((value) => deepMatch(value, lookup)));
    }

    return Object.entries(partial).every(([key, value]) => {
        return deepMatch(item?.[key], value);
    });
}
