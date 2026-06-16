/**
 * Farm-module no-fabricated-data invariant
 * ============================================================================
 *
 * The Tier-3 make-it-detectable backstop for the two Phase-5 CRITICALs that
 * shipped fabricated data to operators as if it were real:
 *
 *   - fe-sensor-fake (FARM-CRITICAL-051): the /sites/sensors dashboard rendered
 *     `Math.random()`-scaled pH / temperature / dissolved-oxygen as LIVE water
 *     quality. Operators act on DO/pH to prevent fish-kill — fabricated
 *     readings are a life-safety hazard.
 *   - fe-reports-mock (FARM-CRITICAL-052): the regulatory reports dashboard
 *     (summary, penalty banner, per-tab history) was backed by imported `mock/`
 *     fixtures and shipped unconditionally in production.
 *
 * Two rules, both scanning ONLY tracked farm-module production source
 * (non-test), so a future scaffold cannot re-introduce either class:
 *
 *   RULE 1 — no mock-data module imports. A production file may not import from
 *     a `…/mock…` path (the fe-reports-mock class: imported fixture arrays).
 *
 *   RULE 2 — no value-fabricating `Math.random()`. In a `.tsx` render surface,
 *     `Math.random()` immediately followed by an arithmetic operator (`*`/`/`/
 *     `+`) is the telemetry-fabrication pattern (`7.2 + Math.random() * 0.6`).
 *     ID generation (`Math.random().toString(36)`) is followed by `.` and is
 *     allowed; comments mentioning the token are not arithmetic and are ignored.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const FARM_FE_ROOT = 'web/modules/farm-module/src';

function farmFiles(extensions: readonly string[]): string[] {
  const out = execFileSync('git', ['ls-files', FARM_FE_ROOT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => extensions.some((e) => f.endsWith(e)))
    .filter((f) => !f.includes('__tests__'))
    .filter((f) => !f.endsWith('.spec.ts') && !f.endsWith('.spec.tsx'))
    .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));
}

const MOCK_IMPORT = /\bfrom\s+['"][^'"]*\/mock(?:\/[^'"]*)?['"]/;
const FABRICATED_RANDOM = /Math\.random\(\)\s*[*/+]/;
// fe-upload-bypass (FARM-HIGH-071): a raw fetch() to an /upload endpoint
// bypasses the central authenticated REST client (no CSRF / refresh-on-401 /
// fresh-token / tenant). Uploads MUST go through restClient.upload/delete.
const RAW_UPLOAD_FETCH = /fetch\(\s*[`'"][^`'"\n]*\/upload/;

describe('farm-module no-fabricated-data invariant', () => {
  it('RULE 1: no production file imports from a mock-data module', () => {
    const offenders: string[] = [];
    for (const file of farmFiles(['.ts', '.tsx'])) {
      const content = readFileSync(join(REPO_ROOT, file), 'utf8');
      content.split('\n').forEach((line, i) => {
        if (MOCK_IMPORT.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    if (offenders.length > 0) {
      throw new Error(
        `farm-module production files must not import fixture data from a mock/ module ` +
          `(fe-reports-mock class). Offenders:\n${offenders.join('\n')}`,
      );
    }
  });

  it('RULE 2: no value-fabricating Math.random() in a render surface', () => {
    const offenders: string[] = [];
    for (const file of farmFiles(['.tsx'])) {
      const content = readFileSync(join(REPO_ROOT, file), 'utf8');
      content.split('\n').forEach((line, i) => {
        if (FABRICATED_RANDOM.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    if (offenders.length > 0) {
      throw new Error(
        `farm-module .tsx render surfaces must not fabricate values with Math.random() ` +
          `arithmetic (fe-sensor-fake class). Use real backend data. ID generation via ` +
          `Math.random().toString(36) is allowed. Offenders:\n${offenders.join('\n')}`,
      );
    }
  });

  it('RULE 3: no raw fetch() to an /upload endpoint (must use the central restClient)', () => {
    const offenders: string[] = [];
    for (const file of farmFiles(['.ts', '.tsx'])) {
      const content = readFileSync(join(REPO_ROOT, file), 'utf8');
      content.split('\n').forEach((line, i) => {
        if (RAW_UPLOAD_FETCH.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    if (offenders.length > 0) {
      throw new Error(
        `farm-module file uploads must go through the central authenticated ` +
          `restClient.upload/delete (fresh token + CSRF + refresh-on-401), not a raw ` +
          `fetch() to /upload (fe-upload-bypass class). Offenders:\n${offenders.join('\n')}`,
      );
    }
  });
});
