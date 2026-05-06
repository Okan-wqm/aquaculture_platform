# Signals manifest compose env drift

Date: 2026-05-02

## Problem

`schema-validation` failed in PR #228 during `validate-signals-manifest.ts`:

`required variable REDIS_PASSWORD is missing a value`

The previous compose preflight step generated a dummy env file from the compose
file and passed, but the signals manifest step called `docker compose config
--services` without the same env-file handling.

## Impact

The signals manifest gate could fail on required secret interpolation before it
checked the actual manifest-to-compose service contract. This makes the gate
dependent on CI environment secrets instead of the compose SSoT.

## Root Cause

Two CI validators used different compose invocation contracts. The preflight
validator derived required `${VAR:?}` references from compose and generated a
throwaway env file; the signals validator did not.

## Fix

`validate-signals-manifest.ts` now derives required compose variables, writes an
ephemeral generated env file, and passes `--env-file` to `docker compose config
--services`.

## Verification

The schema-validation job should now reach the actual signal manifest checks
without requiring real deployment secrets in CI.
