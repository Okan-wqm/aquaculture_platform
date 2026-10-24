/**
 * RW-2 — the runner's half of the privileged-probe contract.
 *
 * The invariant spec tests/invariants/dataflow-watchdog-privileged-probe.spec.ts
 * pins what the probe may do and that the runner starts no docker or psql.
 * These pin the seam between them: the document the real probe script prints
 * is the document the runner accepts (run against stub docker), the read-only
 * session reaches psql's environment, the socket client reads a real Unix
 * socket and refuses what it must, and the socket the client dials is the one
 * the installed units listen on, running the one install path the runbook
 * installs, with no argument.
 *
 * Run: npm run tools:test
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeFixtureTree, removeFixtureTree } from '../gates/fixture-tree.ts';
import {
  measurementOf,
  parsePrivilegedEvidence,
  PRIVILEGED_EVIDENCE_MAX_BYTES,
  PRIVILEGED_PROBE_SOCKET,
  PRIVILEGED_PROBE_TIMEOUT_MS,
  readPrivilegedEvidence,
} from './privileged-evidence.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE_SCRIPT = join(REPO_ROOT, 'infrastructure/scripts/aqua-dataflow-probe.sh');
const SOCKET_UNIT = join(REPO_ROOT, 'infrastructure/dataflow-probe/aqua-dataflow-probe.socket');
const SERVICE_UNIT = join(REPO_ROOT, 'infrastructure/dataflow-probe/aqua-dataflow-probe@.service');
const RUNBOOK = join(REPO_ROOT, 'docs/runbooks/monitoring/dataflow-integrity.md');
const INSTALL_PATH = '/usr/local/sbin/aqua-dataflow-probe';

const TENANTS = [
  { status: 'ACTIVE', schemaExists: true, tableCount: 42 },
  { status: 'PENDING', schemaExists: false, tableCount: 0 },
];

/**
 * Run the real probe with a stub `docker` first on PATH. The stub answers
 * `ps -q` with two ids, `inspect` with each one's State.Running, and `exec`
 * with the tenant rows — but only when psql receives the read-only session.
 */
function runProbeAgainstStubDocker({ dockerPsFails = false } = {}) {
  const root = makeFixtureTree('rw2-probe-seam-');
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const stub = join(bin, 'docker');
    writeFileSync(
      stub,
      [
        '#!/bin/bash',
        'case "$1" in',
        `  ps) ${dockerPsFails ? 'echo "permission denied" >&2; exit 1' : "printf 'c0ffee01\\nc0ffee02\\n'"} ;;`,
        '  inspect) if [ "$4" = c0ffee02 ]; then echo false; else echo true; fi ;;',
        '  exec)',
        '    [ "$2" = --env ] && [[ "$3" == *"default_transaction_read_only=on"* ]] || { echo "session not read-only" >&2; exit 1; }',
        `    printf '%s\\n' '${JSON.stringify(TENANTS)}' ;;`,
        '  *) exit 2 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(stub, 0o755);
    return spawnSync('bash', [PROBE_SCRIPT], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin` },
      timeout: 10000,
    });
  } finally {
    removeFixtureTree(root);
  }
}

function unitSetting(unitText, key) {
  const values = unitText
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
  assert.equal(values.length, 1, `${key}= appears exactly once`);
  return values[0];
}

test('the document the real probe prints is the document the runner accepts', () => {
  const run = runProbeAgainstStubDocker();
  assert.equal(run.status, 0, run.stderr);

  const evidence = parsePrivilegedEvidence(run.stdout);

  assert.deepEqual(measurementOf(evidence, 'container_state_truth'), {
    listed: 2,
    notRunningButListed: 1,
  });
  assert.deepEqual(measurementOf(evidence, 'tenant_reality_parity'), { tenants: TENANTS });
});

test('a failed measurement is reported as that probe error and never hides the other', () => {
  const run = runProbeAgainstStubDocker({ dockerPsFails: true });
  assert.equal(run.status, 0, run.stderr);

  const evidence = parsePrivilegedEvidence(run.stdout);

  assert.throws(
    () => measurementOf(evidence, 'container_state_truth'),
    /^Error: privileged probe: listing or inspecting the containers failed/,
  );
  assert.deepEqual(measurementOf(evidence, 'tenant_reality_parity'), { tenants: TENANTS });
});

test('a document outside the contract is refused, never defaulted', () => {
  const valid = {
    container_state_truth: { listed: 1, not_running_but_listed: 0 },
    tenant_reality_parity: { tenants: [] },
  };
  const broken = [
    'not json',
    '[]',
    JSON.stringify({ container_state_truth: valid.container_state_truth }),
    JSON.stringify({ ...valid, extra: {} }),
    JSON.stringify({ ...valid, container_state_truth: { listed: 1 } }),
    JSON.stringify({ ...valid, container_state_truth: { listed: -1, not_running_but_listed: 0 } }),
    JSON.stringify({ ...valid, tenant_reality_parity: { tenants: [{ status: 'ACTIVE' }] } }),
    JSON.stringify({ ...valid, tenant_reality_parity: { error: 'x', tenants: [] } }),
    JSON.stringify({ ...valid, tenant_reality_parity: { error: 42 } }),
  ];
  for (const text of broken) {
    assert.throws(() => parsePrivilegedEvidence(text), undefined, text);
  }
  assert.doesNotThrow(() => parsePrivilegedEvidence(JSON.stringify(valid)));
});

test('the client reads the whole answer from a Unix socket and sends nothing', async () => {
  const root = makeFixtureTree('rw2-probe-socket-');
  const path = join(root, 'probe.sock');
  const received = [];
  // The answer arrives in two writes, like a probe that prints as it measures.
  const server = createServer((connection) => {
    connection.on('data', (chunk) => received.push(chunk));
    connection.write('{"answer":');
    setTimeout(() => connection.end('1}\n'), 20);
  });
  try {
    await new Promise((resolveListen) => server.listen(path, resolveListen));

    assert.equal(await readPrivilegedEvidence(path, 5000), '{"answer":1}\n');
    assert.deepEqual(received, []);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    removeFixtureTree(root);
  }
});

test('the client refuses a missing socket, a silent probe and an oversized answer', async () => {
  const root = makeFixtureTree('rw2-probe-refuse-');
  const silentPath = join(root, 'silent.sock');
  const floodPath = join(root, 'flood.sock');
  const silent = createServer(() => {});
  const flood = createServer((connection) => {
    connection.end(Buffer.alloc(PRIVILEGED_EVIDENCE_MAX_BYTES + 1, 0x20));
  });
  try {
    await new Promise((r) => silent.listen(silentPath, r));
    await new Promise((r) => flood.listen(floodPath, r));

    await assert.rejects(readPrivilegedEvidence(join(root, 'absent.sock'), 1000), /ENOENT/);
    await assert.rejects(readPrivilegedEvidence(silentPath, 100), /no complete answer within/);
    await assert.rejects(readPrivilegedEvidence(floodPath, 5000), /exceeds/);
  } finally {
    await new Promise((r) => silent.close(r));
    await new Promise((r) => flood.close(r));
    removeFixtureTree(root);
  }
});

test('the client dials the socket the units install, which runs the one install path with no argument', () => {
  const socketUnit = readFileSync(SOCKET_UNIT, 'utf8');
  const serviceUnit = readFileSync(SERVICE_UNIT, 'utf8');

  assert.equal(unitSetting(socketUnit, 'ListenStream'), PRIVILEGED_PROBE_SOCKET);
  assert.equal(unitSetting(socketUnit, 'Accept'), 'yes');
  assert.equal(unitSetting(socketUnit, 'MaxConnections'), '1');
  assert.equal(unitSetting(socketUnit, 'SocketUser'), 'root');
  // The runner's primary group (Group=gharunner in the identity drop-in);
  // no other account may trigger the probe, and nobody may connect as "other".
  assert.equal(unitSetting(socketUnit, 'SocketGroup'), 'gharunner');
  assert.equal(unitSetting(socketUnit, 'SocketMode'), '0660');

  assert.equal(unitSetting(serviceUnit, 'ExecStart'), INSTALL_PATH);
  assert.equal(unitSetting(serviceUnit, 'StandardInput'), 'null');
  assert.equal(unitSetting(serviceUnit, 'StandardOutput'), 'socket');
  assert.doesNotMatch(serviceUnit, /^User=/m, 'the probe runs as root: the docker socket is root');
  const runtimeMaxMs = Number(unitSetting(serviceUnit, 'RuntimeMaxSec')) * 1000;
  assert.ok(
    runtimeMaxMs < PRIVILEGED_PROBE_TIMEOUT_MS,
    'the unit stops a hung probe before the client gives up, so the client sees the close',
  );

  const runbook = readFileSync(RUNBOOK, 'utf8');
  assert.match(
    runbook,
    /install -o root -g root -m 0755 infrastructure\/scripts\/aqua-dataflow-probe\.sh \/usr\/local\/sbin\/aqua-dataflow-probe\n/,
  );
});
