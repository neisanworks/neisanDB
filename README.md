# @neisanworks/neisandb

> Embedded JSON-first database for TypeScript with Zod validation, model classes, async-safe operations, and blazing-fast lookups.

## Type-safe. File-based. Zero-dependencies on heavy ORMs. Great for CLIs, tools, scripts, or offline-first apps.

## Features

- Fully type-safe via TypeScript + Zod
- Strong runtime validation
- Class-based models with methods & virtuals
- Indexed queries & uniqueness constraints
- Sync + Async support
- Deep partial lookups
- Concurrency-safe (async-mutex + p-limit)
- Atomic file writes (temp + rename)
- JSON-backed, no server or DB setup
- Perfect for CLIs, bots, and tools

---

## Quick Start

### 1. Install

```bash
bun add @neisanworks/neisandb
# or
npm install @neisanworks/neisandb
# or
pnpm add @neisanworks/neisandb
```

### 2. Define a Schema and Model

```ts
// user.ts
import { CollectionModel, type DBModelProperties } from "@neisanworks/neisandb";
import z from "zod/v4";

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
```

### 3. Initiate the Database

```ts
// index.ts
import { Database } from "@neisanworks/neisandb";
import { UserSchema, UserModel } from "./models/user";

const db = new Database({
    folder: "~/src/lib/server/neisandb",
    autoload: true, // controls when to load data from file; default to true; set to false to lazy-load
    concurrencyLimit: 25 // shared across all collections; default to max of 10 concurrent processes
});

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
```

### 4. Use the Database

```ts
// Create a user, receiving `MethodFailure` or `MethodReturn` with the model as `createdUser.data`
const createUser = await Users.create({
    email: "test@example.com",
    password: "hunter2"
});

if (createUser.success) {
    const user = createUser.data; // UserModel is returned once record is created
    console.log("User created:", user.email);
}

// Find a user
const user = await Users.findOne({ email: "test@example.com" };
if (found) {
    console.log("Auth success?", user.authenticate("hunter2"));
}
```

---

## Core Concepts

- Schemas: Define shape and validation using `Zod`
- Models: Extend `CollectionModel` to add methods/computed properties
- Collections: `.collection({ name, schema, model })` defines a persistent collection
- Persistence: Each collection is backed by its own `.json` file
- Validation: All records are parsed via `Zod` — both at creation and update

---

## Output Files

Each collection is stored in its own `.json` file under your folder path, using atomic writing to ensure data remains uncorrupted:

```
neisandb
├── data
│   └── users-${Date.now()}-${Math.random()}.tmp # Temporary file cteated during atomic file writing;
│   └── users.json # Users datastore file
├── models
│   └── user.ts # Users datastore model
└── index.ts # Database initialization and datastore exporting (optional; datastores can be created and exported anywhere)
```

Example:

```json
{
    "1": {
        "email": "test@example.com",
        "password": "hunter2",
        "attempts": 0
    }
}
```

---

## - Querying Database

NeisanDB supports three flexible lookup syles:

### Find by ID

```ts
await Users.findOne(3);
```

### Find by Partial Match

```ts
await Users.find({ email: "hello@world.dev" });
```

### Find by Predicate (Sync or Async)

```ts
await Users.find((user) => user.email.endsWith("@gmail.com"));
```

## - Query Limit

You can limit your results:

```ts
await Users.find({ attempts: 0 }, 5);
```

## - Update Records

```ts
await Users.findOneAndUpdate(1, { attempts: 3 });
# or
await Users.findOneAndUpdate(1, (user) => {
  user.attempts++;
  return user;
});
```

## - Relationships (Joins) and Mapping/Transformation

```ts
await Users.findAndMap(
    async (_, id) => await Profiles.exists({ userID: id }), // Predicate Query: (record, id) => boolean
    async (user) => { // Model Mapping
        const profile = (await Profiles.findOne({ userID: user.id }))!;
        return { ...user.json, ...profile.json }; // Query Return Transformation
    }
);
```

---

## Types Overview
NeisanDB is designed with type safety at its core. It uses TypeScript’s powerful inference system to keep your models, queries, and results consistent, predictable, and fully typed — without needing manual type gymnastics. Here’s a quick overview of the types behind the scenes.

### 1. Schema-Level Types

| Type | Description |
|------|-------------|
| `Doc<Schema>` | The output type of a Zod schema (`z.output<Schema>`) |
| `DocWithID<Schema>` | Same as `Doc<Schema>`, but with an added `id: number` |
| `PartialSchema<Schema>` | DeepPartial of the schema output for filtering or partial updates |
| `SchemaKey<Schema>` | Union of the schema field names as keys |
| `ParseFailure<Schema>` | Result of a failed Zod parse with full error info |

### 2. Querying and Filtering

| Type | Description |
|------|-------------|
| `SchemaPredicate<Schema>` | `(doc, id) => boolean | Promise<boolean>` — used for custom predicates |
| `Lookup<Schema>` | Union of `PartialSchema` or `SchemaPredicate` — used in `find`, `exists`, etc. |
| `SyncLookup<Schema>` | Same as above, but only for sync code (`findSync`, etc.) |
| `RecordUpdate<Schema, Model>` | Used in `.update()` methods; accepts either partial update or `(model) => model` |
| `ModelMap<Schema, Model, T>` | Mapping/transformation logic for `.findAndMap()` or `.findAndTransform()` |

### 3. Model Definitions

| Type | Description |
|------|-------------|
| `DBModelProperties<Schema>` | Base structure of your model: `id` + all schema fields |
| `DBModel<Schema, Model>` | Constructor signature for any class extending `CollectionModel` |
| `CollectionModel<Schema>` | Base abstract class to extend for your custom models |

All models extending `CollectionModel`:
- Are Zod-validated upon `.json` access
- Can safely define custom methods and computed props
- Will always have `id` typed and enforced

### 4. Return Types

| Type | Description |
|------|-------------|
| `MethodSuccess` | `{ success: true }` — base success shape |
| `MethodFailure<Errors>` | `{ success: false, errors: Errors }` — returned for any failure |
| `MethodReturn<T>` | `{ success: true, data: T }` — on success with return data |
| `SchemaErrors<Schema>` | Partial map of field names to error messages, based on Zod schema |

All public API methods return structured result types — no exceptions or try/catch needed.

```ts
const result = await Users.create({ ... });
if (!result.success) {
  console.error(result.errors); // typed errors; { general: string } | Partial<Record<keyof z.infer<Schema>, string>>
}
```

---

## Why NeisanDB?
| Feature	| NeisanDB | lowdb | NeDB | TinyBase |
| :------ | :------: | :---: | :--: | -------: |
| Zod Schema Validation | ✔️ | ❌ | ❌ | ❌ |
| Class-Based Models | ✔️ | ❌ | ❌ | ❌ |
| Type-Safe Queries | ✔️ | ❌ | ❌ | ❌ |
| Async-Safe & Concurrent | ✔️ | ⚠️ | ❌ | ⚠️ |
| Deep Indexing | ✔️ | ❌ | ✔️ | ⚠️ |
| File-Based Persistence | ✔️ | ✔️ | ✔️ | ❌ |

---

## Contributing
Found a bug or have an idea? Open an issue or PR.

---

## License

MIT — © 2025 neisanworks
