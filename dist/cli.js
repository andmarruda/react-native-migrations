"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CliError = void 0;
exports.parseArgs = parseArgs;
exports.toTimestamp = toTimestamp;
exports.toMigrationSlug = toMigrationSlug;
exports.resolveDirectory = resolveDirectory;
exports.ensureDirectory = ensureDirectory;
exports.listSqlFiles = listSqlFiles;
exports.groupMigrationFiles = groupMigrationFiles;
exports.printHelp = printHelp;
exports.createMigration = createMigration;
exports.validateMigrations = validateMigrations;
exports.generateManifest = generateManifest;
exports.runCli = runCli;
const fs = require("node:fs");
const path = require("node:path");
class CliError extends Error {
    constructor(message, exitCode = 1) {
        super(message);
        this.name = "CliError";
        this.exitCode = exitCode;
    }
}
exports.CliError = CliError;
function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = {};
    const positional = [];
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith("--")) {
            positional.push(token);
            continue;
        }
        const key = token.slice(2);
        const next = rest[index + 1];
        if (!next || next.startsWith("--")) {
            options[key] = true;
            continue;
        }
        options[key] = next;
        index += 1;
    }
    return {
        command,
        options,
        positional,
    };
}
function toTimestamp(date = new Date()) {
    const parts = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
        String(date.getHours()).padStart(2, "0"),
        String(date.getMinutes()).padStart(2, "0"),
        String(date.getSeconds()).padStart(2, "0"),
    ];
    return parts.join("");
}
function toMigrationSlug(input) {
    return input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}
function resolveDirectory(cwd, input) {
    return path.resolve(cwd, input || "src/database/migrations");
}
function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
}
function listSqlFiles(directory) {
    if (!fs.existsSync(directory)) {
        return [];
    }
    return fs.readdirSync(directory).filter((file) => file.endsWith(".sql"));
}
function groupMigrationFiles(files) {
    const groups = new Map();
    for (const file of files) {
        const match = file.match(/^(.*)\.(up|down)\.sql$/);
        if (!match) {
            continue;
        }
        const [, baseName, direction] = match;
        const group = groups.get(baseName) || {};
        group[direction] = file;
        groups.set(baseName, group);
    }
    return groups;
}
function printHelp(io) {
    io.stdout([
        "rn-sqlite-migrations",
        "",
        "Commands:",
        "  create <name> [--dir <path>] [--timestamp <yyyymmddHHMMSS>]",
        "  validate [--dir <path>]",
        "  manifest [--dir <path>] [--out <path>]",
    ].join("\n"));
}
function loadTemplate(templatesDirectory, fileName) {
    return fs.readFileSync(path.join(templatesDirectory, fileName), "utf8");
}
function readOption(options, key) {
    const value = options[key];
    return typeof value === "string" ? value : undefined;
}
function assertTimestampFormat(timestamp) {
    if (!/^\d{14}$/.test(timestamp)) {
        throw new CliError(`Invalid timestamp "${timestamp}". Use the format yyyymmddHHMMSS.`);
    }
}
function createMigration(input) {
    if (!input.name) {
        throw new CliError("Please provide a migration name. Example: rn-sqlite-migrations create split_full_name");
    }
    const directory = resolveDirectory(input.cwd, readOption(input.options, "dir"));
    const timestamp = readOption(input.options, "timestamp") || toTimestamp();
    const slug = toMigrationSlug(input.name);
    assertTimestampFormat(timestamp);
    if (!slug) {
        throw new CliError("The migration name produced an empty slug. Use letters or numbers in the name.");
    }
    ensureDirectory(directory);
    const baseName = `${timestamp}_${slug}`;
    const upPath = path.join(directory, `${baseName}.up.sql`);
    const downPath = path.join(directory, `${baseName}.down.sql`);
    if (fs.existsSync(upPath) || fs.existsSync(downPath)) {
        throw new CliError(`Migration "${baseName}" already exists in ${directory}.`);
    }
    const upTemplate = loadTemplate(input.templatesDirectory, "migration.up.sql").replace(/__MIGRATION_NAME__/g, baseName);
    const downTemplate = loadTemplate(input.templatesDirectory, "migration.down.sql").replace(/__MIGRATION_NAME__/g, baseName);
    fs.writeFileSync(upPath, upTemplate);
    fs.writeFileSync(downPath, downTemplate);
    input.io.stdout(`Created:\n- ${upPath}\n- ${downPath}\n`);
}
function validateMigrations(input) {
    const directory = resolveDirectory(input.cwd, readOption(input.options, "dir"));
    const files = listSqlFiles(directory);
    const groups = groupMigrationFiles(files);
    const errors = [];
    for (const file of files) {
        if (!/^\d{14}_[a-z0-9_]+\.(up|down)\.sql$/.test(file)) {
            errors.push(`Invalid migration file name: ${file}`);
        }
    }
    for (const [baseName, group] of groups.entries()) {
        if (!group.up) {
            errors.push(`Migration "${baseName}" is missing an .up.sql file.`);
        }
    }
    if (errors.length > 0) {
        throw new CliError(errors.join("\n"));
    }
    input.io.stdout(`Validated ${groups.size} migrations in ${directory}\n`);
}
function generateManifest(input) {
    const directory = resolveDirectory(input.cwd, readOption(input.options, "dir"));
    const output = path.resolve(input.cwd, readOption(input.options, "out") || path.join(directory, "manifest.generated.json"));
    const files = listSqlFiles(directory);
    const groups = groupMigrationFiles(files);
    const manifest = {};
    for (const [baseName, group] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        manifest[baseName] = {
            up: group.up || null,
            down: group.down || null,
        };
    }
    ensureDirectory(path.dirname(output));
    fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
    input.io.stdout(`Generated manifest at ${output}\n`);
}
function runCli(options) {
    const parsed = parseArgs(options.argv);
    const cwd = options.cwd ?? process.cwd();
    const templatesDirectory = options.templatesDirectory ?? path.resolve(cwd, "templates");
    try {
        switch (parsed.command) {
            case "create":
                createMigration({
                    cwd,
                    io: options.io,
                    name: parsed.positional[0],
                    options: parsed.options,
                    templatesDirectory,
                });
                return 0;
            case "validate":
                validateMigrations({
                    cwd,
                    io: options.io,
                    options: parsed.options,
                });
                return 0;
            case "manifest":
                generateManifest({
                    cwd,
                    io: options.io,
                    options: parsed.options,
                });
                return 0;
            case "help":
            case "--help":
            case "-h":
            case undefined:
                printHelp(options.io);
                return 0;
            default:
                throw new CliError(`Unknown command "${parsed.command}". Run "rn-sqlite-migrations help" for usage.`);
        }
    }
    catch (error) {
        if (error instanceof CliError) {
            options.io.stderr(`${error.message}\n`);
            return error.exitCode;
        }
        throw error;
    }
}
