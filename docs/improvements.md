# Improvement Ideas

This document tracks the most valuable next steps for the package.

## High-Value Improvements

### Driver Adapters

Ship first-party adapters for common React Native SQLite drivers, such as:

- `expo-sqlite`
- `react-native-quick-sqlite`
- `react-native-sqlite-storage`

This reduces adoption friction and removes boilerplate in consumer apps.

### SQL Manifest Generation

Provide a build-time manifest generator that scans the migrations folder and produces a static SQL map.

Why this matters:

- React Native often cannot read arbitrary local files at runtime
- a generated manifest makes SQL loading predictable
- the app can avoid maintaining manual `require()` maps

### File Checksums

Store a checksum for each applied SQL file.

Benefits:

- detects accidental edits to already-applied migrations
- helps maintain migration integrity across environments
- improves debugging when schema drift happens

### CLI Tooling

Add a small CLI for package maintenance.

Potential commands:

- validate migration ordering
- check duplicate or missing SQL files
- generate new migration templates
- generate the SQL manifest

### Better SQLite Compatibility Helpers

SQLite has limitations around `ALTER TABLE`, so many destructive changes require table recreation.

Useful helpers would include:

- copy-table strategies
- column rename workflows
- safe data copy utilities
- temporary table helpers for destructive migrations

### Richer Rollback Safety

Improve rollback support with clearer guarantees.

Potential additions:

- optional rollback validation before execution
- warnings for irreversible migrations
- dry-run rollback planning
- explicit migration metadata flags such as `reversible: false`

## Testing Improvements

### Real Integration Matrix

Add integration tests against real SQLite engines, not only the fake executor.

Good candidates:

- a Node SQLite runtime for CI
- one adapter test per supported React Native driver

### Fixture-Based SQL Tests

Move complex migration scenarios into reusable SQL fixtures.

Benefits:

- makes tests easier to read
- increases confidence in multi-step migrations
- helps prevent regressions in destructive migration flows

### Corruption and Recovery Scenarios

Test failure cases explicitly, such as:

- SQL file missing
- hook failure during migration
- crash between SQL execution and migration record write
- rollback with missing catalog entries

## Package Experience Improvements

### Better Error Messages

Provide more context in runtime errors, including:

- migration name
- SQL file path
- current batch number
- phase that failed, such as `beforeDestructive` or `down`

### Structured Logging Hooks

Allow apps to plug in a logger for migration lifecycle events.

This would help with:

- debugging production devices
- visibility during upgrades
- telemetry around schema transitions

### Optional Migration Metadata

Support extra metadata on migrations, such as:

- human-readable description
- feature owner
- creation date
- reversibility marker
- tags for release grouping
