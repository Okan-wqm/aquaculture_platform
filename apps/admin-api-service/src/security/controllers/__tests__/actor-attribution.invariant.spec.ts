/**
 * APA-247 — actor attribution on audit-relevant mutations must be derived from
 * the RS256-verified JWT (getAuthUser(req)), never hardcoded. Retention-policy
 * create/update and incident update previously stamped the actor as the literal
 * 'admin' / 'Admin User' (with a "Would come from auth context" placeholder), so
 * every such mutation's audit record attributed a real operator's action to a
 * fictitious identity — defeating audit-trail integrity.
 *
 * This gate fails if any security controller reintroduces a literal actor
 * argument or the placeholder comment.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/security.md#APA-247
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const controllersDir = join(__dirname, '..');
const controllerFiles = readdirSync(controllersDir)
  .filter((f) => f.endsWith('.controller.ts'))
  .map((f) => join(controllersDir, f));

describe('security controllers: no hardcoded actor identity (APA-247)', () => {
  it('discovers the audit-trail and security-monitoring controllers', () => {
    expect(controllerFiles.length).toBeGreaterThanOrEqual(2);
  });

  it.each(controllerFiles)('%s derives actor from JWT, not literals', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/Would come from auth context/);
    expect(src).not.toMatch(/createdBy:\s*['"]admin['"]/);
    expect(src).not.toMatch(/['"]Admin User['"]/);
    expect(src).not.toMatch(/updateRetentionPolicy\([^)]*['"]admin['"]/);
  });
});
