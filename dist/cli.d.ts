export interface CliIo {
    stderr(message: string): void;
    stdout(message: string): void;
}
export interface CliRuntimeOptions {
    argv: string[];
    cwd?: string;
    io: CliIo;
    templatesDirectory?: string;
}
export interface ParsedCliArgs {
    command?: string;
    options: Record<string, string | boolean>;
    positional: string[];
}
export declare class CliError extends Error {
    readonly exitCode: number;
    constructor(message: string, exitCode?: number);
}
export declare function parseArgs(argv: string[]): ParsedCliArgs;
export declare function toTimestamp(date?: Date): string;
export declare function toMigrationSlug(input: string): string;
export declare function resolveDirectory(cwd: string, input?: string): string;
export declare function ensureDirectory(directory: string): void;
export declare function listSqlFiles(directory: string): string[];
export declare function groupMigrationFiles(files: string[]): Map<string, {
    up?: string;
    down?: string;
}>;
export declare function printHelp(io: CliIo): void;
export declare function createMigration(input: {
    cwd: string;
    name?: string;
    options: Record<string, string | boolean>;
    templatesDirectory: string;
    io: CliIo;
}): void;
export declare function validateMigrations(input: {
    cwd: string;
    io: CliIo;
    options: Record<string, string | boolean>;
}): void;
export declare function generateManifest(input: {
    cwd: string;
    io: CliIo;
    options: Record<string, string | boolean>;
}): void;
export declare function runCli(options: CliRuntimeOptions): number;
