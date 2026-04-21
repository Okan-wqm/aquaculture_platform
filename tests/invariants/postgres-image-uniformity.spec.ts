/**
 * Platform-wide invariant: postgres image is uniform across CI workflows
 * and every docker-compose file.
 *
 * INFRA-CRITICAL-010 closed the pgvector-missing failure by switching every
 * postgres callsite to `timescale/timescaledb-ha:pg16@sha256:<digest>`. This
 * invariant locks the contract — a future regression that introduces a
 * different image (or unpins the digest) fails CI before drift can land.
 *
 * Why uniformity matters:
 *   - Production migrations create indexes / extensions that depend on
 *     specific server features (pgvector HNSW, TimescaleDB hypertables).
 *     A test environment with a different image silently passes when
 *     production would fail.
 *   - Per SEC-CI-002, every container image must be SHA-pinned. Floating
 *     tags reintroduce supply-chain drift the platform spent effort to
 *     close.
 *   - Single source of truth: when the image needs bumping, exactly ONE
 *     digest changes across the repo. Multiple values mean divergence
 *     and inconsistent test/prod behaviour.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Files in scope: every workflow yml + every docker-compose*.yml.
// We exclude node_modules, dist, worktrees, and historical review docs.
const SCOPE_GLOBS = [
  '.github/workflows/*.yml',
  'docker-compose*.yml',
];

describe('INVARIANT: postgres image is uniform + SHA-pinned', () => {
  it('asserts every postgres `image:` reference uses the same digest-pinned tag', () => {
    // Match `image: ` followed by anything containing `timescaledb` or `postgres` or `pgvector`.
    // We capture the trailing image string and verify all are identical.
    const cmd =
      `git -C ${REPO_ROOT} grep -hE '^[[:space:]]*image:[[:space:]]+(.*timescaledb.*|.*postgres.*|.*pgvector.*)' -- ` +
      SCOPE_GLOBS.map((g) => `'${g}'`).join(' ');

    let raw: string;
    try {
      raw = execSync(cmd, { encoding: 'utf8' });
    } catch (err) {
      const e = err as { status?: number };
      // No matches means no postgres image declared anywhere — that's also valid.
      if (e.status === 1) return;
      throw err;
    }

    // Extract just the image tokens.
    const imageTokens = raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^[[:space:]]*image:\s*/, '').trim())
      // Strip inline comments after the image (yaml allows `image: x  # comment`)
      .map((token) => token.split('#')[0]!.trim())
      .filter((token) => token.length > 0);

    if (imageTokens.length === 0) return;

    // Build the unique set; expectation is exactly 1.
    const unique = Array.from(new Set(imageTokens));
    if (unique.length !== 1) {
      throw new Error(
        `INFRA-CRITICAL-010 invariant VIOLATED — postgres image is NOT uniform across the repo. ` +
          `Found ${unique.length} distinct image strings (expected 1):\n` +
          unique.map((u) => `  - ${u}`).join('\n') +
          `\n\nFix: pick one digest-pinned tag and use it in every workflow yml + every docker-compose*.yml.`,
      );
    }

    const onlyImage = unique[0]!;

    // Enforce SHA-pinning per SEC-CI-002.
    if (!onlyImage.includes('@sha256:')) {
      throw new Error(
        `INFRA-CRITICAL-010 / SEC-CI-002 invariant VIOLATED — postgres image is not digest-pinned: "${onlyImage}".\n` +
          `Fix: append @sha256:<digest> to the image tag.`,
      );
    }

    // Enforce HA edition (the tag that ships with pgvector).
    if (!onlyImage.includes('timescaledb-ha')) {
      throw new Error(
        `INFRA-CRITICAL-010 invariant VIOLATED — postgres image is not the HA edition: "${onlyImage}".\n` +
          `The HA edition (timescale/timescaledb-ha:*) is required because messaging-service\n` +
          `migration 1711800000001-CreateAITables.ts creates an HNSW index using vector_cosine_ops,\n` +
          `which requires pgvector. The non-HA timescaledb image does not include pgvector.`,
      );
    }
  });
});
