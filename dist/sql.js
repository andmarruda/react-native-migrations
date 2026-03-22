"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitSqlStatements = splitSqlStatements;
exports.executeSqlBatch = executeSqlBatch;
function normalizeSql(sql) {
    return sql
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.replace(/--.*$/g, "").trimEnd())
        .join("\n");
}
function splitSqlStatements(sql) {
    const normalized = normalizeSql(sql);
    const statements = [];
    let current = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];
        const previousChar = normalized[index - 1];
        if (char === "'" && previousChar !== "\\" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
        }
        else if (char === '"' && previousChar !== "\\" && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
        }
        if (char === ";" && !inSingleQuote && !inDoubleQuote) {
            const statement = current.trim();
            if (statement) {
                statements.push(statement);
            }
            current = "";
            continue;
        }
        current += char;
    }
    const trailingStatement = current.trim();
    if (trailingStatement) {
        statements.push(trailingStatement);
    }
    return statements;
}
async function executeSqlBatch(db, sql) {
    const statements = splitSqlStatements(sql);
    for (const statement of statements) {
        await db.execute({ sql: statement });
    }
}
