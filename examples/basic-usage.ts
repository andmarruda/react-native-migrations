import { MigrationRunner, defineMigrations, type MigrationLogger, type SqliteExecutor } from "../src";

const migrations = defineMigrations({
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
        owner: "mobile-platform",
        tags: ["bootstrap"],
        reversible: true,
      },
    },
  ],
});

const logger: MigrationLogger = {
  log(event) {
    console.log("[migration-event]", event);
  },
};

declare const sqliteExecutor: SqliteExecutor;
declare function loadSqlFromBundle(path: string): Promise<string>;

async function bootDatabase() {
  const runner = new MigrationRunner({
    db: sqliteExecutor,
    catalog: migrations,
    logger,
    readSqlFile: async ({ directory, path }) => loadSqlFromBundle(`${directory}/${path}`),
  });

  await runner.migrate();
}

void bootDatabase();
