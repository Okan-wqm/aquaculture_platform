#!/usr/bin/env node
/**
 * 2026-05-06: CI prewarm contract for migration-harness Testcontainers.
 *
 * Why this exists:
 * - `migration-harness` owns the production-equivalent PostgreSQL image pin in
 *   `libs/migration-harness/src/setup.ts`.
 * - GitHub Actions must pull that exact image before Jest starts so the
 *   `beforeAll` hook measures harness boot/readiness, not image download time.
 * - Duplicating the digest in YAML would create drift; this script reads the
 *   harness-owned constant and fails closed if the ownership shape changes.
 */
import { readFileSync } from 'node:fs';

const setupSource = readFileSync('libs/migration-harness/src/setup.ts', 'utf8');
const match = setupSource.match(
  /export const DEFAULT_POSTGRES_IMAGE\s*=\s*\n\s*'([^']+)'/,
);

if (!match) {
  throw new Error(
    'Could not locate DEFAULT_POSTGRES_IMAGE in libs/migration-harness/src/setup.ts',
  );
}

process.stdout.write(match[1]);
