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
    let activeTransaction;
    let transactionQueue = Promise.resolve();
    function getExecutor() {
        return activeTransaction ?? database;
    }
    return {
        async execute(statement) {
            await getExecutor().executeAsync(statement.sql, toParams(statement.params));
        },
        async query(statement) {
            const result = await getExecutor().executeAsync(statement.sql, toParams(statement.params));
            return toRows(result.rows);
        },
        async withTransaction(callback) {
            if (activeTransaction) {
                return callback();
            }
            const previousTransaction = transactionQueue;
            let releaseNextTransaction = () => undefined;
            transactionQueue = new Promise((resolve) => {
                releaseNextTransaction = resolve;
            });
            await previousTransaction;
            try {
                return await database.transaction(async (tx) => {
                    activeTransaction = tx;
                    try {
                        return await callback();
                    }
                    finally {
                        activeTransaction = undefined;
                    }
                });
            }
            finally {
                releaseNextTransaction();
            }
        },
    };
}
