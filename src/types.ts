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

export interface SqlFileGroup {
  up: string;
  down?: string;
}

export interface MigrationDefinition {
  name: string;
  sql: SqlFileGroup;
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
