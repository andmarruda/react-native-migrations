#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

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
    positional,
    options,
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

function resolveDirectory(input) {
  return path.resolve(process.cwd(), input || "src/database/migrations");
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function templatePath(fileName) {
  return path.resolve(__dirname, "..", "templates", fileName);
}

function loadTemplate(fileName) {
  return fs.readFileSync(templatePath(fileName), "utf8");
}

function listSqlFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
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

function createMigration(name, options) {
  if (!name) {
    fail("Please provide a migration name. Example: rn-sqlite-migrations create split_full_name");
  }

  const directory = resolveDirectory(options.dir);
  const timestamp = options.timestamp || toTimestamp();
  const slug = toMigrationSlug(name);

  if (!slug) {
    fail("The migration name produced an empty slug. Use letters or numbers in the name.");
  }

  ensureDirectory(directory);

  const baseName = `${timestamp}_${slug}`;
  const upPath = path.join(directory, `${baseName}.up.sql`);
  const downPath = path.join(directory, `${baseName}.down.sql`);

  if (fs.existsSync(upPath) || fs.existsSync(downPath)) {
    fail(`Migration "${baseName}" already exists in ${directory}.`);
  }

  const upTemplate = loadTemplate("migration.up.sql").replace(/__MIGRATION_NAME__/g, baseName);
  const downTemplate = loadTemplate("migration.down.sql").replace(/__MIGRATION_NAME__/g, baseName);

  fs.writeFileSync(upPath, upTemplate);
  fs.writeFileSync(downPath, downTemplate);

  process.stdout.write(`Created:\n- ${upPath}\n- ${downPath}\n`);
}

function validateMigrations(options) {
  const directory = resolveDirectory(options.dir);
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

    if (!group.down) {
      errors.push(`Migration "${baseName}" is missing a .down.sql file.`);
    }
  }

  const orderedNames = [...groups.keys()];
  const sortedNames = [...orderedNames].sort((left, right) => left.localeCompare(right));
  if (orderedNames.join("|") !== sortedNames.join("|")) {
    errors.push("Migration files are not ordered lexicographically.");
  }

  if (errors.length > 0) {
    fail(errors.join("\n"));
  }

  process.stdout.write(`Validated ${groups.size} migrations in ${directory}\n`);
}

function generateManifest(options) {
  const directory = resolveDirectory(options.dir);
  const output = path.resolve(process.cwd(), options.out || path.join(directory, "manifest.generated.json"));
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
  process.stdout.write(`Generated manifest at ${output}\n`);
}

function printHelp() {
  process.stdout.write(
    [
      "rn-sqlite-migrations",
      "",
      "Commands:",
      "  create <name> [--dir <path>] [--timestamp <yyyymmddHHMMSS>]",
      "  validate [--dir <path>]",
      "  manifest [--dir <path>] [--out <path>]",
    ].join("\n"),
  );
}

function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "create":
      createMigration(positional[0], options);
      break;
    case "validate":
      validateMigrations(options);
      break;
    case "manifest":
      generateManifest(options);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      fail(`Unknown command "${command}". Run "rn-sqlite-migrations help" for usage.`);
  }
}

main();
