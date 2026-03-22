const test = require("node:test");
const assert = require("node:assert/strict");

const { defineMigrations, MigrationRunner, splitSqlStatements } = require("../dist/index.js");

class FakeSqliteExecutor {
  constructor() {
    this.migrationRecords = [];
    this.executedStatements = [];
    this.queryResponses = new Map();
    this.transactions = 0;
  }

  setQueryResponse(sql, rows) {
    this.queryResponses.set(sql, rows);
  }

  async execute(statement) {
    this.executedStatements.push(statement.sql);

    if (statement.sql.startsWith("CREATE TABLE IF NOT EXISTS")) {
      return;
    }

    if (statement.sql.startsWith("INSERT INTO")) {
      const [name, batch, appliedAt] = statement.params;
      this.migrationRecords.push({
        name,
        batch,
        applied_at: appliedAt,
      });
      return;
    }

    if (statement.sql.startsWith("DELETE FROM")) {
      const [name] = statement.params;
      this.migrationRecords = this.migrationRecords.filter((record) => record.name !== name);
      return;
    }
  }

  async query(statement) {
    if (statement.sql.includes("SELECT name, batch, applied_at") && statement.sql.includes("WHERE batch = ?")) {
      return this.migrationRecords
        .filter((record) => record.batch === statement.params[0])
        .sort((left, right) => left.name.localeCompare(right.name));
    }

    if (statement.sql.includes("SELECT name, batch, applied_at")) {
      return [...this.migrationRecords].sort((left, right) => left.name.localeCompare(right.name));
    }

    if (statement.sql.includes("SELECT MAX(batch) AS batch")) {
      const batch = this.migrationRecords.reduce((current, record) => {
        return Math.max(current, Number(record.batch));
      }, 0);

      return [{ batch }];
    }

    return this.queryResponses.get(statement.sql) ?? [];
  }

  async withTransaction(callback) {
    this.transactions += 1;
    return callback();
  }
}

test("defineMigrations sorts migrations by name", () => {
  const catalog = defineMigrations({
    directory: "db/migrations",
    migrations: [
      {
        name: "202603210002_second",
        sql: { up: "202603210002_second.up.sql" },
      },
      {
        name: "202603210001_first",
        sql: { up: "202603210001_first.up.sql" },
      },
    ],
  });

  assert.deepEqual(
    catalog.migrations.map((migration) => migration.name),
    ["202603210001_first", "202603210002_second"],
  );
});

test("defineMigrations rejects duplicate names", () => {
  assert.throws(() => {
    defineMigrations({
      directory: "db/migrations",
      migrations: [
        {
          name: "202603210001_users",
          sql: { up: "a.sql" },
        },
        {
          name: "202603210001_users",
          sql: { up: "b.sql" },
        },
      ],
    });
  }, /Duplicate migration name/);
});

test("splitSqlStatements ignores semicolons inside strings and strips line comments", () => {
  const statements = splitSqlStatements(`
    -- create a row
    INSERT INTO messages(text) VALUES('hello;world');
    INSERT INTO messages(text) VALUES("still;inside");
    SELECT * FROM messages;
  `);

  assert.deepEqual(statements, [
    "INSERT INTO messages(text) VALUES('hello;world')",
    'INSERT INTO messages(text) VALUES("still;inside")',
    "SELECT * FROM messages",
  ]);
});

test("MigrationRunner migrates pending files, executes hooks, and reports status", async () => {
  const db = new FakeSqliteExecutor();
  db.setQueryResponse("SELECT id, full_name FROM users", [
    { id: 1, full_name: "Ada Lovelace" },
  ]);

  const hookOrder = [];
  const catalog = defineMigrations({
    directory: "db/migrations",
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
        beforeDestructive: async ({ db: transactionDb }) => {
          hookOrder.push("beforeDestructive");
          const rows = await transactionDb.query({
            sql: "SELECT id, full_name FROM users",
          });

          assert.equal(rows.length, 1);
        },
        beforeUp: async () => {
          hookOrder.push("beforeUp");
        },
        afterUp: async () => {
          hookOrder.push("afterUp");
        },
      },
    ],
  });

  const runner = new MigrationRunner({
    db,
    catalog,
    readSqlFile: async ({ path }) => {
      const files = {
        "202603210001_create_users.up.sql":
          "CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT);",
        "202603210001_create_users.down.sql": "DROP TABLE users;",
        "202603210002_split_full_name.up.sql":
          "ALTER TABLE users ADD COLUMN first_name TEXT; ALTER TABLE users ADD COLUMN last_name TEXT;",
        "202603210002_split_full_name.down.sql": "DROP TABLE users;",
      };

      return files[path];
    },
    now: () => "2026-03-21T00:00:00.000Z",
  });

  const result = await runner.migrate();
  const status = await runner.status();

  assert.deepEqual(result.executed, [
    "202603210001_create_users",
    "202603210002_split_full_name",
  ]);
  assert.equal(result.batch, 1);
  assert.deepEqual(hookOrder, ["beforeDestructive", "beforeUp", "afterUp"]);
  assert.equal(db.transactions, 2);
  assert.equal(status.applied.length, 2);
  assert.equal(status.pending.length, 0);
  assert.equal(db.migrationRecords[0].applied_at, "2026-03-21T00:00:00.000Z");
  assert.ok(
    db.executedStatements.includes("ALTER TABLE users ADD COLUMN first_name TEXT"),
  );
});

test("MigrationRunner rolls back the last batch in reverse order", async () => {
  const db = new FakeSqliteExecutor();
  db.migrationRecords = [
    {
      name: "202603210001_create_users",
      batch: 1,
      applied_at: "2026-03-21T00:00:00.000Z",
    },
    {
      name: "202603210002_split_full_name",
      batch: 1,
      applied_at: "2026-03-21T00:00:00.000Z",
    },
  ];

  const rollbackHooks = [];
  const catalog = defineMigrations({
    directory: "db/migrations",
    migrations: [
      {
        name: "202603210001_create_users",
        sql: {
          up: "202603210001_create_users.up.sql",
          down: "202603210001_create_users.down.sql",
        },
        beforeDown: async () => {
          rollbackHooks.push("create_users:beforeDown");
        },
        afterDown: async () => {
          rollbackHooks.push("create_users:afterDown");
        },
      },
      {
        name: "202603210002_split_full_name",
        sql: {
          up: "202603210002_split_full_name.up.sql",
          down: "202603210002_split_full_name.down.sql",
        },
        beforeDown: async () => {
          rollbackHooks.push("split_full_name:beforeDown");
        },
        afterDown: async () => {
          rollbackHooks.push("split_full_name:afterDown");
        },
      },
    ],
  });

  const runner = new MigrationRunner({
    db,
    catalog,
    readSqlFile: async ({ path }) => {
      const files = {
        "202603210001_create_users.down.sql": "DROP TABLE users;",
        "202603210002_split_full_name.down.sql": "ALTER TABLE users DROP COLUMN first_name;",
      };

      return files[path];
    },
  });

  const result = await runner.rollbackLastBatch();

  assert.deepEqual(result.rolledBack, [
    "202603210002_split_full_name",
    "202603210001_create_users",
  ]);
  assert.deepEqual(rollbackHooks, [
    "split_full_name:beforeDown",
    "split_full_name:afterDown",
    "create_users:beforeDown",
    "create_users:afterDown",
  ]);
  assert.equal(db.migrationRecords.length, 0);
});
