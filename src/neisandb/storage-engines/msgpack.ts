import * as msg from "@msgpack/msgpack";
import * as fs from "fs";
import * as fp from "fs/promises";
import z from "zod/v4";
import {
    DatastoreDataSchema,
    DatastoreSchema,
    type Doc,
    type DSEngine,
    type DSEngineOptions
} from "../../types.js";
import { StorageEngine } from "./abstract.js";

export class MsgPackStorageEngine<Schema extends z.ZodObject> extends StorageEngine<Schema> {
    constructor(params: DSEngineOptions<Schema>) {
        super(params);
        this.ext = ".nsdb";
    }
    write: DSEngine<Schema>["write"] = async (data) => {
        if (!fs.existsSync(this.folder)) {
            await fp.mkdir(this.folder, { recursive: true });
        }

        const temppath = this.temppath;
        const tempfile = await fp.open(temppath, "w");
        try {
            await tempfile.write(msg.encode(data));
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, errors: { general: message } };
        } finally {
            await tempfile.close();
        }

        const folder = await fp.open(this.folder, "r");
        try {
            await folder.sync();
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, errors: { general: message } };
        } finally {
            await folder.close();
        }

        try {
            await fp.rename(temppath, this.path);
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, errors: { general: message } };
        }

        return { success: true };
    };

    read: DSEngine<Schema>["read"] = async () => {
        if (!fs.existsSync(this.path)) {
            const initialize = await this.write(this.empty);
            if (!initialize.success) {
                return initialize;
            }

            return { success: true, data: this.empty };
        }

        const file = await fp.open(this.path, "r");
        try {
            const rawdata = await msg.decodeAsync(file.createReadStream());
            const validData = await DatastoreDataSchema(this.schema).safeParseAsync(rawdata);
            if (!validData.success) {
                const validStructure = await DatastoreSchema.safeParseAsync(rawdata);
                if (!validStructure.success) {
                    return { success: false, errors: { general: "Invalid structure" } };
                }

                const data = new Map<number, Doc<Schema>>();
                await Promise.all(
                    Array.from(validStructure.data.keys()).map((id) =>
                        this.limiter(async () => {
                            const record = validStructure.data.get(id);
                            const parsed = await this.schema.safeParseAsync(record);
                            if (parsed.success) data.set(id, parsed.data);
                        })
                    )
                );
                return { success: true, data };
            }

            return { success: true, data: validData.data };
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, errors: { general: message } };
        } finally {
            await file.close();
        }
    };
}
