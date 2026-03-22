# What Is Still Missing to Reach More Than 95% Test Coverage

The latest measured coverage was roughly:

- all files: `89.36%` lines
- all files: `88.76%` branches
- all files: `93.24%` functions

This document explains what still matters most to reach `95%+` with confidence.

## Main Gap: CLI Coverage

The largest coverage drop currently comes from the CLI file.

Observed weak area:

- [bin/rn-sqlite-migrations.cjs](/home/anderson/econorg/sqlite-migration/bin/rn-sqlite-migrations.cjs)

Why:

- several CLI tests currently fail in restricted environments because they rely on `spawnSync node`
- as a result, important success and failure branches are not executed reliably

What to do:

- refactor the CLI into testable pure functions
- export command handlers from a shared module
- keep the `bin/` file as a thin wrapper only
- test command behavior without spawning a child process

This single change would likely move coverage up significantly.

## Catalog Coverage Gaps

The catalog file is close, but not fully covered.

Still worth testing:

- empty migration name
- missing `up` SQL file
- sorting edge cases with multiple entries

## Runner Coverage Gaps

The runner is already very strong, but a few branches are still open.

Based on the current report, remaining areas likely include:

- rollback path where a migration record exists but the catalog lookup throws during actual rollback
- branch paths around plan generation and empty-state returns
- logger branches that are not exercised in every phase

## SQL and Type Coverage

These are already at or near full coverage, so they are not the main problem.

## Coverage Strategy That Would Best Improve the Score

The most efficient path to `95%+` is:

1. refactor CLI logic into importable functions
2. test CLI parsing and command execution directly
3. add explicit catalog negative tests
4. rerun coverage and close the few remaining runner branches

## Important Note

A package can have high coverage and still miss real-world safety.

So the real goal should be:

- `95%+` measured coverage
- passing tests
- strong branch coverage on failure and recovery flows

## Support

If this package helps your work and you want to support its development:

- Buy Me a Coffee: `buymeacoffee.com/andmarruda`
