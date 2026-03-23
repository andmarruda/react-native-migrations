"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createExpoSqliteExecutor = createExpoSqliteExecutor;
function toParams(params) {
    return params ?? [];
}
function createExpoSqliteExecutor(database) {
    return {
        async execute(statement) {
            if (database.runAsync) {
                await database.runAsync(statement.sql, ...toParams(statement.params));
                return;
            }
            await database.execAsync(statement.sql, toParams(statement.params));
        },
        async query(statement) {
            return database.getAllAsync(statement.sql, toParams(statement.params));
        },
        async withTransaction(callback) {
            return database.withTransactionAsync(callback);
        },
    };
}
