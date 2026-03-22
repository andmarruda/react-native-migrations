"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createQuickSqliteExecutor = createQuickSqliteExecutor;
function toRows(rows) {
    if (!rows) {
        return [];
    }
    if (Array.isArray(rows._array)) {
        return rows._array;
    }
    if (typeof rows.item === "function" && typeof rows.length === "number") {
        const collected = [];
        for (let index = 0; index < rows.length; index += 1) {
            collected.push(rows.item(index));
        }
        return collected;
    }
    return [];
}
function toParams(params) {
    return params ?? [];
}
function createQuickSqliteExecutor(database) {
    return {
        async execute(statement) {
            await database.executeAsync(statement.sql, toParams(statement.params));
        },
        async query(statement) {
            const result = await database.executeAsync(statement.sql, toParams(statement.params));
            return toRows(result.rows);
        },
        async withTransaction(callback) {
            return database.transaction(async () => callback());
        },
    };
}
