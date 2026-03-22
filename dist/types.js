"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MigrationError = void 0;
class MigrationError extends Error {
    constructor(input) {
        super(input.message);
        this.name = "MigrationError";
        this.phase = input.phase;
        this.migrationName = input.migrationName;
        this.sqlFile = input.sqlFile;
        this.batch = input.batch;
        if (input.cause !== undefined) {
            this.cause = input.cause;
        }
    }
}
exports.MigrationError = MigrationError;
