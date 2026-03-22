import { defaultChecksum } from "./checksum";
import { executeSqlBatch } from "./sql";
import type {
  AppliedMigration,
  MigrationContext,
  MigrationDefinition,
  MigrationHealthIssue,
  MigrationHealthReport,
  MigrationExecutionResult,
  MigrationLogEvent,
  MigrationPhase,
  MigrationRunnerOptions,
  RollbackPlanItem,
  RollbackExecutionResult,
} from "./types";
import { MigrationError as RuntimeMigrationError } from "./types";

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
  private readonly logger: MigrationRunnerOptions["logger"];
  private readonly calculateChecksum: NonNullable<MigrationRunnerOptions["calculateChecksum"]>;
  private readonly integrityMode: NonNullable<MigrationRunnerOptions["integrityMode"]>;

  constructor(options: MigrationRunnerOptions) {
    this.db = options.db;
    this.catalog = options.catalog;
    this.readSqlFile = options.readSqlFile;
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.now = options.now ?? (() => new Date().toISOString());
    this.logger = options.logger;
    this.calculateChecksum = options.calculateChecksum ?? defaultChecksum;
    this.integrityMode = options.integrityMode ?? "warn";
  }

  async migrate(): Promise<MigrationExecutionResult> {
    await this.ensureRepository();
    await this.assertIntegrity("migrate");
    const applied = await this.getAppliedMigrations();
    const appliedNames = new Set(applied.map((migration) => migration.name));
    const pending = this.catalog.migrations.filter(
      (migration) => !appliedNames.has(migration.name),
    );

    if (pending.length === 0) {
      await this.log({
        type: "migration:skipped",
        batch: null,
        details: {
          reason: "no-pending-migrations",
        },
      });
      return {
        executed: [],
        skipped: this.catalog.migrations.map((migration) => migration.name),
        batch: null,
      };
    }

    const batch = (await this.getLastBatchNumber()) + 1;
    const executed: string[] = [];

    for (const migration of pending) {
      await this.log({
        type: "migration:start",
        migrationName: migration.name,
        batch,
      });

      await this.db.withTransaction(async () => {
        const context = this.createContext(migration.name);
        const upSql = await context.readSqlFile(migration.sql.up);
        const upChecksum = this.calculateChecksum(upSql);
        await this.runHook(migration, "beforeDestructive", batch, () =>
          migration.beforeDestructive?.(context),
        );
        await this.runHook(migration, "beforeUp", batch, () => migration.beforeUp?.(context));
        await this.runSqlText(migration, "up", migration.sql.up, batch, upSql);
        await this.runHook(migration, "afterUp", batch, () => migration.afterUp?.(context));
        await this.runPhase(
          migration,
          "record",
          batch,
          undefined,
          () => this.recordMigration(migration.name, batch, upChecksum),
        );
      });

      executed.push(migration.name);
      await this.log({
        type: "migration:complete",
        migrationName: migration.name,
        batch,
      });
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
    await this.assertIntegrity("rollback");
    const batch = await this.getLastBatchNumber();

    if (batch === 0) {
      await this.log({
        type: "rollback:empty",
        batch: null,
      });
      return {
        rolledBack: [],
        batch: null,
      };
    }

    const plan = await this.planRollbackLastBatch();
    const blocked = plan.find((item) => !item.reversible);
    if (blocked) {
      throw new RuntimeMigrationError({
        message: `Cannot rollback migration "${blocked.name}" because it is marked as irreversible.`,
        phase: "down",
        migrationName: blocked.name,
        batch,
      });
    }

    const applied = await this.getAppliedMigrationsByBatch(batch);
    const catalogIndex = new Map(
      this.catalog.migrations.map((migration) => [migration.name, migration]),
    );
    const rolledBack: string[] = [];

    await this.log({
      type: "rollback:start",
      batch,
      details: {
        migrations: applied.map((record) => record.name),
      },
    });

    for (const record of applied.reverse()) {
      const migration = catalogIndex.get(record.name);

      if (!migration) {
        throw new Error(
          `Cannot rollback migration "${record.name}" because it is not present in the catalog.`,
        );
      }

      await this.db.withTransaction(async () => {
        const context = this.createContext(migration.name);
        await this.runHook(migration, "beforeDown", batch, () => migration.beforeDown?.(context));
        await this.runSqlFile(migration, "down", migration.sql.down!, batch, context);
        await this.runHook(migration, "afterDown", batch, () => migration.afterDown?.(context));
        await this.runPhase(
          migration,
          "deleteRecord",
          batch,
          undefined,
          () => this.deleteMigrationRecord(migration.name),
        );
      });

      rolledBack.push(migration.name);
    }

    await this.log({
      type: "rollback:complete",
      batch,
      details: {
        rolledBack,
      },
    });

    return {
      rolledBack,
      batch,
    };
  }

  async planRollbackLastBatch(): Promise<RollbackPlanItem[]> {
    await this.ensureRepository();
    const batch = await this.getLastBatchNumber();

    if (batch === 0) {
      return [];
    }

    const applied = await this.getAppliedMigrationsByBatch(batch);
    const catalogIndex = new Map(
      this.catalog.migrations.map((migration) => [migration.name, migration]),
    );

    return applied
      .slice()
      .reverse()
      .map((record) => {
        const migration = catalogIndex.get(record.name);

        if (!migration) {
          return {
            name: record.name,
            batch,
            reversible: false,
            reason: "migration-missing-from-catalog",
          };
        }

        const reversible = migration.metadata?.reversible !== false && Boolean(migration.sql.down);
        return {
          name: record.name,
          batch,
          reversible,
          reason: reversible ? undefined : this.buildRollbackBlockReason(migration),
        };
      });
  }

  async status(): Promise<{
    applied: AppliedMigration[];
    pending: MigrationDefinition[];
  }> {
    await this.ensureRepository();
    const applied = await this.getAppliedMigrations();
    const appliedNames = new Set(applied.map((migration) => migration.name));

    const result = {
      applied,
      pending: this.catalog.migrations.filter(
        (migration) => !appliedNames.has(migration.name),
      ),
    };

    await this.log({
      type: "status:checked",
      batch: await this.getLastBatchNumber(),
      details: {
        applied: result.applied.length,
        pending: result.pending.length,
      },
    });

    return result;
  }

  async healthCheck(): Promise<MigrationHealthReport> {
    await this.ensureRepository();
    const applied = await this.getAppliedMigrations();
    const appliedNames = new Set(applied.map((migration) => migration.name));
    const issues: MigrationHealthIssue[] = [];
    const catalogIndex = new Map(
      this.catalog.migrations.map((migration) => [migration.name, migration]),
    );

    for (const record of applied) {
      const migration = catalogIndex.get(record.name);

      if (!migration) {
        issues.push({
          migrationName: record.name,
          reason: "missing-from-catalog",
          details: "The applied migration is not present in the current catalog.",
        });
        continue;
      }

      const sql = await this.readSqlFile({
        directory: this.catalog.directory,
        path: migration.sql.up,
      });
      const actualChecksum = this.calculateChecksum(sql);
      const expectedChecksum = record.up_checksum ?? null;

      if (expectedChecksum && expectedChecksum !== actualChecksum) {
        issues.push({
          migrationName: record.name,
          reason: "checksum-mismatch",
          expectedChecksum,
          actualChecksum,
          details: `The applied migration checksum does not match the current "${migration.sql.up}" contents.`,
        });
      }
    }

    const rollbackPlan = await this.planRollbackLastBatch();
    for (const item of rollbackPlan) {
      if (!item.reversible) {
        issues.push({
          migrationName: item.name,
          reason: "rollback-unavailable",
          details: item.reason,
        });
      }
    }

    const report = {
      appliedCount: applied.length,
      pendingCount: this.catalog.migrations.filter(
        (migration) => !appliedNames.has(migration.name),
      ).length,
      issues,
      ok: issues.length === 0,
    };

    if (report.ok) {
      await this.log({
        type: "integrity:passed",
        details: {
          appliedCount: report.appliedCount,
          pendingCount: report.pendingCount,
        },
      });
    } else {
      for (const issue of report.issues) {
        await this.log({
          type: "integrity:issue",
          migrationName: issue.migrationName,
          details: issue as unknown as Record<string, unknown>,
        });
      }
    }

    return report;
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

    await this.runRepositoryPhase(async () => {
      await this.db.execute({
        sql: `CREATE TABLE IF NOT EXISTS ${table} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          batch INTEGER NOT NULL,
          applied_at TEXT NOT NULL,
          up_checksum TEXT,
          source_directory TEXT
        )`,
      });
    });

    await this.ensureRepositoryColumn("up_checksum", "TEXT");
    await this.ensureRepositoryColumn("source_directory", "TEXT");

    await this.log({
      type: "repository:ensured",
      tableName: this.tableName,
    });
  }

  private async getAppliedMigrations(): Promise<AppliedMigration[]> {
    const table = quoteIdentifier(this.tableName);
    const rows = await this.db.query<AppliedMigration>({
      sql: `SELECT name, batch, applied_at, up_checksum, source_directory FROM ${table} ORDER BY name ASC`,
    });

    return rows;
  }

  private async getAppliedMigrationsByBatch(batch: number): Promise<AppliedMigration[]> {
    const table = quoteIdentifier(this.tableName);
    const rows = await this.db.query<AppliedMigration>({
      sql: `SELECT name, batch, applied_at, up_checksum, source_directory FROM ${table} WHERE batch = ? ORDER BY name ASC`,
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

  private async recordMigration(name: string, batch: number, upChecksum: string) {
    const table = quoteIdentifier(this.tableName);
    await this.db.execute({
      sql: `INSERT INTO ${table} (name, batch, applied_at, up_checksum, source_directory) VALUES (?, ?, ?, ?, ?)`,
      params: [name, batch, this.now(), upChecksum, this.catalog.directory],
    });
  }

  private async deleteMigrationRecord(name: string) {
    const table = quoteIdentifier(this.tableName);
    await this.db.execute({
      sql: `DELETE FROM ${table} WHERE name = ?`,
      params: [name],
    });
  }

  private async ensureRepositoryColumn(name: string, type: string) {
    const table = quoteIdentifier(this.tableName);
    const rows = await this.db.query<{ name?: string }>({
      sql: `PRAGMA table_info(${table})`,
    });
    const hasColumn = rows.some((row) => row?.name === name);

    if (!hasColumn) {
      await this.db.execute({
        sql: `ALTER TABLE ${table} ADD COLUMN ${quoteIdentifier(name)} ${type}`,
      });
    }
  }

  private buildRollbackBlockReason(migration: MigrationDefinition) {
    if (migration.metadata?.reversible === false) {
      return "migration-marked-as-irreversible";
    }

    if (!migration.sql.down) {
      return "missing-down-sql-file";
    }

    return "rollback-not-available";
  }

  private async runRepositoryPhase(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      throw new RuntimeMigrationError({
        message: `Failed during repository setup for table "${this.tableName}".`,
        phase: "repository",
        cause: error,
      });
    }
  }

  private async runHook(
    migration: MigrationDefinition,
    phase: Extract<MigrationPhase, "beforeDestructive" | "beforeUp" | "afterUp" | "beforeDown" | "afterDown">,
    batch: number | null,
    action: () => Promise<void> | void,
  ) {
    await this.runPhase(migration, phase, batch, undefined, async () => {
      await action();
    });
  }

  private async runSqlFile(
    migration: MigrationDefinition,
    phase: Extract<MigrationPhase, "up" | "down">,
    sqlFile: string,
    batch: number | null,
    context: MigrationContext,
  ) {
    await this.runPhase(migration, phase, batch, sqlFile, async () => {
      const sql = await context.readSqlFile(sqlFile);
      await executeSqlBatch(this.db, sql);
    });
  }

  private async runSqlText(
    migration: MigrationDefinition,
    phase: Extract<MigrationPhase, "up" | "down">,
    sqlFile: string,
    batch: number | null,
    sql: string,
  ) {
    await this.runPhase(migration, phase, batch, sqlFile, async () => {
      await executeSqlBatch(this.db, sql);
    });
  }

  private async runPhase(
    migration: MigrationDefinition,
    phase: MigrationPhase,
    batch: number | null,
    sqlFile: string | undefined,
    action: () => Promise<void>,
  ) {
    await this.log({
      type: "migration:phase:start",
      migrationName: migration.name,
      batch,
      phase,
      details: sqlFile ? { sqlFile } : undefined,
    });

    try {
      await action();
    } catch (error) {
      throw new RuntimeMigrationError({
        message: this.buildPhaseErrorMessage(migration.name, phase, sqlFile, batch),
        phase,
        migrationName: migration.name,
        sqlFile,
        batch,
        cause: error,
      });
    }

    await this.log({
      type: "migration:phase:complete",
      migrationName: migration.name,
      batch,
      phase,
      details: sqlFile ? { sqlFile } : undefined,
    });
  }

  private buildPhaseErrorMessage(
    migrationName: string,
    phase: MigrationPhase,
    sqlFile: string | undefined,
    batch: number | null,
  ) {
    const parts = [`Migration "${migrationName}" failed during phase "${phase}"`];

    if (sqlFile) {
      parts.push(`using SQL file "${sqlFile}"`);
    }

    if (batch !== null) {
      parts.push(`in batch ${batch}`);
    }

    return `${parts.join(" ")}.`;
  }

  private async log(event: Omit<MigrationLogEvent, "timestamp">) {
    if (!this.logger) {
      return;
    }

    await this.logger.log({
      ...event,
      timestamp: this.now(),
    });
  }

  private async assertIntegrity(phase: "migrate" | "rollback") {
    if (this.integrityMode === "off") {
      return;
    }

    const report = await this.healthCheck();
    if (report.ok) {
      return;
    }

    if (this.integrityMode === "warn") {
      return;
    }

    throw new RuntimeMigrationError({
      message: `Migration integrity check failed before "${phase}". Found ${report.issues.length} issue(s).`,
      phase: "repository",
    });
  }
}
