/**
 * Platform-wide invariant — every `secrets.<NAME>` a workflow depends on must
 * be declared in `.github/provisioned-secrets.json`, and every declared secret
 * must still be referenced by some workflow.
 *
 * # Why this exists
 *
 * Historically, `ARIA_GITHUB_APP_TOKEN` was referenced by scheduled workflows
 * without ever being provisioned. GitHub substituted an empty string, so each
 * workflow failed only after doing its real work. Publication now mints a
 * repository-scoped installation token from the environment-owned
 * `ARIA_GITHUB_APP_PRIVATE_KEY`; the long-lived token dependency is retired.
 *
 * A test cannot ask GitHub which secrets exist (no credentials at test time,
 * and secrets are write-only by design). What it CAN do is force the
 * dependency to be declared: the manifest is the authors' statement of "this
 * secret is expected to exist and here is where it comes from", so adding a
 * reference to a secret nobody provisioned fails at authoring time instead of
 * at 03:00 in a scheduled run.
 *
 * # What a failure means
 *
 * - Undeclared secret: either provision it and add it to the manifest with the
 *   scope it lives in, or stop referencing it.
 * - Orphaned declaration: the last workflow that used the secret is gone —
 *   delete the entry (and consider revoking the secret) so the manifest keeps
 *   describing reality.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const workflowsDir = join(repoRoot, '.github/workflows');
const manifestPath = join(repoRoot, '.github/provisioned-secrets.json');

/** `secrets.GITHUB_TOKEN` is minted by Actions for every run; it is never provisioned by an operator. */
const ACTIONS_BUILT_IN = new Set(['GITHUB_TOKEN']);

interface SecretDeclaration {
  readonly scope: string;
  readonly provisioned: boolean;
  readonly why: string;
}

interface Manifest {
  readonly secrets: Record<string, SecretDeclaration>;
}

function workflowFiles(): string[] {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

function referencedSecrets(): Map<string, string[]> {
  const references = new Map<string, string[]>();
  for (const file of workflowFiles()) {
    const contents = readFileSync(join(workflowsDir, file), 'utf8');
    for (const match of contents.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      const [, name] = match;
      if (name === undefined || ACTIONS_BUILT_IN.has(name)) continue;
      const seenIn = references.get(name) ?? [];
      if (!seenIn.includes(file)) seenIn.push(file);
      references.set(name, seenIn);
    }
  }
  return references;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
}

describe('workflow secret provisioning', () => {
  it('declares every secret the workflows reference', () => {
    const declared = new Set(Object.keys(manifest().secrets));
    const undeclared = [...referencedSecrets().entries()]
      .filter(([name]) => !declared.has(name))
      .map(([name, files]) => `${name} (referenced by ${files.join(', ')})`);

    expect(undeclared).toEqual([]);
  });

  it('has no declaration whose last workflow reference is gone', () => {
    const referenced = referencedSecrets();
    const orphaned = Object.keys(manifest().secrets).filter((name) => !referenced.has(name));

    expect(orphaned).toEqual([]);
  });

  it('names every workflow that depends on each declared secret', () => {
    const referenced = referencedSecrets();
    const drifted: string[] = [];
    for (const [name, declaration] of Object.entries(manifest().secrets)) {
      const actual = (referenced.get(name) ?? []).join(', ');
      if (declaration.why.includes('used by') && !declaration.why.includes(actual)) {
        drifted.push(`${name}: manifest says "${declaration.why}", workflows say "${actual}"`);
      }
    }

    expect(drifted).toEqual([]);
  });

  it('explains where each declared secret lives', () => {
    for (const [name, declaration] of Object.entries(manifest().secrets)) {
      expect(typeof declaration.scope).toBe('string');
      expect(declaration.scope.length).toBeGreaterThan(0);
      expect(typeof declaration.provisioned).toBe('boolean');
      expect(`${name}: ${declaration.why}`.length).toBeGreaterThan(name.length + 20);
    }
  });
});
