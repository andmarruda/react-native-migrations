import { executeSqlBatch } from "./sql";
import type {
  AppliedMigration,
  MigrationContext,
  MigrationDefinition,
  MigrationExecutionResult,
  MigrationRunnerOptions,
  RollbackExecutionResult,
} from "./types";

const DEFAULT_TABLE_NAME = "__rn_sqlite_migrations";

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

export class MigrationRunner {
  private readonly db: MigrationRunnerOptions["db"];
  private readonly catalog: MigrationRunnerOptions["catalog"];
  private readonly readSqlFile: MigrationRunnerOptions["readSqlFile"];
  private readonly tableName: string;
  private readonly now: () => string;

  constructor(options: MigrationRunnerOptions) {
    this.db = options.db;
    this.catalog = options.catalog;
    this.readSqlFile = options.readSqlFile;
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async migrate(): Promise<MigrationExecutionResult> {
    await this.ensureRepository();
    const applied = await this.getAppliedMigrations();
    const appliedNames = new Set(applied.map((migration) => migration.name));
    const pending = this.catalog.migrations.filter(
      (migration) => !appliedNames.has(migration.name),
    );

    if (pending.length === 0) {
      return {
        executed: [],
        skipped: this.catalog.migrations.map((migration) => migration.name),
        batch: null,
      };
    }

    const batch = (await this.getLastBatchNumber()) + 1;
    const executed: string[] = [];

    for (const migration of pending) {
      await this.db.withTransaction(async () => {
        const context = this.createContext(migration.name);
        await migration.beforeDestructive?.(context);
        await migration.beforeUp?.(context);
        await executeSqlBatch(this.db, await context.readSqlFile(migration.sql.up));
        await migration.afterUp?.(context);
        await this.recordMigration(migration.name, batch);
      });

      executed.push(migration.name);
    }

    return {
      executed,
      skipped: this.catalog.migrations
        .filter((migration) => !executed.includes(migration.name))
        .map((migration) => migration.name),
      batch,
    };
  }

  async rollbackLastBatch(): Promise<RollbackExecutionResult> {
    await this.ensureRepository();
    const batch = await this.getLastBatchNumber();

    if (batch === 0) {
      return {
        rolledBack: [],
        batch: null,
      };
    }

    const applied = await this.getAppliedMigrationsByBatch(batch);
    const catalogIndex = new Map(
      this.catalog.migrations.map((migration) => [migration.name, migration]),
    );
    const rolledBack: string[] = [];

    for (const record of applied.reverse()) {
      const migration = catalogIndex.get(record.name);

      if (!migration) {
        throw new Error(
          `Cannot rollback migration "${record.name}" because it is not present in the catalog.`,
        );
      }

      if (!migration.sql.down) {
        throw new Error(
          `Cannot rollback migration "${record.name}" because it does not define a down SQL file.`,
        );
      }

      await this.db.withTransaction(async () => {
        const context = this.createContext(migration.name);
        await migration.beforeDown?.(context);
        await executeSqlBatch(this.db, await context.readSqlFile(migration.sql.down!));
        await migration.afterDown?.(context);
        await this.deleteMigrationRecord(migration.name);
      });

      rolledBack.push(migration.name);
    }

    return {
      rolledBack,
      batch,
    };
  }

  async status(): Promise<{
    applied: AppliedMigration[];
    pending: MigrationDefinition[];
  }> {
    await this.ensureRepository();
    const applied = await this.getAppliedMigrations();
    const appliedNames = new Set(applied.map((migration) => migration.name));

    return {
      applied,
      pending: this.catalog.migrations.filter(
        (migration) => !appliedNames.has(migration.name),
      ),
    };
  }

  private createContext(migrationName: string): MigrationContext {
    return {
      db: this.db,
      migrationName,
      sourceDirectory: this.catalog.directory,
      readSqlFile: (path) =>
        this.readSqlFile({
          directory: this.catalog.directory,
          path,
        }),
      now: this.now,
    };
  }

  private async ensureRepository() {
    const table = quoteIdentifier(this.tableName);

    await this.db.execute({
      sql: `CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        batch INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    });
  }

  private async getAppliedMigrations(): Promise<AppliedMigration[]> {
    const table = quoteIdentifier(this.tableName);
    const rows = await this.db.query<AppliedMigration>({
      sql: `SELECT name, batch, applied_at FROM ${table} ORDER BY name ASC`,
    });

    return rows;
  }

  private async getAppliedMigrationsByBatch(batch: number): Promise<AppliedMigration[]> {
    const table = quoteIdentifier(this.tableName);
    const rows = await this.db.query<AppliedMigration>({
      sql: `SELECT name, batch, applied_at FROM ${table} WHERE batch = ? ORDER BY name ASC`,
      params: [batch],
    });

    return rows;
  }

  private async getLastBatchNumber(): Promise<number> {
    const table = quoteIdentifier(this.tableName);
    const rows = await this.db.query<{ batch: number | null }>({
      sql: `SELECT MAX(batch) AS batch FROM ${table}`,
    });

    return Number(rows[0]?.batch ?? 0);
  }

  private async recordMigration(name: string, batch: number) {
    const table = quoteIdentifier(this.tableName);
    await this.db.execute({
      sql: `INSERT INTO ${table} (name, batch, applied_at) VALUES (?, ?, ?)`,
      params: [name, batch, this.now()],
    });
  }

  private async deleteMigrationRecord(name: string) {
    const table = quoteIdentifier(this.tableName);
    await this.db.execute({
      sql: `DELETE FROM ${table} WHERE name = ?`,
      params: [name],
    });
  }
}
