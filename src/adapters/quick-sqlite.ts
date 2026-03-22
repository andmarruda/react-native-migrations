import type { QueryResultRow, SqlStatement, SqliteExecutor } from "../types";

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

function toRows<T = QueryResultRow>(rows?: QuickRowsLike<T>) {
  if (!rows) {
    return [];
  }

  if (Array.isArray(rows._array)) {
    return rows._array;
  }

  if (typeof rows.item === "function" && typeof rows.length === "number") {
    const collected: T[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      collected.push(rows.item(index));
    }

    return collected;
  }

  return [];
}

function toParams(params?: SqlStatement["params"]) {
  return params ?? [];
}

export function createQuickSqliteExecutor(database: QuickSqliteDatabaseLike): SqliteExecutor {
  return {
    async execute(statement) {
      await database.executeAsync(statement.sql, toParams(statement.params));
    },
    async query<T = QueryResultRow>(statement: SqlStatement) {
      const result = await database.executeAsync<T>(statement.sql, toParams(statement.params));
      return toRows<T>(result.rows as QuickRowsLike<T> | undefined);
    },
    async withTransaction(callback) {
      return database.transaction(async () => callback());
    },
  };
}
