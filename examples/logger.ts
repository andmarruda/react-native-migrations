import type { MigrationLogger } from "../src";

export const consoleMigrationLogger: MigrationLogger = {
  log(event) {
    const scope = event.migrationName ? `:${event.migrationName}` : "";
    console.log(`[rn-sqlite-migrations:${event.type}${scope}]`, event);
  },
};
