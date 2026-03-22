# Coverage Guide

This package uses the native Node test runner and native V8 coverage output.

## Commands

Run the package tests:

```bash
npm test
```

Run the package tests with coverage:

```bash
npm run test:coverage
```

## How It Works

The coverage script:

1. builds the package into `dist/`
2. runs the Node test runner with `--experimental-test-coverage`
3. stores raw V8 coverage artifacts in `coverage/v8/`
4. prints the coverage summary in the terminal

## Why Native Coverage

The package currently avoids external test runners and coverage libraries.

Benefits:

- fewer dependencies
- simpler local setup
- coverage is measured against the built package output
- good fit for a package whose tests intentionally exercise the distributable artifact

## Current Goal

The intent of the coverage work is to make branch and error-path behavior explicit, not only happy-path behavior.

That means tests should cover:

- successful migration runs
- empty-state behavior
- rollback planning and rollback blocking
- contextual runtime failures
- SQL parser edge cases
- CLI success and failure paths

## Notes

- If `tsc` is not installed in the environment yet, the build step will fail before tests start.
- Coverage is currently measured from the compiled `dist/` files because the isolated tests import the built package.
