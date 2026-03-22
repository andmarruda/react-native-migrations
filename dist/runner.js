"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MigrationRunner = void 0;
const checksum_1 = require("./checksum");
const sql_1 = require("./sql");
const types_1 = require("./types");
const DEFAULT_TABLE_NAME = "__rn_sqlite_migrations";
function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, "\"\"")}"`;
}
class MigrationRunner {
    constructor(options) {
        this.db = options.db;
        this.catalog = options.catalog;
        this.readSqlFile = options.readSqlFile;
        this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
        this.now = options.now ?? (() => new Date().toISOString());
        this.logger = options.logger;
        this.calculateChecksum = options.calculateChecksum ?? checksum_1.defaultChecksum;
        this.integrityMode = options.integrityMode ?? "warn";
    }
    async migrate() {
        await this.ensureRepository();
        await this.assertIntegrity("migrate");
        const applied = await this.getAppliedMigrations();
        const appliedNames = new Set(applied.map((migration) => migration.name));
        const pending = this.catalog.migrations.filter((migration) => !appliedNames.has(migration.name));
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
        const executed = [];
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
                await this.runHook(migration, "beforeDestructive", batch, () => migration.beforeDestructive?.(context));
                await this.runHook(migration, "beforeUp", batch, () => migration.beforeUp?.(context));
                await this.runSqlText(migration, "up", migration.sql.up, batch, upSql);
                await this.runHook(migration, "afterUp", batch, () => migration.afterUp?.(context));
                await this.runPhase(migration, "record", batch, undefined, () => this.recordMigration(migration.name, batch, upChecksum));
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
    async rollbackLastBatch() {
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
            throw new types_1.MigrationError({
                message: `Cannot rollback migration "${blocked.name}" because it is marked as irreversible.`,
                phase: "down",
                migrationName: blocked.name,
                batch,
            });
        }
        const applied = await this.getAppliedMigrationsByBatch(batch);
        const catalogIndex = new Map(this.catalog.migrations.map((migration) => [migration.name, migration]));
        const rolledBack = [];
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
                throw new Error(`Cannot rollback migration "${record.name}" because it is not present in the catalog.`);
            }
            await this.db.withTransaction(async () => {
                const context = this.createContext(migration.name);
                await this.runHook(migration, "beforeDown", batch, () => migration.beforeDown?.(context));
                await this.runSqlFile(migration, "down", migration.sql.down, batch, context);
                await this.runHook(migration, "afterDown", batch, () => migration.afterDown?.(context));
                await this.runPhase(migration, "deleteRecord", batch, undefined, () => this.deleteMigrationRecord(migration.name));
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
    async planRollbackLastBatch() {
        await this.ensureRepository();
        const batch = await this.getLastBatchNumber();
        if (batch === 0) {
            return [];
        }
        const applied = await this.getAppliedMigrationsByBatch(batch);
        const catalogIndex = new Map(this.catalog.migrations.map((migration) => [migration.name, migration]));
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
    async status() {
        await this.ensureRepository();
        const applied = await this.getAppliedMigrations();
        const appliedNames = new Set(applied.map((migration) => migration.name));
        const result = {
            applied,
            pending: this.catalog.migrations.filter((migration) => !appliedNames.has(migration.name)),
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
    async healthCheck() {
        await this.ensureRepository();
        const applied = await this.getAppliedMigrations();
        const appliedNames = new Set(applied.map((migration) => migration.name));
        const issues = [];
        const catalogIndex = new Map(this.catalog.migrations.map((migration) => [migration.name, migration]));
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
            pendingCount: this.catalog.migrations.filter((migration) => !appliedNames.has(migration.name)).length,
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
        }
        else {
            for (const issue of report.issues) {
                await this.log({
                    type: "integrity:issue",
                    migrationName: issue.migrationName,
                    details: issue,
                });
            }
        }
        return report;
    }
    createContext(migrationName) {
        return {
            db: this.db,
            migrationName,
            sourceDirectory: this.catalog.directory,
            readSqlFile: (path) => this.readSqlFile({
                directory: this.catalog.directory,
                path,
            }),
            now: this.now,
        };
    }
    async ensureRepository() {
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
    async getAppliedMigrations() {
        const table = quoteIdentifier(this.tableName);
        const rows = await this.db.query({
            sql: `SELECT name, batch, applied_at, up_checksum, source_directory FROM ${table} ORDER BY name ASC`,
        });
        return rows;
    }
    async getAppliedMigrationsByBatch(batch) {
        const table = quoteIdentifier(this.tableName);
        const rows = await this.db.query({
            sql: `SELECT name, batch, applied_at, up_checksum, source_directory FROM ${table} WHERE batch = ? ORDER BY name ASC`,
            params: [batch],
        });
        return rows;
    }
    async getLastBatchNumber() {
        const table = quoteIdentifier(this.tableName);
        const rows = await this.db.query({
            sql: `SELECT MAX(batch) AS batch FROM ${table}`,
        });
        return Number(rows[0]?.batch ?? 0);
    }
    async recordMigration(name, batch, upChecksum) {
        const table = quoteIdentifier(this.tableName);
        await this.db.execute({
            sql: `INSERT INTO ${table} (name, batch, applied_at, up_checksum, source_directory) VALUES (?, ?, ?, ?, ?)`,
            params: [name, batch, this.now(), upChecksum, this.catalog.directory],
        });
    }
    async deleteMigrationRecord(name) {
        const table = quoteIdentifier(this.tableName);
        await this.db.execute({
            sql: `DELETE FROM ${table} WHERE name = ?`,
            params: [name],
        });
    }
    async ensureRepositoryColumn(name, type) {
        const table = quoteIdentifier(this.tableName);
        const rows = await this.db.query({
            sql: `PRAGMA table_info(${table})`,
        });
        const hasColumn = rows.some((row) => row?.name === name);
        if (!hasColumn) {
            await this.db.execute({
                sql: `ALTER TABLE ${table} ADD COLUMN ${quoteIdentifier(name)} ${type}`,
            });
        }
    }
    buildRollbackBlockReason(migration) {
        if (migration.metadata?.reversible === false) {
            return "migration-marked-as-irreversible";
        }
        if (!migration.sql.down) {
            return "missing-down-sql-file";
        }
        return "rollback-not-available";
    }
    async runRepositoryPhase(action) {
        try {
            await action();
        }
        catch (error) {
            throw new types_1.MigrationError({
                message: `Failed during repository setup for table "${this.tableName}".`,
                phase: "repository",
                cause: error,
            });
        }
    }
    async runHook(migration, phase, batch, action) {
        await this.runPhase(migration, phase, batch, undefined, async () => {
            await action();
        });
    }
    async runSqlFile(migration, phase, sqlFile, batch, context) {
        await this.runPhase(migration, phase, batch, sqlFile, async () => {
            const sql = await context.readSqlFile(sqlFile);
            await (0, sql_1.executeSqlBatch)(this.db, sql);
        });
    }
    async runSqlText(migration, phase, sqlFile, batch, sql) {
        await this.runPhase(migration, phase, batch, sqlFile, async () => {
            await (0, sql_1.executeSqlBatch)(this.db, sql);
        });
    }
    async runPhase(migration, phase, batch, sqlFile, action) {
        await this.log({
            type: "migration:phase:start",
            migrationName: migration.name,
            batch,
            phase,
            details: sqlFile ? { sqlFile } : undefined,
        });
        try {
            await action();
        }
        catch (error) {
            throw new types_1.MigrationError({
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
    buildPhaseErrorMessage(migrationName, phase, sqlFile, batch) {
        const parts = [`Migration "${migrationName}" failed during phase "${phase}"`];
        if (sqlFile) {
            parts.push(`using SQL file "${sqlFile}"`);
        }
        if (batch !== null) {
            parts.push(`in batch ${batch}`);
        }
        return `${parts.join(" ")}.`;
    }
    async log(event) {
        if (!this.logger) {
            return;
        }
        await this.logger.log({
            ...event,
            timestamp: this.now(),
        });
    }
    async assertIntegrity(phase) {
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
        throw new types_1.MigrationError({
            message: `Migration integrity check failed before "${phase}". Found ${report.issues.length} issue(s).`,
            phase: "repository",
        });
    }
}
exports.MigrationRunner = MigrationRunner;
