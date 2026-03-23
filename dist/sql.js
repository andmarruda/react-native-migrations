"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitSqlStatements = splitSqlStatements;
exports.executeSqlBatch = executeSqlBatch;
function normalizeSql(sql) {
    return sql.replace(/\r\n/g, "\n");
}
function splitSqlStatements(sql) {
    const normalized = normalizeSql(sql);
    const statements = [];
    let current = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];
        const nextChar = normalized[index + 1];
        const previousChar = normalized[index - 1];
        if (inLineComment) {
            if (char === "\n") {
                inLineComment = false;
                current += char;
            }
            continue;
        }
        if (inBlockComment) {
            if (char === "*" && nextChar === "/") {
                inBlockComment = false;
                index += 1;
            }
            continue;
        }
        if (char === "'" && previousChar !== "\\" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
        }
        else if (char === '"' && previousChar !== "\\" && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
        }
        if (!inSingleQuote && !inDoubleQuote) {
            if (char === "-" && nextChar === "-") {
                inLineComment = true;
                index += 1;
                continue;
            }
            if (char === "/" && nextChar === "*") {
                inBlockComment = true;
                index += 1;
                continue;
            }
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
