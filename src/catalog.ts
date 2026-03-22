import type { MigrationCatalog, MigrationDefinition } from "./types";

function compareMigrationNames(left: MigrationDefinition, right: MigrationDefinition) {
  return left.name.localeCompare(right.name);
}

export function defineMigrations(catalog: MigrationCatalog): MigrationCatalog {
  const sorted = [...catalog.migrations].sort(compareMigrationNames);

  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    if (!current.name.trim()) {
      throw new Error("Migration name cannot be empty.");
    }

    if (!current.sql.up.trim()) {
      throw new Error(`Migration "${current.name}" is missing an up SQL file.`);
    }

    const previous = sorted[index - 1];
    if (previous?.name === current.name) {
      throw new Error(`Duplicate migration name detected: "${current.name}".`);
    }

    if (current.metadata?.reversible === false && current.sql.down) {
      throw new Error(
        `Migration "${current.name}" cannot define a down SQL file when metadata.reversible is false.`,
      );
    }
  }

  return {
    directory: catalog.directory,
    migrations: sorted,
  };
}
