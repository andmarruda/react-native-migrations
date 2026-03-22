import type { SqliteExecutor } from "./types";
export declare function splitSqlStatements(sql: string): string[];
export declare function executeSqlBatch(db: SqliteExecutor, sql: string): Promise<void>;
