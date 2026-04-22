# Package Architecture

This document explains what each file in the package does and how the pieces work together.

## Top-Level Files

### `package.json`

Defines the package metadata, build script, typecheck script, and local test script.

- `build` compiles the TypeScript source into `dist/`
- `typecheck` validates the TypeScript contracts without emitting files
- `test` builds the package and runs the isolated local test suite

### `tsconfig.json`

Configures the TypeScript compiler for library output.

- emits declaration files for consumers
- writes compiled artifacts to `dist/`
- keeps strict type checking enabled
- uses CommonJS output so local Node-based tests can load the built package directly

### `README.md`

The package entry-point documentation for consumers.

It explains:

- the migration concept
- how to define migrations
- how to point the library to an external SQL directory
- when to use `beforeDestructive`
- the adapter contract expected from the SQLite driver

## Source Files

### `src/index.ts`

Public package entry point.

It re-exports:

- the migration catalog builder
- the migration runner
- the React Native SQLite adapters
- the SQL loaders
- the SQL splitting helper
- all public TypeScript types

This file defines what consumers import from the package.

Node-only CLI helpers are exported from the separate `./cli` subpath so React Native
bundlers do not traverse `node:fs` and other CLI dependencies from the app runtime.

### `src/types.ts`

Holds the public contracts used across the package.

Main responsibilities:

- describes the SQLite executor interface expected from the app
- describes migration definitions and lifecycle hooks
- describes runner input and output types
- defines the migration execution context passed to hooks

This file is the package's API contract surface.

### `src/catalog.ts`

Validates and normalizes the migration catalog provided by the app.

Main responsibilities:

- sorts migrations by name
- ensures each migration has a non-empty name
- ensures each migration has an `up` SQL file
- prevents duplicate migration names

This is the package equivalent of validating the migration manifest before execution.

### `src/sql.ts`

Provides SQL utility helpers.

Main responsibilities:

- normalizes SQL text
- splits SQL files into executable statements
- preserves semicolons inside quoted strings
- runs SQL statements sequentially through the provided executor

This file keeps SQL parsing concerns outside of the migration runner.

### `src/runner.ts`

The core orchestration engine of the package.

Main responsibilities:

- creates the internal migration repository table
- reads which migrations were already applied
- computes pending migrations
- runs each migration inside its own transaction
- executes lifecycle hooks such as `beforeDestructive`
- loads external SQL files through the provided loader
- records migration history using Laravel-like `batch` semantics
- rolls back the latest batch in reverse order
- exposes status inspection for applied and pending migrations

This is the heart of the library.

## Test Files

### `test/package.test.cjs`

End-to-end local package tests using Node's built-in test runner.

The tests validate the package in isolation by:

- importing the built package from `dist/`
- faking a SQLite executor
- simulating metadata persistence
- verifying migration ordering, hooks, status, and rollback behavior
- verifying SQL splitting behavior independently

## Runtime Flow

When the app calls `migrate()`:

1. the runner ensures the migration repository table exists
2. the catalog-provided migrations are compared against applied records
3. each pending migration runs in its own transaction
4. `beforeDestructive` and `beforeUp` run before the SQL file
5. the `.up.sql` file is loaded through `readSqlFile`
6. SQL statements are executed sequentially
7. the migration is recorded with the current batch number

When the app calls `rollbackLastBatch()`:

1. the latest batch number is discovered
2. migrations in that batch are loaded in reverse order
3. `beforeDown`, `.down.sql`, and `afterDown` run
4. the migration record is removed from the repository table

## Design Notes

- The package does not own file-system access in React Native. Instead, it receives a `readSqlFile` function from the app.
- The package does not depend on a specific SQLite engine. The app adapts any SQLite driver to the `SqliteExecutor` interface.
- Destructive structural changes should be preceded by `beforeDestructive` whenever data must be preserved or transformed first.
