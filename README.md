# react-native-sqlite-migrations

Laravel-style SQLite migrations for React Native, with support for safe data migration before destructive schema changes.

This package is designed to keep your app focused on business rules instead of migration orchestration.

## Why This Package

React Native apps that work offline usually keep important user data locally. That makes schema changes more sensitive than in a typical web app.

This package helps you:

- keep SQL files outside the library, inside your app
- run migrations in order using timestamp-based names
- track applied migrations with Laravel-like `batch` semantics
- move or transform data before dropping tables or replacing structures
- keep the SQLite driver adapter small and explicit
- verify migration integrity with stored SQL checksums
- inspect health issues before running risky migrations or rollbacks

## Why It Is Easy to Adopt

The package is intentionally small to integrate:

1. keep your SQL files in a folder such as `src/database/migrations`
2. provide a tiny SQLite adapter with `execute`, `query`, and `withTransaction`
3. point the library to your SQL directory through `readSqlFile`
4. run `await runner.migrate()` during database boot

That means you do not need to move your SQL into the library or let the library own your database driver.

## Suggested App Structure

```text
src/
  database/
    migrations/
      202603210001_create_users.up.sql
      202603210001_create_users.down.sql
      202603210002_split_full_name.up.sql
      202603210002_split_full_name.down.sql
```

## Quick Example

```ts
import { defineMigrations, MigrationRunner } from "react-native-sqlite-migrations";

const catalog = defineMigrations({
  directory: "src/database/migrations",
  migrations: [
    {
      name: "202603210001_create_users",
      sql: {
        up: "202603210001_create_users.up.sql",
        down: "202603210001_create_users.down.sql",
      },
    },
    {
      name: "202603210002_split_full_name",
      sql: {
        up: "202603210002_split_full_name.up.sql",
        down: "202603210002_split_full_name.down.sql",
      },
      beforeDestructive: async ({ db }) => {
        await db.execute({
          sql: "ALTER TABLE users ADD COLUMN first_name TEXT",
        });

        await db.execute({
          sql: "ALTER TABLE users ADD COLUMN last_name TEXT",
        });

        const rows = await db.query<{ id: number; full_name: string | null }>({
          sql: "SELECT id, full_name FROM users",
        });

        for (const row of rows) {
          const [firstName, ...rest] = (row.full_name ?? "").trim().split(/\s+/);
          await db.execute({
            sql: "UPDATE users SET first_name = ?, last_name = ? WHERE id = ?",
            params: [firstName ?? null, rest.join(" ") || null, row.id],
          });
        }
      },
    },
  ],
});

const runner = new MigrationRunner({
  db: sqliteExecutor,
  catalog,
  readSqlFile: async ({ directory, path }) => {
    return loadSqlFromBundle(`${directory}/${path}`);
  },
});

await runner.migrate();
```

## SQLite Adapter Contract

The package does not force `expo-sqlite`, `react-native-quick-sqlite`, or any other specific driver.
Your app only needs to provide this adapter shape:

```ts
type SqliteExecutor = {
  execute(statement: { sql: string; params?: Array<string | number | null> }): Promise<void>;
  query<T>(statement: { sql: string; params?: Array<string | number | null> }): Promise<T[]>;
  withTransaction<T>(callback: () => Promise<T>): Promise<T>;
};
```

Official adapter helpers are now available for:

- `createExpoSqliteExecutor`
- `createQuickSqliteExecutor`

## Migration Flow

When you call `migrate()`, the library:

1. creates the migration repository table if needed
2. discovers pending migrations
3. opens one transaction per migration
4. runs `beforeDestructive`
5. runs `beforeUp`
6. loads the `.up.sql` file
7. executes SQL statements sequentially
8. records the migration with a `batch`

When you call `rollbackLastBatch()`, the library:

1. finds the latest `batch`
2. runs migrations in reverse order
3. runs `beforeDown`, `down.sql`, and `afterDown`
4. removes migration records from the repository table

## When to Use `beforeDestructive`

Use `beforeDestructive` when data must be preserved before a destructive structural change.

Examples:

- move data from an old table into a new one
- split a legacy column into multiple new columns
- normalize old values before a table rebuild
- create temporary storage before recreating a table

After that, the `.up.sql` file can focus on the final schema change itself.

## Loading SQL Files

React Native often cannot access arbitrary local files dynamically at runtime. That is why the package receives `readSqlFile` instead of using `fs` directly.

This makes it easy to use:

- `require`
- bundled assets
- a generated manifest
- any custom local asset loader

Helper loaders are also exported:

- `createStaticSqlLoader`
- `createAssetSqlLoader`

Conceptual example:

```ts
const sqlFiles = {
  "src/database/migrations/202603210001_create_users.up.sql": require("./src/database/migrations/202603210001_create_users.up.sql"),
};

async function loadSqlFromBundle(path: string) {
  return sqlFiles[path];
}
```

## CLI

The package includes a CLI for common migration maintenance tasks:

```bash
rn-sqlite-migrations help
rn-sqlite-migrations create add_users --dir src/database/migrations
rn-sqlite-migrations validate --dir src/database/migrations
rn-sqlite-migrations manifest --dir src/database/migrations --out src/database/migrations/manifest.generated.json
```

## Can This Work With `npx`?

Yes.

Because the package exposes a `bin` command, it can be used with `npx`.

If the package is already installed in your project:

```bash
npx rn-sqlite-migrations create add_users --dir src/database/migrations
```

If the package is published and you want to run it without installing first:

```bash
npx --package react-native-sqlite-migrations rn-sqlite-migrations create add_users --dir src/database/migrations
```

That means it is absolutely possible to generate migrations automatically with an `npx` command.

## Useful `npx` Commands

Create a migration:

```bash
npx rn-sqlite-migrations create create_users --dir src/database/migrations
```

Validate your migration folder:

```bash
npx rn-sqlite-migrations validate --dir src/database/migrations
```

Generate a static manifest for bundled SQL loading:

```bash
npx rn-sqlite-migrations manifest --dir src/database/migrations --out src/database/migrations/manifest.generated.json
```

## Examples

Consumer examples live in:

- `examples/basic-usage.ts`
- `examples/expo-adapter.ts`
- `examples/logger.ts`
- `examples/quick-sqlite-adapter.ts`

## Integrity and Health Checks

The runner now supports integrity verification with stored SQL checksums.

You can enable stricter enforcement with:

```ts
const runner = new MigrationRunner({
  db: sqliteExecutor,
  catalog,
  readSqlFile,
  integrityMode: "strict",
});
```

And you can inspect health issues before running migrations:

```ts
const report = await runner.healthCheck();
```

Useful when you want to detect:

- checksum drift in already-applied migrations
- applied migrations missing from the current catalog
- rollback-unavailable situations

## Internal Docs

Additional English documentation lives in:

- `docs/architecture.md`
- `docs/coverage-roadmap.en.md`
- `docs/coverage.md`
- `docs/excellence.en.md`
- `docs/improvements.md`
- `docs/implementation-tasks.md`
- `docs/quickstart.md`

Documentacao adicional em portugues vive em:

- `docs/coverage-roadmap.pt-BR.md`
- `docs/excellence.pt-BR.md`

## Local Testing

Run the isolated package checks with:

```bash
npm test
```

This script:

1. builds the package into `dist/`
2. imports the built output
3. runs local tests against the package in isolation

To collect native Node coverage for the built package, run:

```bash
npm run test:coverage
```

This writes raw V8 coverage files into `coverage/v8/` and prints the coverage summary in the terminal.

## Support

If you want to support the project:

- Buy Me a Coffee: `buymeacoffee.com/andmarruda`
