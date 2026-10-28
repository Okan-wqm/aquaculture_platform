/**
 * The edge release signs with cosign's legacy outputs (`--output-signature`, `--output-certificate`):
 * the release manifest, the Sens enterprise release gate and the operator runbooks consume the
 * resulting `.sig` and `.pem` files. cosign v3 writes a Sigstore bundle and ignores those flags, and
 * a dependency bump (#284, 2026-06-10) moved the installer's default from cosign v2 to v3 without any
 * pull-request job signing anything. agent-v2.0.0-rc.7 (run 40685042259) built all three archives and
 * then failed in "Sign release artifacts with cosign": `create bundle file: open : no such file or
 * directory`.
 *
 * This spec makes the contract detectable at pull-request time: while the edge release signs with the
 * legacy outputs, its cosign installer step pins a v2 release.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RELEASE_WORKFLOW = '.github/workflows/edge-agent-release.yml';
const INSTALLER = 'sigstore/cosign-installer';
const LEGACY_FLAGS = ['--output-signature', '--output-certificate'];

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/** True when any `cosign sign-blob` command of the workflow writes the legacy signature files. */
export function signsWithLegacyFiles(workflow: string): boolean {
  const signCommands = workflow.split(/\bcosign\s+sign-blob\b/).slice(1);
  return signCommands.some((rest) => {
    // The command runs to the first line that does not end with a line continuation.
    const lines = rest.split('\n');
    const end = lines.findIndex((line) => !line.trimEnd().endsWith('\\'));
    const command = lines.slice(0, end === -1 ? lines.length : end + 1).join('\n');
    return LEGACY_FLAGS.some((flag) => command.includes(flag));
  });
}

/** The `cosign-release` input of the step that uses the cosign installer, or undefined. */
export function installerCosignRelease(workflow: string): string | undefined {
  const lines = workflow.split('\n');
  const at = lines.findIndex((line) => line.includes(`uses: ${INSTALLER}@`));
  if (at === -1) {
    return undefined;
  }
  const indent = (lines[at] ?? '').length - (lines[at] ?? '').trimStart().length;
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    if (line.length - line.trimStart().length < indent) {
      break; // left the step
    }
    const match = /^\s*cosign-release:\s*['"]?([^'"\s#]+)['"]?/.exec(line);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

export function isV2Release(release: string | undefined): boolean {
  return release !== undefined && /^v2\.\d+\.\d+$/.test(release);
}

describe('edge release: the cosign line matches the signature files it writes', () => {
  describe('the checks themselves', () => {
    const legacy = [
      '      - name: Sign',
      '        run: |',
      '          cosign sign-blob \\',
      '            --yes \\',
      '            --output-certificate "${file}.pem" \\',
      '            --output-signature "${file}.sig" \\',
      '            "${file}"',
    ].join('\n');
    const bundle = [
      '        run: |',
      '          cosign sign-blob --yes \\',
      '            --bundle "${SUBJECT}.sigstore.json" \\',
      '            "${SUBJECT}"',
    ].join('\n');

    it('tells a legacy signing command from a bundle one', () => {
      expect(signsWithLegacyFiles(legacy)).toBe(true);
      expect(signsWithLegacyFiles(bundle)).toBe(false);
      expect(signsWithLegacyFiles('echo no signing here')).toBe(false);
    });

    it('does not read a flag of a later command as part of an earlier one', () => {
      const mixed = `${bundle}\n        run: |\n          echo --output-signature is only text here\n`;
      expect(signsWithLegacyFiles(mixed)).toBe(false);
    });

    it('reads the pin of the installer step only, in quoted and unquoted spelling', () => {
      const pinned = [
        '      - name: Install cosign',
        '        uses: sigstore/cosign-installer@abc # v4.1.2',
        '        with:',
        '          # a comment',
        '          cosign-release: v2.6.5',
        '      - name: Next',
        '        with:',
        '          cosign-release: v3.0.6',
      ].join('\n');
      expect(installerCosignRelease(pinned)).toBe('v2.6.5');
      expect(installerCosignRelease(pinned.replace('v2.6.5', "'v2.6.5'"))).toBe('v2.6.5');
      expect(
        installerCosignRelease('      - uses: sigstore/cosign-installer@abc\n      - run: x\n'),
      ).toBeUndefined();
      expect(installerCosignRelease('      - run: x\n')).toBeUndefined();
    });

    it('accepts a v2 line only', () => {
      expect(isV2Release('v2.6.5')).toBe(true);
      expect(isV2Release('v3.0.6')).toBe(false);
      expect(isV2Release('v2.6')).toBe(false);
      expect(isV2Release('main')).toBe(false);
      expect(isV2Release(undefined)).toBe(false);
    });
  });

  describe('the repository', () => {
    const workflow = read(RELEASE_WORKFLOW);

    it('still writes the legacy signature files (otherwise delete this contract with the pin)', () => {
      expect(signsWithLegacyFiles(workflow)).toBe(true);
    });

    it('pins a cosign v2 release while it does', () => {
      expect(isV2Release(installerCosignRelease(workflow))).toBe(true);
    });
  });
});
