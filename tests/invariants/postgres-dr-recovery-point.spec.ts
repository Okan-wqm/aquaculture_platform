import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const helper = resolve(__dirname, '../../infrastructure/scripts/postgres-dr-recovery.sh');
const coordinator = resolve(__dirname, '../../infrastructure/scripts/postgres-dr-coordinator.sh');

describe('PostgreSQL cold recovery point', () => {
  it.each([
    { copies: 3, available: '12884901888', status: 65 }, // Old budget: two extra 5 GiB copies and headroom.
    { copies: 3, available: '18253611007', status: 65 },
    { copies: 3, available: '18253611008', status: 0 }, // Three extra 5 GiB copies plus 20% and 1 GiB.
    { copies: 1, available: '7516192767', status: 65 },
    { copies: 1, available: '7516192768', status: 0 }, // A further retained rollback requires another complete copy.
  ])(
    'enforces the $copies-copy peak at $available available bytes',
    ({ copies, available, status }) => {
      const result = spawnSync(
        '/bin/bash',
        [
          '-c',
          `
      set +e
      source "$1"
      dr_cluster_copy_bytes() { printf 5368709120; }
      df() { printf 'Avail\\n%s\\n' "$AVAILABLE_BYTES"; }
      AVAILABLE_BYTES=$3
      dr_require_copy_capacity fixture "$2" fixture
      exit $?
    `,
          '--',
          helper,
          String(copies),
          available,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(status);
    },
  );

  it('copies the complete stopped cluster including legacy TLS bytes without modifying the source', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cold-copy-'));
    try {
      const source = join(root, 'source');
      const destination = join(root, 'point');
      mkdirSync(source);
      mkdirSync(destination);
      writeFileSync(join(source, 'PG_VERSION'), '16\n');
      writeFileSync(join(source, 'server.key'), 'fixture-private-key\n', { mode: 0o600 });
      const result = spawnSync(
        '/bin/bash',
        ['-c', 'source "$1"; dr_copy_cluster "$2" "$3"', '--', helper, source, destination],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      expect(readFileSync(join(source, 'server.key'), 'utf8')).toBe('fixture-private-key\n');
      expect(readFileSync(join(destination, 'server.key'), 'utf8')).toBe('fixture-private-key\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a cluster with an uncaptured external tablespace instead of claiming a complete backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cold-copy-'));
    try {
      mkdirSync(join(root, 'source'));
      mkdirSync(join(root, 'point'));
      writeFileSync(join(root, 'source', 'PG_VERSION'), '16\n');
      symlinkSync('/uncaptured/tablespace', join(root, 'source', 'tablespace'));
      const result = spawnSync(
        '/bin/bash',
        [
          '-c',
          'source "$1"; dr_copy_cluster "$2" "$3"',
          '--',
          helper,
          join(root, 'source'),
          join(root, 'point'),
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a verified recovery-point binding before the durable mutation phase', () => {
    const script = readFileSync(
      resolve(__dirname, '../../infrastructure/scripts/postgres-dr-coordinator.sh'),
      'utf8',
    );
    const preparation = script.indexOf('prepare_postgres_recovery_point');
    const mutation = script.indexOf('"${STATE_PATH}" PREPARED FORWARD_STARTED');
    expect(preparation).toBeGreaterThan(0);
    expect(mutation).toBeGreaterThan(preparation);
    expect(script).toContain('verify_postgres_recovery_point');
    expect(script).toContain('RECOVERY_REQUIRED');
  });

  it.each(['chmod', 'sync', 'mv'])(
    'does not publish a result when %s fails with rollback errexit disabled',
    (failingCommand) => {
      const root = mkdtempSync(join(tmpdir(), 'aqua-recovery-publish-'));
      try {
        const staged = join(root, 'staged');
        const published = join(root, 'result.json');
        writeFileSync(staged, 'uncommitted\n');
        writeFileSync(published, 'prior-durable-result\n');
        const result = spawnSync(
          '/bin/bash',
          [
            '-c',
            `
        set +e
        source "$1"
        STATE_DIR=$2
        FAIL_COMMAND=$3
        STAGED_PATH=$4
        chmod() { [ "$FAIL_COMMAND" != chmod ] || return 73; command chmod "$@"; }
        sync() { if [ "$FAIL_COMMAND" = sync ] && [ "$2" = "$STAGED_PATH" ]; then return 73; fi; command sync "$@"; }
        mv() { [ "$FAIL_COMMAND" != mv ] || return 73; command mv "$@"; }
        publish_state_file "$4" "$5"
        exit $?
      `,
            '--',
            coordinator,
            root,
            failingCommand,
            staged,
            published,
          ],
          { encoding: 'utf8' },
        );
        expect(result.status).toBe(73);
        expect(readFileSync(published, 'utf8')).toBe('prior-durable-result\n');
        expect(readFileSync(staged, 'utf8')).toBe('uncommitted\n');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('refuses rollback before data restoration when authority or baseline rendering fails', () => {
    for (const failure of ['authority', 'render']) {
      const result = spawnSync(
        '/bin/bash',
        [
          '-c',
          `
        set +e
        source "$1"
        STATE_PATH=fixture
        ROLLBACK_OVERRIDE=fixture-override
        RUN_KEY=fixture
        FAIL_AT=$2
        dr_state_phase() { printf FORWARD_STARTED; }
        dr_state_prior_image_id() { printf 'sha256:%064d' 1; }
        dr_state_candidate_image_id() { printf 'sha256:%064d' 2; }
        docker() { [ "$1 $2" = 'image inspect' ] || { printf unexpected-docker; return 99; }; }
        require_execution_boundaries() { [ "$FAIL_AT" != authority ] || return 73; }
        render_image_override() { [ "$FAIL_AT" != render ] || return 73; }
        configure_rollback_compose() { printf unexpected-configuration; return 99; }
        recover_exact_prior
        exit $?
      `,
          '--',
          coordinator,
          failure,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(73);
      expect(result.stdout).toBe('');
    }
  });
});
