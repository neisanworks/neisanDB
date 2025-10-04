import { randomUUID } from "crypto";
import type { LimitFunction } from "p-limit";
import pLimit from "p-limit";
import path from "path";
import z from "zod/v4";
import type { Doc, DSEngine, DSEngineOptions } from "../../types.js";

export abstract class StorageEngine<Schema extends z.ZodObject> implements DSEngine<Schema> {
    protected ext!: string;
    readonly empty = new Map<number, Doc<Schema>>();
    readonly folder: string;
    readonly name: string;
    readonly schema: Schema;
    readonly debug: boolean;
    readonly limiter: LimitFunction = pLimit(5);

    constructor(params: DSEngineOptions<Schema>) {
        this.name = params.name;
        this.folder = `${params.folder}/data`;
        this.schema = params.schema;
        this.debug = params.debug ?? false;
    }

    get path(): string {
        return path.join(this.folder, `${this.name}${this.ext}`);
    }

    get temppath(): string {
        return path.join(this.folder, `${this.name}${randomUUID()}${this.ext}`);
    }

    abstract write: DSEngine<Schema>["write"];
    abstract read: DSEngine<Schema>["read"];
}
