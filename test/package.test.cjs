const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  defineMigrations,
  MigrationError,
  MigrationRunner,
  splitSqlStatements,
} = require("../dist/index.js");

class FakeSqliteExecutor {
  constructor() {
    this.migrationRecords = [];
    this.executedStatements = [];
    this.queryResponses = new Map();
    this.transactions = 0;
    this.failOnSql = null;
    this.failOnRepositorySetup = false;
  }

  setQueryResponse(sql, rows) {
    this.queryResponses.set(sql, rows);
  }

  async execute(statement) {
    if (
      this.failOnRepositorySetup &&
      statement.sql.startsWith("CREATE TABLE IF NOT EXISTS")
    ) {
      throw new Error("Injected repository setup failure");
    }

    if (this.failOnSql && statement.sql.includes(this.failOnSql)) {
      throw new Error(`Injected failure for statement: ${statement.sql}`);
    }

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

function createCliTempDirectory(prefix = "rn-sqlite-migrations-cli-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function getCliPath() {
  return path.resolve(__dirname, "..", "bin", "rn-sqlite-migrations.cjs");
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

test("defineMigrations rejects irreversible migrations with down SQL", () => {
  assert.throws(() => {
    defineMigrations({
      directory: "db/migrations",
      migrations: [
        {
          name: "202603210001_users",
          sql: {
            up: "users.up.sql",
            down: "users.down.sql",
          },
          metadata: {
            reversible: false,
          },
        },
      ],
    });
  }, /cannot define a down SQL file/);
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

test("splitSqlStatements handles empty input, trailing statements, and escaped quotes", () => {
  assert.deepEqual(splitSqlStatements(""), []);
  assert.deepEqual(splitSqlStatements("SELECT 1"), ["SELECT 1"]);
  assert.deepEqual(
    splitSqlStatements("INSERT INTO notes(text) VALUES('it\\'s fine;still fine');"),
    ["INSERT INTO notes(text) VALUES('it\\'s fine;still fine')"],
  );
});

test("MigrationRunner logs skipped migrations when nothing is pending", async () => {
  const db = new FakeSqliteExecutor();
  db.migrationRecords = [
    {
      name: "202603210001_create_users",
      batch: 1,
      applied_at: "2026-03-21T00:00:00.000Z",
    },
  ];

  const loggedEvents = [];
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
    ],
  });

  const runner = new MigrationRunner({
    db,
    catalog,
    logger: {
      log(event) {
        loggedEvents.push(event);
      },
    },
    readSqlFile: async () => "SELECT 1;",
  });

  const result = await runner.migrate();

  assert.deepEqual(result, {
    executed: [],
    skipped: ["202603210001_create_users"],
    batch: null,
  });
  assert.ok(loggedEvents.some((event) => event.type === "migration:skipped"));
});

test("MigrationRunner migrates pending files, executes hooks, and reports status", async () => {
  const db = new FakeSqliteExecutor();
  db.setQueryResponse("SELECT id, full_name FROM users", [
    { id: 1, full_name: "Ada Lovelace" },
  ]);

  const hookOrder = [];
  const loggedEvents = [];
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
    logger: {
      log(event) {
        loggedEvents.push(event);
      },
    },
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
  assert.ok(loggedEvents.some((event) => event.type === "migration:start"));
  assert.ok(
    loggedEvents.some(
      (event) => event.type === "migration:phase:complete" && event.phase === "up",
    ),
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

test("MigrationRunner reports empty rollback state", async () => {
  const db = new FakeSqliteExecutor();
  const loggedEvents = [];

  const runner = new MigrationRunner({
    db,
    catalog: defineMigrations({
      directory: "db/migrations",
      migrations: [],
    }),
    logger: {
      log(event) {
        loggedEvents.push(event);
      },
    },
    readSqlFile: async () => "SELECT 1;",
  });

  const result = await runner.rollbackLastBatch();

  assert.deepEqual(result, {
    rolledBack: [],
    batch: null,
  });
  assert.ok(loggedEvents.some((event) => event.type === "rollback:empty"));
});

test("MigrationRunner exposes rollback planning and blocks irreversible migrations", async () => {
  const db = new FakeSqliteExecutor();
  db.migrationRecords = [
    {
      name: "202603210003_irreversible",
      batch: 2,
      applied_at: "2026-03-21T00:00:00.000Z",
    },
  ];

  const catalog = defineMigrations({
    directory: "db/migrations",
    migrations: [
      {
        name: "202603210003_irreversible",
        sql: {
          up: "202603210003_irreversible.up.sql",
        },
        metadata: {
          reversible: false,
        },
      },
    ],
  });

  const runner = new MigrationRunner({
    db,
    catalog,
    readSqlFile: async () => "SELECT 1;",
  });

  const plan = await runner.planRollbackLastBatch();

  assert.deepEqual(plan, [
    {
      name: "202603210003_irreversible",
      batch: 2,
      reversible: false,
      reason: "migration-marked-as-irreversible",
    },
  ]);

  await assert.rejects(() => runner.rollbackLastBatch(), (error) => {
    assert.equal(error instanceof MigrationError, true);
    assert.equal(error.migrationName, "202603210003_irreversible");
    assert.equal(error.phase, "down");
    return true;
  });
});

test("MigrationRunner reports missing catalog entries during rollback planning", async () => {
  const db = new FakeSqliteExecutor();
  db.migrationRecords = [
    {
      name: "202603210004_deleted_from_catalog",
      batch: 3,
      applied_at: "2026-03-21T00:00:00.000Z",
    },
  ];

  const runner = new MigrationRunner({
    db,
    catalog: defineMigrations({
      directory: "db/migrations",
      migrations: [],
    }),
    readSqlFile: async () => "SELECT 1;",
  });

  const plan = await runner.planRollbackLastBatch();

  assert.deepEqual(plan, [
    {
      name: "202603210004_deleted_from_catalog",
      batch: 3,
      reversible: false,
      reason: "migration-missing-from-catalog",
    },
  ]);

  await assert.rejects(() => runner.rollbackLastBatch(), /marked as irreversible/);
});

test("MigrationRunner reports missing down SQL files in rollback planning", async () => {
  const db = new FakeSqliteExecutor();
  db.migrationRecords = [
    {
      name: "202603210005_missing_down",
      batch: 4,
      applied_at: "2026-03-21T00:00:00.000Z",
    },
  ];

  const runner = new MigrationRunner({
    db,
    catalog: defineMigrations({
      directory: "db/migrations",
      migrations: [
        {
          name: "202603210005_missing_down",
          sql: {
            up: "202603210005_missing_down.up.sql",
          },
        },
      ],
    }),
    readSqlFile: async () => "SELECT 1;",
  });

  const plan = await runner.planRollbackLastBatch();

  assert.deepEqual(plan, [
    {
      name: "202603210005_missing_down",
      batch: 4,
      reversible: false,
      reason: "missing-down-sql-file",
    },
  ]);
});

test("MigrationRunner wraps repository setup failures in MigrationError", async () => {
  const db = new FakeSqliteExecutor();
  db.failOnRepositorySetup = true;

  const runner = new MigrationRunner({
    db,
    catalog: defineMigrations({
      directory: "db/migrations",
      migrations: [],
    }),
    readSqlFile: async () => "SELECT 1;",
  });

  await assert.rejects(() => runner.status(), (error) => {
    assert.equal(error instanceof MigrationError, true);
    assert.equal(error.phase, "repository");
    assert.match(error.message, /repository setup/);
    return true;
  });
});

test("MigrationRunner wraps phase failures in MigrationError", async () => {
  const db = new FakeSqliteExecutor();
  db.failOnSql = "ALTER TABLE users ADD COLUMN failed_column TEXT";

  const catalog = defineMigrations({
    directory: "db/migrations",
    migrations: [
      {
        name: "202603210010_breaking_change",
        sql: {
          up: "202603210010_breaking_change.up.sql",
          down: "202603210010_breaking_change.down.sql",
        },
      },
    ],
  });

  const runner = new MigrationRunner({
    db,
    catalog,
    readSqlFile: async ({ path }) => {
      if (path === "202603210010_breaking_change.up.sql") {
        return "ALTER TABLE users ADD COLUMN failed_column TEXT;";
      }

      return "DROP TABLE users;";
    },
  });

  await assert.rejects(() => runner.migrate(), (error) => {
    assert.equal(error instanceof MigrationError, true);
    assert.match(error.message, /failed during phase "up"/);
    assert.equal(error.migrationName, "202603210010_breaking_change");
    assert.equal(error.sqlFile, "202603210010_breaking_change.up.sql");
    return true;
  });
});

test("MigrationRunner wraps hook failures for all lifecycle hook phases", async () => {
  const phases = [
    ["beforeUp", "beforeUp"],
    ["afterUp", "afterUp"],
    ["beforeDown", "beforeDown"],
    ["afterDown", "afterDown"],
  ];

  for (const [hookName, expectedPhase] of phases) {
    const db = new FakeSqliteExecutor();

    const migration = {
      name: `202603210020_${hookName}`,
      sql: {
        up: `202603210020_${hookName}.up.sql`,
        down: `202603210020_${hookName}.down.sql`,
      },
      [hookName]: async () => {
        throw new Error(`Injected ${hookName} failure`);
      },
    };

    const runner = new MigrationRunner({
      db,
      catalog: defineMigrations({
        directory: "db/migrations",
        migrations: [migration],
      }),
      readSqlFile: async ({ path }) => {
        if (path.endsWith(".up.sql")) {
          return "SELECT 1;";
        }

        return "SELECT 1;";
      },
    });

    const operation =
      hookName === "beforeDown" || hookName === "afterDown"
        ? async () => {
            db.migrationRecords = [
              {
                name: migration.name,
                batch: 1,
                applied_at: "2026-03-21T00:00:00.000Z",
              },
            ];
            return runner.rollbackLastBatch();
          }
        : () => runner.migrate();

    await assert.rejects(operation, (error) => {
      assert.equal(error instanceof MigrationError, true);
      assert.equal(error.phase, expectedPhase);
      assert.equal(error.migrationName, migration.name);
      return true;
    });
  }
});

test("CLI creates timestamped files, validates migrations, and generates a manifest", () => {
  const tempDirectory = createCliTempDirectory();
  const cliPath = getCliPath();

  const createOutput = execFileSync(
    "node",
    [
      cliPath,
      "create",
      "create_users",
      "--dir",
      tempDirectory,
      "--timestamp",
      "20260322090000",
    ],
    { encoding: "utf8" },
  );

  assert.match(createOutput, /20260322090000_create_users\.up\.sql/);
  assert.equal(
    fs.existsSync(path.join(tempDirectory, "20260322090000_create_users.up.sql")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(tempDirectory, "20260322090000_create_users.down.sql")),
    true,
  );

  const validateOutput = execFileSync(
    "node",
    [cliPath, "validate", "--dir", tempDirectory],
    { encoding: "utf8" },
  );
  assert.match(validateOutput, /Validated 1 migrations/);

  const manifestPath = path.join(tempDirectory, "manifest.generated.json");
  const manifestOutput = execFileSync(
    "node",
    [cliPath, "manifest", "--dir", tempDirectory, "--out", manifestPath],
    { encoding: "utf8" },
  );

  assert.match(manifestOutput, /Generated manifest/);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest, {
    "20260322090000_create_users": {
      up: "20260322090000_create_users.up.sql",
      down: "20260322090000_create_users.down.sql",
    },
  });
});

test("CLI rejects unknown commands", () => {
  const cliPath = getCliPath();

  assert.throws(() => {
    execFileSync("node", [cliPath, "unknown-command"], {
      encoding: "utf8",
      stdio: "pipe",
    });
  }, /Unknown command/);
});

test("CLI rejects missing migration names and duplicate creates", () => {
  const cliPath = getCliPath();
  const tempDirectory = createCliTempDirectory("rn-sqlite-migrations-cli-duplicate-");

  assert.throws(() => {
    execFileSync("node", [cliPath, "create"], {
      encoding: "utf8",
      stdio: "pipe",
    });
  }, /Please provide a migration name/);

  execFileSync(
    "node",
    [
      cliPath,
      "create",
      "create_users",
      "--dir",
      tempDirectory,
      "--timestamp",
      "20260322101010",
    ],
    { encoding: "utf8" },
  );

  assert.throws(() => {
    execFileSync(
      "node",
      [
        cliPath,
        "create",
        "create_users",
        "--dir",
        tempDirectory,
        "--timestamp",
        "20260322101010",
      ],
      {
        encoding: "utf8",
        stdio: "pipe",
      },
    );
  }, /already exists/);
});

test("CLI validate reports invalid file names and missing down files", () => {
  const cliPath = getCliPath();
  const tempDirectory = createCliTempDirectory("rn-sqlite-migrations-cli-invalid-");

  fs.writeFileSync(
    path.join(tempDirectory, "bad-name.sql"),
    "-- invalid file name for validation\n",
  );
  fs.writeFileSync(
    path.join(tempDirectory, "20260322111111_only_up.up.sql"),
    "-- valid up file without matching down\n",
  );

  assert.throws(() => {
    execFileSync("node", [cliPath, "validate", "--dir", tempDirectory], {
      encoding: "utf8",
      stdio: "pipe",
    });
  }, /Invalid migration file name|missing a \.down\.sql file/);
});
