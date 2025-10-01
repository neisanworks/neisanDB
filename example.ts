import z from "zod";
import { CollectionModel, Database } from "./src/neisandb/database.js";
import type { DBModelProperties } from "./src/types.js";

const db = new Database({
    folder: "~/src/lib/server/neisandb",
    autoload: true, // controls when to load data from file; default to true; set to false to lazy-load
    concurrencyLimit: 25 // shared across all collections; default to max of 10 concurrent processes
});

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

    get locked(): boolean {
        return this.attempts >= 3;
    }

    authenticate(password: string): boolean {
        return this.password === password;
    }
}

const ProfileSchema = z.object({
    userID: z.coerce.number().positive(),
    last: z.string(),
    first: z.string(),
    middle: z.string().optional(),
    email: z.email(),
    phone: z.coerce.string()
});
type ProfileSchema = typeof ProfileSchema;

class ProfileModel
    extends CollectionModel<ProfileSchema>
    implements DBModelProperties<ProfileSchema>
{
    userID: number;
    last: string;
    first: string;
    middle?: string;
    email: string;
    phone: string;

    constructor(data: z.infer<ProfileSchema>, id: number) {
        super(ProfileSchema, id);
        this.userID = data.userID;
        this.last = data.last;
        this.first = data.first;
        this.middle = data.middle;
        this.email = data.email;
        this.phone = data.phone;
    }
}

const Users = db.collection({
    name: "users",
    schema: UserSchema,
    model: UserModel,
    uniques: ["email"],
    indexes: ["email"]
});

const Profiles = db.collection({
    name: "profiles",
    schema: ProfileSchema,
    model: ProfileModel,
    uniques: ["email", "phone", "userID"],
    indexes: ["email", "phone", "userID"]
});

for (let i = 0; i > 5; i++) {
    await Users.create({ email: `user${i}@email.domain`, password: `password${i}` });
}

const mapped = await Users.findAndMap(
    async (user, id) => {
        if (!(await Profiles.exists({ userID: id }))) return false;

        return true;
    },
    async (user) => {
        return [user.email, user.password];
    }
);
console.log(mapped);
