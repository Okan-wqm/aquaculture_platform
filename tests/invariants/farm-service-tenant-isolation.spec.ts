/**
 * Farm-Service Tenant-Isolation Discipline Invariant
 * ============================================================================
 *
 * Every `findOne` / `find` / `findBy` call in a `farm-service` handler
 * that touches a tenant-scoped entity MUST scope by `tenantId` in its
 * `where:` clause. The handful of exceptions are documented below and
 * whitelisted by file:line.
 *
 * # Why this matters
 *
 * Multi-tenant isolation is enforced at the ORM-filter level, not the
 * DB level (there's no RLS for per-tenant row filtering on the farm
 * schema). A handler that filters only by `id` will happily return a
 * row from another tenant if a caller (attacker or bug) supplies a
 * UUID from that other tenant. UUIDs are globally unique across the
 * table, so the ID→row map leaks cross-tenant without the tenant filter.
 *
 * The discipline is absolute: every findOne / find / findBy that
 * targets a tenant-scoped entity carries `tenantId` in the where
 * clause — even post-write re-reads where the caller "just saved"
 * the row under the right tenant. Future refactors otherwise silently
 * strip the upstream tenant check and the post-write re-read becomes
 * the leak vector.
 *
 * # When this spec fails
 *
 * The failure message prints the file + line. Two fixes:
 *
 *   1. Add `tenantId` to the `where:` object. If the variable isn't
 *      in scope, thread it through the method signature.
 *   2. If the entity is a GLOBAL catalogue (no tenantId column —
 *      equipment_types, sub_equipment_types, species reference
 *      taxonomy tables, etc.), add the file:line to `GLOBAL_CATALOGUE_SITES`
 *      below with a comment explaining WHY.
 *
 * # Whitelist entries
 *
 * `GLOBAL_CATALOGUE_SITES` — entities with no tenantId column; lookup
 * by id alone is correct.
 *
 * `FEDERATION_LOOKUP_SITES` — Apollo Federation `__resolveReference`
 * paths where tenantId is optional by design (tenant-scope is
 * enforced at the gateway). Must carry an explicit comment on the
 * findOne saying so.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_HANDLERS_ROOT = resolve(REPO_ROOT, 'apps/farm-service/src');

function walkHandlerFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkHandlerFiles(full, acc);
    } else if (entry.endsWith('.handler.ts') && !entry.endsWith('.spec.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Entities whose table has no `tenantId` column (global catalogues).
 * Any findOne({ where: { id } }) against these is correct.
 */
const GLOBAL_CATALOGUE_ENTITIES = new Set([
  'EquipmentType',
  'SubEquipmentType',
]);

/**
 * Known Apollo Federation `__resolveReference` sites where the
 * tenantId filter is optional by design. Each entry is file:line.
 */
const FEDERATION_LOOKUP_SITES = new Set<string>([
  // get-farm.handler.ts — federation __resolveReference path documented
  // in the handler body (the `runInSourceRead` branch, taken only when
  // tenantId is absent); tenantId optional to serve cross-tenant
  // federation refs. Security is enforced at the gateway.
  'apps/farm-service/src/farm/query-handlers/get-farm.handler.ts:47',
]);

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

function scanFarmHandlers(): Finding[] {
  const absFiles = walkHandlerFiles(FARM_HANDLERS_ROOT);
  const findings: Finding[] = [];

  for (const absPath of absFiles) {
    const relPath = relative(REPO_ROOT, absPath);
    const text = readFileSync(absPath, 'utf8');
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      // Detect TypeORM repository / manager calls only — not Array.prototype.find
      // on local arrays (po.items.find, documents.find, etc.).
      const isRepoCall =
        /\b(\w*Repository|\w*Repo)\s*\.\s*(findOne|findOneBy|findBy|find)\s*\(/.test(
          line,
        ) ||
        /\b(queryRunner\.manager|this\.dataSource\.manager|\bmanager)\s*\.\s*(findOne|findOneBy|findBy|find)\s*\(/.test(
          line,
        );
      if (!isRepoCall) continue;

      // Allow if the call names a global-catalogue entity as the
      // first arg: `manager.findOne(EquipmentType, { where: { id } })`
      const entityArgMatch = /\.(findOne|findOneBy|findBy|find)\s*\(\s*([A-Z][A-Za-z0-9_]+)\s*,/.exec(
        line,
      );
      if (entityArgMatch && GLOBAL_CATALOGUE_ENTITIES.has(entityArgMatch[2]!)) {
        continue;
      }

      // Allow if the repository is a global-catalogue repository.
      if (/\b(equipmentType|subEquipmentType)Repository\.(findOne|find)\b/.test(line)) {
        continue;
      }

      // Allow explicit federation sites
      const siteKey = `${relPath}:${i + 1}`;
      if (FEDERATION_LOOKUP_SITES.has(siteKey)) continue;

      // Extract the `where:` block contents. The call may be a
      // findBy/findOneBy shorthand (arg IS the where clause), or a
      // `{ where: { ... } }` options object. Grab the text from the
      // repo-call to the matching close-paren (or a reasonable
      // 10-line window, whichever is first) and inspect the
      // where-clause specifically.
      const callWindow = lines.slice(i, i + 10).join('\n');

      // Find the `where:` keyword's {…} body (may span lines) and
      // check if it mentions tenantId. If the call uses findBy /
      // findOneBy, the first argument is the criteria itself — look
      // inside the parentheses.
      let whereBlock: string | null = null;
      const whereKeyword = /where\s*:\s*([\s\S]*?)(?=,\s*(?:relations|order|lock|take|skip|select|loadRelationIds|cache|transaction|comment)\s*:|\}\s*,|\}\s*\))/.exec(
        callWindow,
      );
      if (whereKeyword) {
        whereBlock = whereKeyword[1] ?? '';
      } else {
        const findByMatch = /\.(findBy|findOneBy)\s*\(([\s\S]*?)\)/.exec(callWindow);
        if (findByMatch) {
          whereBlock = findByMatch[2] ?? '';
        }
      }

      // If we couldn't parse the where-block, fall back to a cautious
      // local check — line itself — to avoid false positives from the
      // earlier-in-file tenantId mentions. Resolve-to-variable (where: varName)
      // is handled by the getWhereVariableDefinition pass below.
      if (whereBlock !== null && /tenantId|tenant_id/.test(whereBlock)) continue;

      // where: varName — resolve the variable definition backward and
      // check if THAT has tenantId. Two surface forms map to a local
      // variable:
      //   1. explicit alias  `where: someVar,` / `where: someVar }`
      //   2. ES6 object-property shorthand `{ where, ... }` (≡ `where: where`)
      // Shorthand is the idiomatic form (ESLint `object-shorthand` enforces
      // it), so the scanner must resolve it to the local `where` declaration
      // exactly as it resolves the explicit alias — otherwise correct,
      // fully tenant-scoped handlers that build `const where = { tenantId }`
      // and pass `{ where }` false-positive. The backward varDef check below
      // still requires proof that the resolved variable carries tenantId, so
      // a `const where = { id }` (no tenant) is NOT silently allowed.
      const whereVarMatch = /where\s*:\s*(\w+)\s*[,}]/.exec(callWindow);
      const whereShorthand = /[{,]\s*where\s*[,}]/.test(callWindow);
      const varName = whereVarMatch ? whereVarMatch[1]! : whereShorthand ? 'where' : null;
      if (varName) {
        // Look backward for the variable declaration in this method.
        const backward = lines.slice(Math.max(0, i - 60), i).join('\n');
        const varDef = new RegExp(
          `(?:const|let|var)\\s+${varName}[^=]*=\\s*\\{[\\s\\S]*?tenantId`,
        );
        if (varDef.test(backward)) continue;
        // Also allow where the variable is mutated: `varName.tenantId = ...`
        const varMutation = new RegExp(`${varName}\\.tenantId`);
        if (varMutation.test(backward)) continue;
      }

      findings.push({
        file: relPath,
        line: i + 1,
        snippet: line.trim(),
      });
    }
  }

  return findings;
}

describe('farm-service tenant isolation discipline', () => {
  it('every findOne/find on a tenant-scoped entity carries tenantId in the where clause', () => {
    const findings = scanFarmHandlers();
    if (findings.length > 0) {
      const printable = findings
        .map((f) => `  - ${f.file}:${f.line}\n    ${f.snippet}`)
        .join('\n');
      throw new Error(
        `Tenant-isolation discipline violation — ${findings.length} call site(s) ` +
          `missing tenantId in the where clause:\n${printable}\n\n` +
          'Fix: add `tenantId` to the where object. If the entity is a global ' +
          'catalogue (no tenantId column), add the entity name to ' +
          'GLOBAL_CATALOGUE_ENTITIES in this spec. If this is a legitimate ' +
          'Apollo Federation __resolveReference path, add the file:line to ' +
          'FEDERATION_LOOKUP_SITES with a comment explaining why.',
      );
    }
  });
});
