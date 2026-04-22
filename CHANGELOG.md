# Changelog

## 0.1.1

- Removed Node-only CLI re-exports from the root package entrypoint so React Native
  bundlers do not resolve CLI files during app builds.
- Kept CLI helpers available through the `./cli` subpath export and the package
  binary.

## 0.1.0

- Initial public release of the migration runner, CLI, loaders, and adapter helpers.
- Added migration integrity checks with checksum support and strict mode.
- Added rollback planning, health checks, and structured logging hooks.
