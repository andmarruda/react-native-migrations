import type { SqlStatement, SqliteExecutor } from "../types";

interface ExpoSqliteDatabaseLike {
  execAsync(sql: string): Promise<unknown>;
  getAllAsync<T>(sql: string, params?: unknown[] | undefined): Promise<T[]>;
  runAsync?(sql: string, ...params: unknown[]): Promise<unknown>;
  withTransactionAsync<T>(callback: () => Promise<T>): Promise<T>;
}

function toParams(params?: SqlStatement["params"]) {
  return params ?? [];
}

export function createExpoSqliteExecutor(database: ExpoSqliteDatabaseLike): SqliteExecutor {
  return {
    async execute(statement) {
      if (database.runAsync) {
        await database.runAsync(statement.sql, ...toParams(statement.params));
        return;
      }

      await database.execAsync(statement.sql);
    },
    async query(statement) {
      return database.getAllAsync(statement.sql, toParams(statement.params));
    },
    async withTransaction(callback) {
      return database.withTransactionAsync(callback);
    },
  };
}
