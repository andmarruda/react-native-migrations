import { createQuickSqliteExecutor } from "../src";

declare const quickSqliteDatabase: {
  executeAsync<T>(sql: string, params?: unknown[]): Promise<{
    rows?: {
      _array?: T[];
      item?(index: number): T;
      length?: number;
    };
  }>;
  transaction<T>(
    callback: (tx: {
      executeAsync<R>(sql: string, params?: unknown[]): Promise<{
        rows?: {
          _array?: R[];
          item?(index: number): R;
          length?: number;
        };
      }>;
    }) => Promise<T>,
  ): Promise<T>;
};

export const sqliteExecutor = createQuickSqliteExecutor(quickSqliteDatabase);
