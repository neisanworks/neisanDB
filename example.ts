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
const createAdmin = Users.create({
    email: "admin@gmail.com",
    password: "adminPassword"
});

if (!createAdmin.success) {
    console.log(createAdmin.errors);
} else {
    const admin = createAdmin.data;
    console.log(Users.findOne(admin.id)?.json);
}

const createUser = Users.create({
    email: "user@gmail.com",
    password: "userPassword"
});
if (!createUser.success) {
    console.log(createUser.errors);
} else {
    const user = createUser.data;
    console.log(Users.find({ email: user.email })?.map((user) => user.json));
}

const users = Users.find(({ doc }) => doc.email === "admin@gmail.com");
console.log(users?.map((user) => user.json));
