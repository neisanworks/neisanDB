# @neisanworks/neisandb

> A lightweight, model-driven, file-backed database for TypeScript powered by Zod — perfect for CLIs, small apps, prototyping, and Bun/Node projects.

---

## Features

- File-based JSON storage with atomic writes and directory syncing
- Zod-powered schemas for strict runtime validation and type inference
- Custom model classes with methods, virtual getters, and schema enforcement
- Deep partial `.findOne()`, `.find()` querying via object shape or functional filters
- Schema-level uniqueness enforcement across one or more fields
- Atomic `.create()`, `.save()`, `.delete()` operations with rollback on failure
- Automatic file creation and folder setup if not present
- Built-in error handling via consistent return types: MethodSuccess or MethodFailure
- Automatic ID management for records
- Extensible architecture (new collections/models are easy to add)

---

## Quick Start

### 1. Install

```bash
bun add @neisanworks/neisandb zod
# or
npm install @neisanworks/neisandb zod
```

### 2. Define a Schema and Model

```ts
// user.ts
import { CollectionModel, type DBModelProperties } from "@neisanworks/neisandb";
import z from "zod/v4"

const UserSchema = z.object({
    email: z.string(),
    password: z.string(),
    attempts: z.number().default(0)
});
type UserSchema = typeof UserSchema;

class UserModel
extends CollectionModel<UserSchema> // Allows for the `json()` method, which validates the data before returning JSON
implements DBModelProperties<UserSchema> // Ensures the model's properties and types are aligned; Not required, but helpful
{
    id: number;
    email: string;
    password: string;
    attempts: number;

    constructor(data: z.infer<UserSchema>, id: number) {
        super(UserSchema);
        this.id = id;
        this.email = data.email;
        this.password = data.password;
        this.attempts = data.attempts;
    }

    @property // Virtual properties can be created and used when a record is returned from the datastore
    locked(): boolean {
      return this.attempts >= 3
    }

    // Methods can be attached to the model and used upon return of a record
    authenticate(password: string): boolean {
        return this.password === password;
    }
}
```

### 3. Initiate the Database

```ts
// index.ts
import { Database } from "@neisanworks/neisandb";
import { UserSchema, UserModel } from "./models/user";

const db = new Database({ folder: "./data", autoload: true });

const Users = db.collection({
    name: "users",
    schema: UserSchema,
    model: UserModel,
    uniques: ['email'] // Ensures that no two users have the same email address
});
```

### 4. Use the Database

```ts
// Create a user, receiving MethodFailure or MethodReturn with the model as `createdUser.data`
const createUser = Users.create({
    email: "test@example.com",
    password: "hunter2",
    attempts: 0
});

if (createUser.success) {
    const user = createUser.data;
    console.log("User created:", user.email);
}

// Find a user
const user = Users.findOne({ email: "test@example.com" };
if (found) {
    console.log("Auth success?", user.authenticate("hunter2"));
}
```

---

## Output Files

Each collection is stored in its own .json file under your folder path, using atomic writing to ensure data remains uncorrupted:

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
    "0": {
        "email": "test@example.com",
        "password": "hunter2",
        "attempts": 0
    }
}
```

---

## Types Overview

### 1. Type Inference & Validation
- Full Zod schema integration with `z.core.input<Schema>` and `z.core.output<Schema>` types
- Strongly typed model creation and updates
- `CollectionModel` ensures that instances are always schema-valid

### 2. Return-Type Safety
- Explicit method result types via:
  - `MethodReturn<T> | MethodSuccess` – for successful operations
  - `MethodFailure<T>` – for failed operations with structured error messages
- Prevents reliance on exceptions; encourages predictable control flow

### 3. Deep Partial Matching
- `DeepPartial<T>` allows for recursive partial filtering in `.find()` and `.findOne()`
- `PartialSchema<Schema>` enables safe, schema-aware deep filters

### 4. Flexible querying
- `FilterLookup<Schema>` allows functional queries:
```ts
Users.find(({ doc }) => doc.email.includes('@example.com'))
```

### 5. Model Abstraction
- `DBModel<Schema, Model>` and `DBModelProperties<Schema>` link raw schema types to full class-based models
- Enables OOP-style behavior with typed `id` property baked in

---

## 📜 License

MIT — © 2025 neisanworks
