# Quickstart

This guide shows the fastest path to using the package in a React Native project.

## 1. Define Your Migration Files

Suggested folder:

```text
src/database/migrations/
```

Create files like:

```text
20260322090000_create_users.up.sql
20260322090000_create_users.down.sql
```

You can generate them with the CLI:

```bash
rn-sqlite-migrations create create_users --dir src/database/migrations
```

If you provide a custom timestamp, it must use the format `yyyymmddHHMMSS`.

## 2. Build a SQLite Executor Adapter

Your app owns the actual SQLite driver. The package only needs an adapter with:

```ts
type SqliteExecutor = {
  execute(statement: { sql: string; params?: Array<string | number | null> }): Promise<void>;
  query<T>(statement: { sql: string; params?: Array<string | number | null> }): Promise<T[]>;
  withTransaction<T>(callback: () => Promise<T>): Promise<T>;
};
```

## 3. Define the Catalog

```ts
import { defineMigrations } from "react-native-sqlite-migrations";

export const migrations = defineMigrations({
  directory: "src/database/migrations",
  migrations: [
    {
      name: "20260322090000_create_users",
      sql: {
        up: "20260322090000_create_users.up.sql",
        down: "20260322090000_create_users.down.sql",
      },
      metadata: {
        description: "Create the users table",
        reversible: true,
      },
    },
  ],
});
```

## 4. Load SQL Through a Static Manifest

React Native commonly needs statically known file references.

You can generate a manifest with:

```bash
rn-sqlite-migrations manifest --dir src/database/migrations --out src/database/migrations/manifest.generated.json
```

Then resolve SQL contents using your app's preferred asset strategy.

## 5. Run Migrations

```ts
import { MigrationRunner } from "react-native-sqlite-migrations";
import { migrations } from "./migrations";

const runner = new MigrationRunner({
  db: sqliteExecutor,
  catalog: migrations,
  readSqlFile: async ({ directory, path }) => {
    return loadSqlFromBundle(`${directory}/${path}`);
  },
  logger: {
    log(event) {
      console.log("[migration]", event);
    },
  },
});

await runner.migrate();
```

## 6. Use `beforeDestructive` for Data Preservation

When a schema change would destroy or replace old structures, migrate data first:

```ts
{
  name: "20260322100000_split_full_name",
  sql: {
    up: "20260322100000_split_full_name.up.sql",
    down: "20260322100000_split_full_name.down.sql",
  },
  beforeDestructive: async ({ db }) => {
    const rows = await db.query<{ id: number; full_name: string | null }>({
      sql: "SELECT id, full_name FROM users",
    });

    for (const row of rows) {
      const [firstName, ...rest] = (row.full_name ?? "").trim().split(/\\s+/);
      await db.execute({
        sql: "UPDATE users SET first_name = ?, last_name = ? WHERE id = ?",
        params: [firstName ?? null, rest.join(" ") || null, row.id],
      });
    }
  },
}
```

## 7. Validate Before Shipping

Use the CLI to validate the folder structure:

```bash
rn-sqlite-migrations validate --dir src/database/migrations
```

If you need to inspect rollback safety for the latest applied batch:

```ts
const rollbackPlan = await runner.planRollbackLastBatch();
```

For release checks in this package itself, you can also run:

```bash
npm run pack:check
```
