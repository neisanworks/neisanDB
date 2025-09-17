import z from "zod/v4";
import type { DBModelProperties } from "./src/types";
import { Database } from "./src/neisandb/database";

const db = new Database({ autoload: true });

const UserSchema = z.object({
    email: z.string(),
    password: z.string(),
    attempts: z.number()
});
type UserSchema = typeof UserSchema;

class UserModel implements DBModelProperties<UserSchema> {
    id: number;
    email: string;
    password: string;
    attempts: number;

    constructor(data: z.infer<UserSchema>, id: number) {
        this.id = id;
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
    uniques: ["email"]
});
const createAdmin = Users.create({
    email: "emmanuel.n.bynum@gmail.com",
    password: "swagg.101",
    attempts: 0
});
if (!createAdmin.success) {
    console.log(createAdmin.errors);
} else {
    const admin = createAdmin.data;
    console.log(Users.findOne(admin.id));
}

const createUser = Users.create({
    email: "emmanuel.n.bynum@gmail.com",
    password: "swagg.101",
    attempts: 0
});
if (!createUser.success) {
    console.log(createUser.errors);
} else {
    const user = createUser.data;
    console.log(Users.findOne(user.id));
}

const users = Users.find(({ doc }) => doc.email === "emmanuel.n.bynum@gmail.com");
console.log(users);
