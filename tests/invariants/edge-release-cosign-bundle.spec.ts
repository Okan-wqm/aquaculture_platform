/**
 * The edge agent release signs its artifacts with cosign keyless signing. sigstore/cosign-installer
 * installs cosign 3 by default, and cosign 3 writes a single Sigstore bundle (`--bundle`); it
 * ignores `--output-signature` / `--output-certificate`. The release workflow still used the
 * legacy flags, so tag agent-v2.0.0-rc.7 built all three targets and then failed in the signing
 * step ("create bundle file: open : no such file or directory"), and no release was created.
 * No pull-request job signs anything, so the break could only show on a tag.
 *
 * This spec makes the contract detectable at pull-request time: every `cosign sign-blob` of the
 * release workflow writes a bundle, none uses the legacy flags, the release manifest requires the
 * bundle of every signed artifact, and the bundles are uploaded with the release.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RELEASE_WORKFLOW = '.github/workflows/edge-agent-release.yml';

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/** Every `cosign sign-blob` command of a workflow, with shell line continuations joined. */
export function signBlobInvocations(workflow: string): string[] {
  const joined = workflow.replace(/\\\r?\n\s*/g, ' ');
  return joined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('cosign sign-blob'));
}

/** True when a signing command uses a flag cosign 3 ignores. */
export function usesLegacySignatureFlags(command: string): boolean {
  return /--output-(signature|certificate)\b/.test(command);
}

/** True when a signing command writes a Sigstore bundle. */
export function writesBundle(command: string): boolean {
  return /--bundle\s+\S+\.sigstore\.json\b/.test(command);
}

/** The `requireFile(...)` names of the release manifest generator. */
export function manifestRequiredFiles(workflow: string): string[] {
  return [...workflow.matchAll(/requireFile\(`([^`]+)`\)/g)].map((match) => match[1] ?? '');
}

/** True when the release uploads the bundles. */
export function uploadsBundles(workflow: string): boolean {
  return /^\s*artifacts\/\*\.sigstore\.json\s*$/m.test(workflow);
}

describe('edge release: signing writes the Sigstore bundles cosign 3 produces', () => {
  describe('the checks themselves', () => {
    it('finds sign-blob commands across line continuations and ignores other cosign commands', () => {
      const workflow = [
        '          cosign sign-blob \\',
        '            --yes \\',
        '            --bundle "${file}.sigstore.json" \\',
        '            "${file}"',
        '          cosign verify-blob --bundle x.sigstore.json x',
      ].join('\n');
      const found = signBlobInvocations(workflow);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('--yes');
    });

    it('rejects the legacy output flags and wants a named bundle', () => {
      const legacy =
        'cosign sign-blob --yes --output-signature a.sig --output-certificate a.pem a.tar.gz';
      const bundled = 'cosign sign-blob --yes --bundle "a.tar.gz.sigstore.json" a.tar.gz';
      expect(usesLegacySignatureFlags(legacy)).toBe(true);
      expect(writesBundle(legacy)).toBe(false);
      expect(usesLegacySignatureFlags(bundled)).toBe(false);
      expect(writesBundle(bundled)).toBe(true);
    });

    it('does not take a bundle flag without a .sigstore.json path as a bundle', () => {
      expect(writesBundle('cosign sign-blob --yes --bundle out.json a.tar.gz')).toBe(false);
    });

    it('lists the files a manifest generator requires', () => {
      const generator = ['requireFile(`${base}.tar.gz`)', 'requireFile(`${base}.tar.gz.sig`)'].join(
        '\n',
      );
      expect(manifestRequiredFiles(generator)).toEqual(['${base}.tar.gz', '${base}.tar.gz.sig']);
    });

    it('wants the bundle glob as an upload entry, not a mention', () => {
      expect(uploadsBundles('          files: |\n            artifacts/*.sigstore.json\n')).toBe(
        true,
      );
      expect(uploadsBundles('# artifacts/*.sigstore.json is uploaded')).toBe(false);
      expect(uploadsBundles('            artifacts/*.sig\n')).toBe(false);
    });
  });

  describe('the release workflow', () => {
    const workflow = read(RELEASE_WORKFLOW);
    const invocations = signBlobInvocations(workflow);

    it('signs the artifacts and the release manifest (otherwise this contract is stale)', () => {
      expect(invocations.length).toBeGreaterThanOrEqual(2);
    });

    it('writes a bundle on every cosign sign-blob and uses no flag cosign 3 ignores', () => {
      for (const command of invocations) {
        expect(usesLegacySignatureFlags(command)).toBe(false);
        expect(writesBundle(command)).toBe(true);
      }
    });

    it('requires the bundle of every signed artifact in the release manifest', () => {
      const required = manifestRequiredFiles(workflow);
      for (const signed of [
        '${base}.tar.gz',
        '${base}.cargo-metadata.sbom.json',
        '${base}.intoto.jsonl',
        '${base}.NOTICE.md',
      ]) {
        expect(required).toContain(`${signed}.sigstore.json`);
      }
      expect(required.filter((name) => /\.(sig|pem)$/.test(name))).toEqual([]);
    });

    it('uploads the bundles with the release', () => {
      expect(uploadsBundles(workflow)).toBe(true);
    });
  });
});
