const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CliError,
  createAssetSqlLoader,
  createExpoSqliteExecutor,
  createQuickSqliteExecutor,
  createStaticSqlLoader,
  defaultChecksum,
  defineMigrations,
  MigrationError,
  MigrationRunner,
  splitSqlStatements,
} = require("../dist/index.js");
const packageExports = require("../dist/index.js");
const {
  createMigration,
  generateManifest,
  groupMigrationFiles,
  parseArgs,
  printHelp,
  resolveDirectory,
  runCli,
  toMigrationSlug,
  toTimestamp,
  validateMigrations,
} = require("../dist/cli.js");

class FakeSqliteExecutor {
  constructor() {
    this.migrationRecords = [];
    this.executedStatements = [];
    this.queryResponses = new Map();
    this.transactions = 0;
    this.failOnSql = null;
    this.failOnRepositorySetup = false;
    this.repositoryColumns = new Set([
      "id",
      "name",
      "batch",
      "applied_at",
      "up_checksum",
      "source_directory",
    ]);
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

    if (statement.sql.startsWith("ALTER TABLE") && statement.sql.includes("ADD COLUMN")) {
      const match = statement.sql.match(/ADD COLUMN\s+"?([a-z_]+)"?/i);
      if (match) {
        this.repositoryColumns.add(match[1]);
      }
      return;
    }

    if (statement.sql.startsWith("INSERT INTO")) {
      const [name, batch, appliedAt, upChecksum, sourceDirectory] = statement.params;
      this.migrationRecords.push({
        name,
        batch,
        applied_at: appliedAt,
        up_checksum: upChecksum ?? null,
        source_directory: sourceDirectory ?? null,
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

    if (statement.sql.startsWith("PRAGMA table_info(")) {
      return [...this.repositoryColumns].map((name) => ({ name }));
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

function createIoCapture() {
  const stderr = [];
  const stdout = [];

  return {
    io: {
      stderr(message) {
        stderr.push(message);
      },
      stdout(message) {
        stdout.push(message);
      },
    },
    stderr,
    stdout,
  };
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

test("defineMigrations rejects empty migration names", () => {
  assert.throws(() => {
    defineMigrations({
      directory: "db/migrations",
      migrations: [
        {
          name: "   ",
          sql: { up: "users.up.sql" },
        },
      ],
    });
  }, /cannot be empty/);
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

test("defineMigrations rejects migrations without up SQL files", () => {
  assert.throws(() => {
    defineMigrations({
      directory: "db/migrations",
      migrations: [
        {
          name: "202603210001_users",
          sql: {
            up: "  ",
          },
        },
      ],
    });
  }, /missing an up SQL file/);
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

test("defaultChecksum is stable for the same SQL input", () => {
  assert.equal(defaultChecksum("SELECT 1;"), defaultChecksum("SELECT 1;"));
  assert.notEqual(defaultChecksum("SELECT 1;"), defaultChecksum("SELECT 2;"));
});

test("CLI helpers parse arguments and normalize names", () => {
  assert.deepEqual(parseArgs(["create", "users", "--dir", "db", "--flag"]), {
    command: "create",
    positional: ["users"],
    options: {
      dir: "db",
      flag: true,
    },
  });
  assert.equal(toMigrationSlug(" Create Users Table "), "create_users_table");
  assert.equal(toMigrationSlug("!!!"), "");
  assert.equal(toTimestamp(new Date(2026, 2, 22, 12, 34, 56)), "20260322123456");
  assert.equal(
    resolveDirectory("/tmp/project", undefined),
    path.resolve("/tmp/project", "src/database/migrations"),
  );
});

test("index exports expose the public API surface", () => {
  assert.equal(typeof packageExports.defineMigrations, "function");
  assert.equal(typeof packageExports.CliError, "function");
  assert.equal(typeof packageExports.createMigration, "function");
  assert.equal(typeof packageExports.generateManifest, "function");
  assert.equal(typeof packageExports.groupMigrationFiles, "function");
  assert.equal(typeof packageExports.parseArgs, "function");
  assert.equal(typeof packageExports.printHelp, "function");
  assert.equal(typeof packageExports.resolveDirectory, "function");
  assert.equal(typeof packageExports.runCli, "function");
  assert.equal(typeof packageExports.toMigrationSlug, "function");
  assert.equal(typeof packageExports.toTimestamp, "function");
  assert.equal(typeof packageExports.validateMigrations, "function");
  assert.equal(typeof packageExports.MigrationRunner, "function");
  assert.equal(typeof packageExports.splitSqlStatements, "function");
  assert.equal(typeof packageExports.MigrationError, "function");
});

test("CLI helpers print help and group migration files", () => {
  const capture = createIoCapture();
  printHelp(capture.io);
  assert.match(capture.stdout.join(""), /Commands:/);

  const groups = groupMigrationFiles([
    "20260322090000_users.up.sql",
    "20260322090000_users.down.sql",
    "not-a-migration.sql",
  ]);
  assert.deepEqual([...groups.entries()], [
    [
      "20260322090000_users",
      {
        up: "20260322090000_users.up.sql",
        down: "20260322090000_users.down.sql",
      },
    ],
  ]);
});

test("validateMigrations succeeds for a missing directory with zero migrations", () => {
  const capture = createIoCapture();
  const missingDirectory = path.join(
    createCliTempDirectory("rn-sqlite-migrations-missing-"),
    "missing-subdir",
  );

  validateMigrations({
    cwd: "/tmp",
    io: capture.io,
    options: {
      dir: missingDirectory,
    },
  });

  assert.match(capture.stdout.join(""), /Validated 0 migrations/);
});

test("validateMigrations reports unsorted migration file names", { concurrency: false }, () => {
  const tempDirectory = createCliTempDirectory("rn-sqlite-migrations-unsorted-");
  const capture = createIoCapture();

  fs.writeFileSync(
    path.join(tempDirectory, "20260322150000_b_table.up.sql"),
    "-- up\n",
  );
  fs.writeFileSync(
    path.join(tempDirectory, "20260322150000_b_table.down.sql"),
    "-- down\n",
  );
  fs.writeFileSync(
    path.join(tempDirectory, "20260322140000_a_table.up.sql"),
    "-- up\n",
  );
  fs.writeFileSync(
    path.join(tempDirectory, "20260322140000_a_table.down.sql"),
    "-- down\n",
  );

  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = () => [
    "20260322150000_b_table.up.sql",
    "20260322150000_b_table.down.sql",
    "20260322140000_a_table.up.sql",
    "20260322140000_a_table.down.sql",
  ];

  try {
    assert.throws(() => {
      validateMigrations({
        cwd: "/tmp",
        io: capture.io,
        options: {
          dir: tempDirectory,
        },
      });
    }, /not ordered lexicographically/);
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
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
        "202603210001_create_users.up.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT);",
        "202603210001_create_users.down.sql": "DROP TABLE users;",
        "202603210002_split_full_name.up.sql":
          "ALTER TABLE users ADD COLUMN first_name TEXT; ALTER TABLE users ADD COLUMN last_name TEXT;",
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

test("MigrationRunner returns an empty rollback plan when there is no batch", async () => {
  const db = new FakeSqliteExecutor();
  const runner = new MigrationRunner({
    db,
    catalog: defineMigrations({
      directory: "db/migrations",
      migrations: [],
    }),
    readSqlFile: async () => "SELECT 1;",
  });

  const plan = await runner.planRollbackLastBatch();
  assert.deepEqual(plan, []);
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

test("MigrationRunner throws if rollback loop cannot find a catalog migration", async () => {
  class UnsafeRollbackRunner extends MigrationRunner {
    async planRollbackLastBatch() {
      return [
        {
          name: "202603210999_missing_at_runtime",
          batch: 9,
          reversible: true,
        },
      ];
    }
  }

  const db = new FakeSqliteExecutor();
  db.migrationRecords = [
    {
      name: "202603210999_missing_at_runtime",
      batch: 9,
      applied_at: "2026-03-21T00:00:00.000Z",
    },
  ];

  const runner = new UnsafeRollbackRunner({
    db,
    catalog: defineMigrations({
      directory: "db/migrations",
      migrations: [],
    }),
    readSqlFile: async () => "SELECT 1;",
  });

  await assert.rejects(
    () => runner.rollbackLastBatch(),
    /because it is not present in the catalog/,
  );
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

test("MigrationRunner can compute status without a logger", async () => {
  const db = new FakeSqliteExecutor();
  const runner = new MigrationRunner({
    db,
    catalog: defineMigrations({
      directory: "db/migrations",
      migrations: [
        {
          name: "202603210100_status_without_logger",
          sql: {
            up: "202603210100_status_without_logger.up.sql",
          },
        },
      ],
    }),
    readSqlFile: async () => "SELECT 1;",
  });

  const status = await runner.status();
  assert.equal(status.applied.length, 0);
  assert.equal(status.pending.length, 1);
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

test("MigrationRunner healthCheck reports checksum mismatches", async () => {
  const db = new FakeSqliteExecutor();
  db.migrationRecords = [
    {
      name: "202603210050_users",
      batch: 1,
      applied_at: "2026-03-21T00:00:00.000Z",
      up_checksum: "old-checksum",
      source_directory: "db/migrations",
    },
  ];

  const runner = new MigrationRunner({
    db,
    catalog: defineMigrations({
      directory: "db/migrations",
      migrations: [
        {
          name: "202603210050_users",
          sql: {
            up: "202603210050_users.up.sql",
            down: "202603210050_users.down.sql",
          },
        },
      ],
    }),
    readSqlFile: async () => "CREATE TABLE users (id INTEGER PRIMARY KEY);",
  });

  const report = await runner.healthCheck();

  assert.equal(report.ok, false);
  assert.equal(report.issues[0].reason, "checksum-mismatch");
});

test("MigrationRunner strict integrity mode blocks migrate when health check fails", async () => {
  const db = new FakeSqliteExecutor();
  db.migrationRecords = [
    {
      name: "202603210060_users",
      batch: 1,
      applied_at: "2026-03-21T00:00:00.000Z",
      up_checksum: "old-checksum",
      source_directory: "db/migrations",
    },
  ];

  const runner = new MigrationRunner({
    db,
    integrityMode: "strict",
    catalog: defineMigrations({
      directory: "db/migrations",
      migrations: [
        {
          name: "202603210060_users",
          sql: {
            up: "202603210060_users.up.sql",
            down: "202603210060_users.down.sql",
          },
        },
      ],
    }),
    readSqlFile: async () => "CREATE TABLE users (id INTEGER PRIMARY KEY);",
  });

  await assert.rejects(() => runner.migrate(), /integrity check failed/);
});

test("CLI createMigration, validateMigrations, and generateManifest work directly", () => {
  const tempDirectory = createCliTempDirectory();
  const capture = createIoCapture();

  createMigration({
    cwd: "/tmp",
    io: capture.io,
    name: "create_users",
    options: {
      dir: tempDirectory,
      timestamp: "20260322090000",
    },
    templatesDirectory: path.resolve(__dirname, "..", "templates"),
  });

  assert.match(capture.stdout.join(""), /20260322090000_create_users\.up\.sql/);
  assert.equal(
    fs.existsSync(path.join(tempDirectory, "20260322090000_create_users.up.sql")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(tempDirectory, "20260322090000_create_users.down.sql")),
    true,
  );

  validateMigrations({
    cwd: "/tmp",
    io: capture.io,
    options: {
      dir: tempDirectory,
    },
  });
  assert.match(capture.stdout.join(""), /Validated 1 migrations/);

  const manifestPath = path.join(tempDirectory, "manifest.generated.json");
  generateManifest({
    cwd: "/tmp",
    io: capture.io,
    options: {
      dir: tempDirectory,
      out: manifestPath,
    },
  });

  assert.match(capture.stdout.join(""), /Generated manifest/);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest, {
    "20260322090000_create_users": {
      up: "20260322090000_create_users.up.sql",
      down: "20260322090000_create_users.down.sql",
    },
  });
});

test("runCli executes help and unknown command paths", () => {
  const helpCapture = createIoCapture();
  const helpExitCode = runCli({
    argv: [],
    cwd: "/tmp",
    io: helpCapture.io,
    templatesDirectory: path.resolve(__dirname, "..", "templates"),
  });

  assert.equal(helpExitCode, 0);
  assert.match(helpCapture.stdout.join(""), /Commands:/);

  const failureCapture = createIoCapture();
  const failureExitCode = runCli({
    argv: ["unknown-command"],
    cwd: "/tmp",
    io: failureCapture.io,
    templatesDirectory: path.resolve(__dirname, "..", "templates"),
  });

  assert.equal(failureExitCode, 1);
  assert.match(failureCapture.stderr.join(""), /Unknown command/);
});

test("CLI rejects missing migration names and duplicate creates", () => {
  const tempDirectory = createCliTempDirectory("rn-sqlite-migrations-cli-duplicate-");
  const capture = createIoCapture();

  assert.throws(() => {
    createMigration({
      cwd: "/tmp",
      io: capture.io,
      name: undefined,
      options: {},
      templatesDirectory: path.resolve(__dirname, "..", "templates"),
    });
  }, /Please provide a migration name/);

  createMigration({
    cwd: "/tmp",
    io: capture.io,
    name: "create_users",
    options: {
      dir: tempDirectory,
      timestamp: "20260322101010",
    },
    templatesDirectory: path.resolve(__dirname, "..", "templates"),
  });

  assert.throws(() => {
    createMigration({
      cwd: "/tmp",
      io: capture.io,
      name: "create_users",
      options: {
        dir: tempDirectory,
        timestamp: "20260322101010",
      },
      templatesDirectory: path.resolve(__dirname, "..", "templates"),
    });
  }, /already exists/);

  assert.throws(() => {
    createMigration({
      cwd: "/tmp",
      io: capture.io,
      name: "!!!",
      options: {
        dir: tempDirectory,
      },
      templatesDirectory: path.resolve(__dirname, "..", "templates"),
    });
  }, /empty slug/);
});

test("CLI validate reports invalid file names and missing down files", () => {
  const tempDirectory = createCliTempDirectory("rn-sqlite-migrations-cli-invalid-");
  const capture = createIoCapture();

  fs.writeFileSync(
    path.join(tempDirectory, "bad-name.sql"),
    "-- invalid file name for validation\n",
  );
  fs.writeFileSync(
    path.join(tempDirectory, "20260322111111_only_up.up.sql"),
    "-- valid up file without matching down\n",
  );

  assert.throws(() => {
    validateMigrations({
      cwd: "/tmp",
      io: capture.io,
      options: {
        dir: tempDirectory,
      },
    });
  }, /Invalid migration file name|missing a \.down\.sql file/);
});

test("CLI validate reports a missing up SQL file", () => {
  const tempDirectory = createCliTempDirectory("rn-sqlite-migrations-cli-missing-up-");
  const capture = createIoCapture();

  fs.writeFileSync(
    path.join(tempDirectory, "20260322131313_only_down.down.sql"),
    "-- valid down file without matching up\n",
  );

  assert.throws(() => {
    validateMigrations({
      cwd: "/tmp",
      io: capture.io,
      options: {
        dir: tempDirectory,
      },
    });
  }, /missing an \.up\.sql file/);
});

test("runCli wraps create, validate, and manifest without child processes", () => {
  const tempDirectory = createCliTempDirectory("rn-sqlite-migrations-cli-runtime-");
  const capture = createIoCapture();
  const templatesDirectory = path.resolve(__dirname, "..", "templates");

  assert.equal(
    runCli({
      argv: ["create", "runtime_users", "--dir", tempDirectory, "--timestamp", "20260322121212"],
      cwd: "/tmp",
      io: capture.io,
      templatesDirectory,
    }),
    0,
  );
  assert.equal(
    runCli({
      argv: ["validate", "--dir", tempDirectory],
      cwd: "/tmp",
      io: capture.io,
      templatesDirectory,
    }),
    0,
  );
  assert.equal(
    runCli({
      argv: ["manifest", "--dir", tempDirectory, "--out", path.join(tempDirectory, "manifest.json")],
      cwd: "/tmp",
      io: capture.io,
      templatesDirectory,
    }),
    0,
  );
  assert.match(capture.stdout.join(""), /runtime_users/);
});

test("runCli reports create failures through stderr", () => {
  const capture = createIoCapture();
  const exitCode = runCli({
    argv: ["create"],
    cwd: "/tmp",
    io: capture.io,
    templatesDirectory: path.resolve(__dirname, "..", "templates"),
  });

  assert.equal(exitCode, 1);
  assert.match(capture.stderr.join(""), /Please provide a migration name/);
});

test("runCli rethrows unexpected non-CliError failures", () => {
  const capture = createIoCapture();

  assert.throws(() => {
    runCli({
      argv: ["create", "users"],
      cwd: "/tmp",
      io: capture.io,
      templatesDirectory: path.join("/tmp", "missing-templates-directory"),
    });
  });
});

test("CliError stores exit codes", () => {
  const error = new CliError("failure", 9);
  assert.equal(error.exitCode, 9);
});

test("createStaticSqlLoader and createAssetSqlLoader resolve SQL contents", async () => {
  const staticLoader = createStaticSqlLoader({
    "db/migrations/202603220001_users.up.sql": "SELECT 1;",
  });
  const assetLoader = createAssetSqlLoader(
    {
      "db/migrations/202603220001_users.up.sql": "asset://users-up",
    },
    async (assetReference) => `loaded:${assetReference}`,
  );

  assert.equal(
    await staticLoader({
      directory: "db/migrations",
      path: "202603220001_users.up.sql",
    }),
    "SELECT 1;",
  );
  assert.equal(
    await assetLoader({
      directory: "db/migrations",
      path: "202603220001_users.up.sql",
    }),
    "loaded:asset://users-up",
  );
});

test("createExpoSqliteExecutor adapts expo-like database objects", async () => {
  const calls = [];
  const executor = createExpoSqliteExecutor({
    async execAsync(sql) {
      calls.push(["execAsync", sql]);
    },
    async getAllAsync(sql, params) {
      calls.push(["getAllAsync", sql, params]);
      return [{ id: 1 }];
    },
    async runAsync(sql, ...params) {
      calls.push(["runAsync", sql, params]);
    },
    async withTransactionAsync(callback) {
      calls.push(["withTransactionAsync"]);
      return callback();
    },
  });

  await executor.execute({ sql: "INSERT INTO users VALUES (?)", params: [1] });
  const rows = await executor.query({ sql: "SELECT id FROM users", params: [] });
  await executor.withTransaction(async () => undefined);

  assert.equal(rows[0].id, 1);
  assert.deepEqual(calls[0], ["runAsync", "INSERT INTO users VALUES (?)", [1]]);
  assert.deepEqual(calls[1], ["getAllAsync", "SELECT id FROM users", []]);
  assert.deepEqual(calls[2], ["withTransactionAsync"]);
});

test("createQuickSqliteExecutor adapts quick-sqlite-like database objects", async () => {
  const calls = [];
  const executor = createQuickSqliteExecutor({
    async executeAsync(sql, params) {
      calls.push(["executeAsync", sql, params]);
      return {
        rows: {
          _array: [{ id: 2 }],
        },
      };
    },
    async transaction(callback) {
      calls.push(["transaction"]);
      return callback({
        async executeAsync() {
          return { rows: { _array: [] } };
        },
      });
    },
  });

  await executor.execute({ sql: "INSERT INTO users VALUES (?)", params: [2] });
  const rows = await executor.query({ sql: "SELECT id FROM users", params: [] });
  await executor.withTransaction(async () => undefined);

  assert.equal(rows[0].id, 2);
  assert.deepEqual(calls[0], ["executeAsync", "INSERT INTO users VALUES (?)", [2]]);
  assert.deepEqual(calls[1], ["executeAsync", "SELECT id FROM users", []]);
  assert.deepEqual(calls[2], ["transaction"]);
});
