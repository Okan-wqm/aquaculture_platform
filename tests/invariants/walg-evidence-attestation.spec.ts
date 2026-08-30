import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TOOL = join(REPO_ROOT, 'tools/scripts/database/walg-evidence-attestation.mjs');
const MAIN_SHA = 'a'.repeat(40);
const SOURCE_IMAGE_REVISION = '9'.repeat(40);
const POSTGRES_DR_CONTRACT_SHA256 = 'f'.repeat(64);

function run(args: string[]) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

describe('WAL-G GitHub OIDC/Rekor evidence attestation contract', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aqua-walg-attestation-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function createSuccessfulRun(): string {
    const output = join(directory, 'run.json');
    const result = run([
      'create-run',
      '--output',
      output,
      '--workflow',
      'backup-production.yml',
      '--workflow-name',
      'Backup - Production Postgres',
      '--repository',
      'Okan-wqm/aquaculture_platform',
      '--ref',
      'refs/heads/main',
      '--sha',
      MAIN_SHA,
      '--run-id',
      '123',
      '--run-attempt',
      '2',
      '--event-name',
      'schedule',
      '--job-result',
      'success',
      '--mode',
      'full_backup',
      '--issued-at',
      '2026-07-16T03:30:00Z',
    ]);
    expect(result.status).toBe(0);
    return output;
  }

  function writeApiRun(overrides: Record<string, unknown> = {}): string {
    const path = join(directory, 'api-run.json');
    writeFileSync(
      path,
      `${JSON.stringify({
        id: 123,
        run_attempt: 2,
        head_sha: MAIN_SHA,
        head_branch: 'main',
        event: 'schedule',
        path: '.github/workflows/backup-production.yml',
        name: 'Backup - Production Postgres',
        workflow_id: 261067403,
        repository: {
          id: 1132698735,
          full_name: 'Okan-wqm/aquaculture_platform',
        },
        status: 'completed',
        conclusion: 'success',
        run_started_at: '2026-07-16T03:00:00Z',
        updated_at: '2026-07-16T03:31:00Z',
        ...overrides,
      })}\n`,
    );
    return path;
  }

  function writeApiWorkflow(): string {
    const path = join(directory, 'api-workflow.json');
    writeFileSync(
      path,
      `${JSON.stringify({
        id: 261067403,
        name: 'Backup - Production Postgres',
        path: '.github/workflows/backup-production.yml',
        state: 'active',
      })}\n`,
    );
    return path;
  }

  it('binds a promoted base backup to the exact successful main workflow run', () => {
    const runRecord = createSuccessfulRun();
    const evidence = join(directory, 'base.json');
    const attestation = join(directory, 'attestation.json');
    const extracted = join(directory, 'extracted.json');
    writeFileSync(
      evidence,
      `${JSON.stringify({
        schema_version: 1,
        evidence_type: 'base_backup',
        run_id: 'gha-123-2',
        main_sha: MAIN_SHA,
        status: 'success',
        source_image_revision: SOURCE_IMAGE_REVISION,
        source_postgres_dr_contract_sha256: POSTGRES_DR_CONTRACT_SHA256,
        full: true,
        verified: true,
        wal_verified: true,
      })}\n`,
    );

    const created = run([
      'create-evidence',
      '--output',
      attestation,
      '--run-record',
      runRecord,
      '--evidence',
      evidence,
    ]);
    expect(created.status).toBe(0);
    expect(JSON.parse(readFileSync(attestation, 'utf8'))).toMatchObject({
      source_transport: {
        type: 'native_openssh_stdout',
        client: 'system_openssh',
        host_key_verification: 'protected_sha256_fingerprint_exact_match',
      },
    });
    expect(readFileSync(attestation, 'utf8')).not.toMatch(/appleboy|ssh-action/);

    const apiRun = writeApiRun();
    const apiWorkflow = writeApiWorkflow();
    expect(
      run([
        'verify-run',
        '--run-record',
        runRecord,
        '--api-run',
        apiRun,
        '--api-workflow',
        apiWorkflow,
      ]).status,
    ).toBe(0);
    expect(
      run([
        'extract-evidence',
        '--attestation',
        attestation,
        '--run-record',
        runRecord,
        '--api-run',
        apiRun,
        '--api-workflow',
        apiWorkflow,
        '--output',
        extracted,
      ]).status,
    ).toBe(0);
    expect(JSON.parse(readFileSync(extracted, 'utf8'))).toMatchObject({
      run_id: 'gha-123-2',
      main_sha: MAIN_SHA,
      status: 'success',
    });

    const tamperedAttestation = join(directory, 'tampered-attestation.json');
    const tampered = JSON.parse(readFileSync(attestation, 'utf8')) as Record<string, unknown>;
    tampered.source_transport = {
      type: 'native_openssh_stdout',
      client: 'system_openssh',
      host_key_verification: 'accept_new',
      sha256: 'b'.repeat(64),
      bytes: 1,
    };
    writeFileSync(tamperedAttestation, `${JSON.stringify(tampered)}\n`);
    expect(
      run([
        'extract-evidence',
        '--attestation',
        tamperedAttestation,
        '--run-record',
        runRecord,
        '--api-run',
        apiRun,
        '--api-workflow',
        apiWorkflow,
        '--output',
        join(directory, 'tampered-extracted.json'),
      ]).status,
    ).not.toBe(0);
  });

  it('rejects successful evidence without nonzero image and DR-contract provenance', () => {
    const runRecord = createSuccessfulRun();
    const invalidAuthorities = [
      {
        source_image_revision: '0'.repeat(40),
        source_postgres_dr_contract_sha256: POSTGRES_DR_CONTRACT_SHA256,
      },
      {
        source_image_revision: SOURCE_IMAGE_REVISION,
        source_postgres_dr_contract_sha256: 'not-a-sha256',
      },
      {
        source_image_revision: SOURCE_IMAGE_REVISION,
        source_dr_contract_sha256: POSTGRES_DR_CONTRACT_SHA256,
      },
    ];
    invalidAuthorities.forEach((authority, index) => {
      const evidence = join(directory, `invalid-authority-${index}.json`);
      writeFileSync(
        evidence,
        `${JSON.stringify({
          schema_version: 1,
          evidence_type: 'base_backup',
          run_id: 'gha-123-2',
          main_sha: MAIN_SHA,
          status: 'success',
          full: true,
          verified: true,
          wal_verified: true,
          ...authority,
        })}\n`,
      );
      expect(
        run([
          'create-evidence',
          '--output',
          join(directory, `invalid-attestation-${index}.json`),
          '--run-record',
          runRecord,
          '--evidence',
          evidence,
        ]).status,
      ).not.toBe(0);
    });
  });

  it('rejects non-main authority, GitHub API drift, and failed evidence promotion', () => {
    const branchRecord = join(directory, 'branch.json');
    const branch = run([
      'create-run',
      '--output',
      branchRecord,
      '--workflow',
      'backup-production.yml',
      '--workflow-name',
      'Backup - Production Postgres',
      '--repository',
      'Okan-wqm/aquaculture_platform',
      '--ref',
      'refs/heads/feature',
      '--sha',
      MAIN_SHA,
      '--run-id',
      '123',
      '--run-attempt',
      '1',
      '--event-name',
      'workflow_dispatch',
      '--job-result',
      'success',
      '--mode',
      'full_backup',
      '--issued-at',
      '2026-07-16T03:30:00Z',
    ]);
    expect(branch.status).not.toBe(0);
    expect(branch.stderr).toContain('refs/heads/main');

    const runRecord = createSuccessfulRun();
    expect(
      run([
        'verify-run',
        '--run-record',
        runRecord,
        '--api-run',
        writeApiRun({ head_sha: 'b'.repeat(40) }),
        '--api-workflow',
        writeApiWorkflow(),
      ]).status,
    ).not.toBe(0);

    const failedRecord = join(directory, 'failed.json');
    expect(
      run([
        'create-run',
        '--output',
        failedRecord,
        '--workflow',
        'backup-production.yml',
        '--workflow-name',
        'Backup - Production Postgres',
        '--repository',
        'Okan-wqm/aquaculture_platform',
        '--ref',
        'refs/heads/main',
        '--sha',
        MAIN_SHA,
        '--run-id',
        '124',
        '--run-attempt',
        '1',
        '--event-name',
        'schedule',
        '--job-result',
        'failure',
        '--mode',
        'full_backup',
        '--issued-at',
        '2026-07-16T03:30:00Z',
      ]).status,
    ).toBe(0);

    const evidence = join(directory, 'base.json');
    writeFileSync(
      evidence,
      `${JSON.stringify({
        schema_version: 1,
        evidence_type: 'base_backup',
        run_id: 'gha-124-1',
        main_sha: MAIN_SHA,
        status: 'success',
        source_image_revision: SOURCE_IMAGE_REVISION,
        source_postgres_dr_contract_sha256: POSTGRES_DR_CONTRACT_SHA256,
        full: true,
        verified: true,
        wal_verified: true,
      })}\n`,
    );
    expect(
      run([
        'create-evidence',
        '--output',
        join(directory, 'forged.json'),
        '--run-record',
        failedRecord,
        '--evidence',
        evidence,
      ]).status,
    ).not.toBe(0);
  });
});
