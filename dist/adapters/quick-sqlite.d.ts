import type { SqliteExecutor } from "../types";
interface QuickRowsLike<T> {
    _array?: T[];
    item?(index: number): T;
    length?: number;
}
interface QuickSqliteResult<T> {
    rows?: QuickRowsLike<T>;
}
interface QuickSqliteTransactionLike {
    executeAsync<T>(sql: string, params?: unknown[]): Promise<QuickSqliteResult<T>>;
}
interface QuickSqliteDatabaseLike {
    executeAsync<T>(sql: string, params?: unknown[]): Promise<QuickSqliteResult<T>>;
    transaction<T>(callback: (tx: QuickSqliteTransactionLike) => Promise<T>): Promise<T>;
}
export declare function createQuickSqliteExecutor(database: QuickSqliteDatabaseLike): SqliteExecutor;
export {};
