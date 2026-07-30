/**
 * Platform-wide invariant — INFRA-CRITICAL-021 (DEFECT-1):
 *
 * Importing `@aquaculture/backend-common` (the MAIN barrel) MUST NOT
 * load `@Entity()` decorators as a side effect.
 *
 * The main barrel is consumed by every microservice, often just for
 * cross-cutting utilities (TenantGuard, RedisModule, factories). If the
 * barrel chains through entity files, every consumer service ends up
 * with `AuditLogEntity`, `UserConsent`, and `GdprDataRequest`
 * registered in TypeORM's global metadata storage —
 * which then surfaces in `dataSource.entityMetadatas` and trips the
 * `SchemaDriftValidator` on services that never opted into those
 * domains.
 *
 * # Architectural contract
 *
 * - `libs/backend-common/src/index.ts` MUST NOT have any
 *   `export * from './audit'` or a transitive re-export that pulls in
 *   that subdirectory.
 *
 * - `libs/backend-common/src/security/index.ts` MUST NOT have any
 *   `export * from './gdpr'` (which would chain through GDPR entities
 *   and re-pollute via `index.ts → security → gdpr → entities`).
 *
 * - Concrete entity-bearing modules (`AuditLogModule`, `GdprModule`) are
 *   reachable via deep import paths only:
 *     - `@aquaculture/backend-common/audit`
 *     - `@aquaculture/backend-common/gdpr`
 *
 * # What this invariant detects
 *
 * - Direct re-export reintroductions in the two index files.
 * - Files inside `libs/backend-common/src/` that import from
 *   `./audit` or `./security/gdpr` AND whose
 *   import path is reachable from the main `index.ts` graph (i.e.
 *   transitive contamination via a non-entity utility file).
 *
 * Test directories are exempt — they may import the entity modules
 * directly for fixtures.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND_COMMON_SRC = resolve(REPO_ROOT, 'libs/backend-common/src');

const FORBIDDEN_RE_EXPORTS = [
  // path -> forbidden patterns inside that file
  {
    file: 'index.ts',
    patterns: [/^\s*export\s+\*\s+from\s+['"]\.\/audit['"]\s*;?$/m],
  },
  {
    file: 'security/index.ts',
    patterns: [/^\s*export\s+\*\s+from\s+['"]\.\/gdpr['"]\s*;?$/m],
  },
];

// Files inside backend-common that are themselves part of the main
// barrel chain (reachable from index.ts) — they MUST NOT directly import
// entity-bearing submodules. Add to this list when adding new top-level
// exports to `index.ts`.
const MAIN_BARREL_GUARD_FILES = [
  'guards/tenant.guard.ts',
  'guards/roles.guard.ts',
  'guards/tenant-permission.guard.ts',
  'guards/service-identity.guard.ts',
  'guards/token-revocation.service.ts',
  'middleware/tenant-context.middleware.ts',
  'middleware/tenant-schema.middleware.ts',
  'database/index.ts',
  'security/security.module.ts',
];

const ENTITY_BEARING_IMPORT_RE =
  /from\s+['"](?<path>(\.\.?\/)+(audit|security\/gdpr)(\/[^'"]+)?)['"]/;

const MAIN_BARREL_SAFE_DEEP_IMPORTS = new Set(['../audit/audit-log.tokens']);

describe('INVARIANT (INFRA-CRITICAL-021): main barrel does not chain to @Entity decorators', () => {
  it('forbids `export *` from entity-bearing submodules in the index files', () => {
    const violations: string[] = [];
    for (const { file, patterns } of FORBIDDEN_RE_EXPORTS) {
      const path = resolve(BACKEND_COMMON_SRC, file);
      if (!existsSync(path)) {
        violations.push(`expected file missing: ${path}`);
        continue;
      }
      const content = readFileSync(path, 'utf8');
      for (const pattern of patterns) {
        if (pattern.test(content)) {
          violations.push(`${file}: contains forbidden re-export ${pattern.toString()}`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `INFRA-CRITICAL-021 invariant VIOLATED — main barrel re-exports entity-bearing submodules:\n  ` +
          violations.join('\n  ') +
          `\n\nReplace the bulk re-export with explicit named exports of the non-entity-touching surface ` +
          `(token, interface, DTO, decorator). Concrete entity-bearing modules MUST be deep-import only ` +
          `via @aquaculture/backend-common/{audit,gdpr}. ` +
          `See libs/backend-common/src/index.ts for the canonical pattern.`,
      );
    }
  });

  it('forbids main-barrel-reachable files from importing entity-bearing submodules', () => {
    const violations: string[] = [];
    for (const file of MAIN_BARREL_GUARD_FILES) {
      const path = resolve(BACKEND_COMMON_SRC, file);
      if (!existsSync(path)) continue; // file may not exist on every branch
      const content = readFileSync(path, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        const match = line.match(ENTITY_BEARING_IMPORT_RE);
        if (match) {
          const importPath = match.groups?.['path'];
          if (importPath && MAIN_BARREL_SAFE_DEEP_IMPORTS.has(importPath)) return;
          // Allow `import type` (erased at runtime, no decorator load).
          if (/^\s*import\s+type\s/.test(line)) return;
          violations.push(`${file}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    if (violations.length > 0) {
      throw new Error(
        `INFRA-CRITICAL-021 invariant VIOLATED — main-barrel-reachable file imports entity-bearing submodule:\n  ` +
          violations.join('\n  ') +
          `\n\nDepend on the audit DI token + interface (AUDIT_LOG_SERVICE / IAuditLogService from ` +
          `'../audit/audit-log.tokens') instead of importing the AuditLogService class. Token-only deep ` +
          `imports are the allowed main-barrel-safe exception; concrete audit/gdpr modules remain ` +
          `forbidden here. The token-based ` +
          `pattern is documented in libs/backend-common/src/audit/audit-log.tokens.ts.`,
      );
    }
  });
});
