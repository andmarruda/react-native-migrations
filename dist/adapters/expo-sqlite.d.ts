import type { SqliteExecutor } from "../types";
interface ExpoSqliteDatabaseLike {
    execAsync(sql: string): Promise<unknown>;
    getAllAsync<T>(sql: string, params?: unknown[] | undefined): Promise<T[]>;
    runAsync?(sql: string, ...params: unknown[]): Promise<unknown>;
    withTransactionAsync<T>(callback: () => Promise<T>): Promise<T>;
}
export declare function createExpoSqliteExecutor(database: ExpoSqliteDatabaseLike): SqliteExecutor;
export {};
