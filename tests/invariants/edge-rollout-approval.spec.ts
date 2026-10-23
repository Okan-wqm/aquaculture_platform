import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { stripComments } from './helpers/ts-source';

/**
 * ADR-048 DEC-2.4, DEC-23 — an update statement is signed only for an approved rollout.
 *
 * The edge-update statement carries no approvals in P1, so the cloud enforces the two
 * registered people itself, and this spec pins the places that enforcement can be
 * bypassed, in comment-stripped source:
 *
 *   - a rollout becomes RUNNING in exactly one place, `EdgeRolloutService.approve`,
 *     which locks the rollout, checks the plan digest, and counts distinct approvers
 *     against what the rollout requires before the write;
 *   - the number of approvals can never be configured below two: the constant, the
 *     column's CHECK and its default all name `MIN_ROLLOUT_APPROVALS`;
 *   - an update statement (edge-update, os-update, site-config, site-netpolicy, a
 *     trust-anchors push) is signed and stored only inside `EdgeUpdateRequestService`,
 *     whose `issueFromRecipe` is called only by the rollout service (the approved plan)
 *     and the reconciler (a new statement of an intent that was already issued) — no
 *     controller, resolver, command handler or script signs an update on its own;
 *   - `request_update` reaches a device only from `EdgeUpdateRequestService`.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SENSOR = 'apps/sensor-service/src/';
const ROLLOUT_SERVICE = `${SENSOR}release-bundle/edge-rollout.service.ts`;
const ROLLOUT_ENTITY = `${SENSOR}release-bundle/entities/edge-rollout.entity.ts`;
const REQUEST_SERVICE = `${SENSOR}edge-device/edge-update-request.service.ts`;
const RECONCILER = `${SENSOR}edge-device/edge-update-reconciler.service.ts`;

function productionSources(): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'apps/*.ts', 'libs/*.ts', 'platform/*.ts'],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.endsWith('.spec.ts') &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('.d.ts') &&
        !/\/(__tests__|__mocks__|test-helpers|testing)\//.test(path),
    );
}

const read = (path: string): string => stripComments(readFileSync(join(REPO_ROOT, path), 'utf8'));

/** The body of `async <name>(` up to the next method of the class at the same indentation. */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}(?:private |protected |public )?(?:async )?[A-Za-z]+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('rollout approval (ADR-048 DEC-2.4)', () => {
  it("a rollout is set RUNNING in one place only: the rollout service's approve", () => {
    const writers: string[] = [];
    for (const path of productionSources()) {
      const source = read(path);
      if (/\bSET\s+state\s*=\s*'running'/i.test(source)) writers.push(path);
      if (
        path !== ROLLOUT_SERVICE &&
        /state:\s*EdgeRolloutState\.RUNNING|\.state\s*=\s*EdgeRolloutState\.RUNNING/.test(source)
      ) {
        writers.push(`${path} (assigns RUNNING)`);
      }
    }
    expect(writers).toEqual([ROLLOUT_SERVICE]);
    const service = read(ROLLOUT_SERVICE);
    expect((service.match(/SET\s+state\s*=\s*'running'/gi) ?? []).length).toBe(1);
    expect(methodBody(service, 'approve')).toMatch(/SET\s+state\s*=\s*'running'/i);
  });

  it('approve locks the rollout, checks the plan digest and counts distinct approvers before it starts it', () => {
    const body = methodBody(read(ROLLOUT_SERVICE), 'approve');
    const lock = body.indexOf('FOR UPDATE');
    const digest = body.indexOf('planSha256 !== rollout.planSha256');
    const count = body.indexOf('count(DISTINCT approver_id)');
    const compare = body.indexOf(
      'approvers < Math.max(rollout.approvalsRequired, MIN_ROLLOUT_APPROVALS)',
    );
    const start = body.search(/SET\s+state\s*=\s*'running'/i);
    for (const at of [lock, digest, count, compare, start]) expect(at).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(digest);
    expect(digest).toBeLessThan(count);
    expect(count).toBeLessThan(compare);
    expect(compare).toBeLessThan(start);
  });

  it('the least number of approvals is two, in the constant, the column CHECK and its default', () => {
    const entity = read(ROLLOUT_ENTITY);
    expect(entity).toMatch(/export const MIN_ROLLOUT_APPROVALS = 2;/);
    expect(entity).toContain('`"approvals_required" >= ${MIN_ROLLOUT_APPROVALS}`');
    expect(entity).toMatch(/name: 'approvals_required', default: MIN_ROLLOUT_APPROVALS/);
    // ...and the service stores the constant, never a caller's number, on every rollout it creates.
    expect(read(ROLLOUT_SERVICE)).toMatch(/MIN_ROLLOUT_APPROVALS,\s*digest,/);
  });

  it('an update statement is signed only inside the request service, which only a recipe reaches from outside', () => {
    const signers: string[] = [];
    const direct: string[] = [];
    const fromRecipe: string[] = [];
    for (const path of productionSources()) {
      const source = read(path);
      if (/\.(signEdgeUpdate|signOsUpdate|signUpdate)\s*\(|\bnetpolicies\.sign\s*\(/.test(source)) {
        signers.push(path);
      }
      if (
        /\.(issueEdgeUpdate|issueOsUpdate|issueSiteConfig|issueSiteNetpolicy|issueTrustAnchors)\s*\(/.test(
          source,
        )
      ) {
        direct.push(path);
      }
      if (/\.issueFromRecipe\s*\(/.test(source)) fromRecipe.push(path);
    }
    // The producers are called only by the request service, which stores what they sign;
    expect(signers).toEqual([REQUEST_SERVICE]);
    // its per-kind issue methods only by its own issueFromRecipe;
    expect(direct).toEqual([REQUEST_SERVICE]);
    // and issueFromRecipe only by the rollout service (the approved plan) and the
    // reconciler (a new statement of an intent that was already issued).
    expect(fromRecipe.sort()).toEqual([RECONCILER, ROLLOUT_SERVICE].sort());
  });

  it('request_update reaches a device only from the request service', () => {
    const publishers: string[] = [];
    for (const path of productionSources()) {
      if (/command:\s*'request_update'/.test(read(path))) publishers.push(path);
    }
    expect(publishers).toEqual([REQUEST_SERVICE]);
  });
});
