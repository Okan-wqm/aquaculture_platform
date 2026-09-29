import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaceRoot = realpathSync(join(__dirname, '../../..'));
const cliPath = join(workspaceRoot, 'dist/tools/new-aria-admission/runtime/cli.js');
const temporaryRoots: string[] = [];

const projection = {
  schema_version: '1.0.0',
  contract_id: 'new-aria-completion-projection-v1',
  program_id: 'program-1',
  sprint_id: 'S01',
  state: 'DONE',
  status: 'OK',
  freshness: 'VALID_AT',
  verdict: 'ACCEPTED',
  verified_at: '2026-09-02T12:00:00.000Z',
  valid_from: '2026-09-02T12:30:00.000Z',
  valid_until: '2026-09-02T13:00:00.000Z',
  head_sha: 'a'.repeat(40),
  authority_sha256: 'b'.repeat(64),
  evidence_sha256: 'c'.repeat(64),
  event_chain_sha256: 'd'.repeat(64),
  attestation_sha256: 'e'.repeat(64),
  tail_event_hash: 'f'.repeat(64),
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('projection CLI', () => {
  it('rejects a caller-authored DONE projection without publishing output', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-projection-'));
    temporaryRoots.push(root);
    const input = join(root, 'input.json');
    const output = join(root, 'output.json');
    writeFileSync(input, JSON.stringify(projection));

    const result = spawnSync(
      process.execPath,
      [cliPath, 'project', '--input', input, '--output', output],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('{"execution_verdict":"FAILED"}\n');
    expect(() => realpathSync(output)).toThrow();
  });
});
