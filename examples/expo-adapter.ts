import { createExpoSqliteExecutor } from "../src";

declare const expoDatabase: {
  execAsync(sql: string): Promise<unknown>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  runAsync?(sql: string, ...params: unknown[]): Promise<unknown>;
  withTransactionAsync<T>(callback: () => Promise<T>): Promise<T>;
};

export const sqliteExecutor = createExpoSqliteExecutor(expoDatabase);
