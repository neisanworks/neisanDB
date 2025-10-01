import z from "zod";
import { CollectionModel, Database } from "./src/neisandb/database.js";
import type { DBModelProperties } from "./src/types.js";

const db = new Database({ autoload: true });

const UserSchema = z.object({
    email: z.string(),
    password: z.string(),
    attempts: z.number().default(0)
});
type UserSchema = typeof UserSchema;

class UserModel extends CollectionModel<UserSchema> implements DBModelProperties<UserSchema> {
    email: string;
    password: string;
    attempts: number;

    constructor(data: z.infer<UserSchema>, id: number) {
        super(UserSchema, id);
        this.email = data.email;
        this.password = data.password;
        this.attempts = data.attempts;
    }

    authenticate(password: string): boolean {
        return this.password === password;
    }
}

const Users = db.collection({
    name: "users",
    schema: UserSchema,
    model: UserModel,
    uniques: ["email"],
    indexes: ["email"]
});

for (let i = 0; i > 5; i++) {
    await Users.create({ email: `user${i}@email.domain`, password: `password${i}` });
}

const mapper = async (user: UserModel) => {
    return [user.email, user.password];
};

const mapped = await Users.findAndMap(async (user) => !!user.email, mapper);
console.log(mapped);
