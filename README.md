# 📦 @neisanworks/neisandb

> A lightweight, model-driven, file-backed database for TypeScript powered by Zod — perfect for CLIs, small apps, prototyping, and Bun/Node projects.

---

## 🧠 Why use `neisandb`?

- ✅ **Zod-powered schemas** for runtime + compile-time validation  
- ✅ **Model-based classes** with full intellisense  
- ✅ **Persistent** `.json` file storage  
- ✅ **Fast prototyping** for local data  
- ✅ **Tiny footprint**, no runtime dependencies (just Zod)  
- ✅ Works with **Bun**, **Node.js**, and **TypeScript**

---

## ✨ Features

- 📁 File-backed JSON databases (`./my-folder/collection.json`)
- 🧪 Strongly typed document models
- 🔎 Simple `find()` and `create()` queries
- 💥 Zod validation built-in
- 🧩 Extendable with your own methods (e.g., `authenticate()`)

---

## 🚀 Quick Start

### 1. Install
```bash
bun add neisandb zod
# or
npm install neisandb zod
```
### 2. Define a Schema and Model
```ts

// user.ts
import { z } from "zod";
import { type DBModelProperties } from "neisandb/types";

export const UserSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  attempts: z.number(),
});

export type UserSchema = typeof UserSchema;

export class UserModel implements DBModelProperties<UserSchema> {
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

  authenticate(password: string) {
    return this.password === password;
  }
}
```
### 3.Initiate the Database
```ts
// main.ts
import { Database } from "neisandb/database";
import { UserSchema, UserModel } from "./user";

const db = new Database({ folder: "./data", autoload: true });

const Users = db.collection({
  name: "users",
  schema: UserSchema,
  model: UserModel,
});
```
### 4. Use the Database
```ts
// Create a user
const result = Users.create({
  email: "test@example.com",
  password: "hunter2",
  attempts: 0,
});

if (result.success) {
  const user = result.data;
  console.log("User created:", user.email);
}

// Find a user
const found = Users.find({ email: "test@example.com" }, 1);
if (found) {
  const user = found;
  console.log("Auth success?", user.authenticate("hunter2"));
}
```

## 📂 Output Files
Each collection is stored in its own .json file under your folder path:
```bash
/data/
└── users.json
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
## 📐 Types Overview
| Type                     | Description                         |
| ------------------------ | ----------------------------------- |
| `DatabaseClass`          | Main DB instance                    |
| `DatastoreClass`         | Collection instance                 |
| `DBModel<Schema, Model>` | Constructor signature for models    |
| `MethodResult<T>`        | Result type for safe actions        |
| `Prettier<T>`            | Utility to flatten & preserve types |
## 📜 License
MIT — © 2025 neisanworks

