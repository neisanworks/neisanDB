import { existsSync, mkdirSync, writeFileSync, type WriteFileOptions } from "fs";

/**
 * Ensures a directory exists at the given path, creating the directory if it does not exist.
 * Recursively creates all parent directories if they do not exist.
 * @param directory The path to the directory
 * @returns The path to the directory
 */
export function ensureDir(directory: string): string {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    return directory;
}

/**
 * Ensures a file exists at the given filepath, creating the file if it does not exist.
 * If the file does not exist, the directory path to the file is also ensured.
 * The defaultContent is written to the file with the given options.
 * @param filepath The path to the file
 * @param defaultContent The content to write to the file if it does not exist
 * @param options The options to use when writing the file
 * @returns The filepath
 */
export function ensureFile(
    filepath: string,
    defaultContent: any,
    options: WriteFileOptions = { encoding: "utf-8" }
): string {
    if (!existsSync(filepath)) {
        const directory = filepath.split("/").slice(0, -1).join("/");
        ensureDir(directory);
        writeFileSync(filepath, defaultContent, options);
    }
    return filepath;
}
