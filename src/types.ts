export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface QueryResultRow {
  [key: string]: unknown;
}

export interface SqliteExecutor {
  execute(statement: SqlStatement): Promise<void>;
  query<T = QueryResultRow>(statement: SqlStatement): Promise<T[]>;
  withTransaction<T>(callback: () => Promise<T>): Promise<T>;
}

export interface MigrationRecord {
  name: string;
  batch: number;
  applied_at: string;
}

export interface MigrationContext {
  db: SqliteExecutor;
  migrationName: string;
  sourceDirectory: string;
  readSqlFile(path: string): Promise<string>;
  now(): string;
}

export type MigrationHook = (context: MigrationContext) => Promise<void>;

export type MigrationPhase =
  | "repository"
  | "beforeDestructive"
  | "beforeUp"
  | "up"
  | "afterUp"
  | "record"
  | "beforeDown"
  | "down"
  | "afterDown"
  | "deleteRecord"
  | "status";

export interface SqlFileGroup {
  up: string;
  down?: string;
}

export interface MigrationMetadata {
  description?: string;
  createdAt?: string;
  owner?: string;
  tags?: string[];
  reversible?: boolean;
}

export interface MigrationDefinition {
  name: string;
  sql: SqlFileGroup;
  metadata?: MigrationMetadata;
  beforeDestructive?: MigrationHook;
  beforeUp?: MigrationHook;
  afterUp?: MigrationHook;
  beforeDown?: MigrationHook;
  afterDown?: MigrationHook;
}

export interface MigrationCatalog {
  directory: string;
  migrations: MigrationDefinition[];
}

export interface MigrationRunnerOptions {
  db: SqliteExecutor;
  catalog: MigrationCatalog;
  readSqlFile(input: { directory: string; path: string }): Promise<string>;
  tableName?: string;
  now?: () => string;
  logger?: MigrationLogger;
}

export interface AppliedMigration extends MigrationRecord {}

export interface MigrationExecutionResult {
  executed: string[];
  skipped: string[];
  batch: number | null;
}

export interface RollbackExecutionResult {
  rolledBack: string[];
  batch: number | null;
}

export interface RollbackPlanItem {
  name: string;
  batch: number;
  reversible: boolean;
  reason?: string;
}

export interface MigrationLogEvent {
  type:
    | "repository:ensured"
    | "migration:start"
    | "migration:complete"
    | "migration:skipped"
    | "migration:phase:start"
    | "migration:phase:complete"
    | "rollback:start"
    | "rollback:complete"
    | "rollback:empty"
    | "status:checked";
  migrationName?: string;
  batch?: number | null;
  phase?: MigrationPhase;
  tableName?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface MigrationLogger {
  log(event: MigrationLogEvent): void | Promise<void>;
}

export class MigrationError extends Error {
  readonly migrationName?: string;
  readonly phase: MigrationPhase;
  readonly sqlFile?: string;
  readonly batch?: number | null;

  constructor(input: {
    message: string;
    phase: MigrationPhase;
    migrationName?: string;
    sqlFile?: string;
    batch?: number | null;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "MigrationError";
    this.phase = input.phase;
    this.migrationName = input.migrationName;
    this.sqlFile = input.sqlFile;
    this.batch = input.batch;

    if (input.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = input.cause;
    }
  }
}
