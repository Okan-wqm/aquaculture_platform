/**
 * The runner side of the dataflow watchdog's privileged probe (RW-2).
 *
 * WHY. container_state_truth and tenant_reality_parity need facts only root
 * can read on the droplet: per-container State.Running from the docker daemon
 * and the tenant rows in Postgres. The runner account has neither, by design:
 * docker-group membership is root by another name, and the runner unit runs
 * with NoNewPrivileges=yes and no supplementary group (ADR-0023,
 * scripts/aria/runner-habitat/systemd/actions-runner.identity.conf), so sudo
 * is inert for every job. Root measures instead:
 * infrastructure/scripts/aqua-dataflow-probe.sh, installed root-owned and run
 * per connection by the socket-activated unit in infrastructure/dataflow-probe/
 * (docs/runbooks/monitoring/dataflow-integrity.md, "Privileged probe install").
 * The socket is root:gharunner 0660 and the probe ignores everything the
 * client sends, so connecting can trigger the fixed read-only measurement and
 * nothing else.
 *
 * This module owns the runner's half of that contract: where the socket is,
 * how its answer is read, and the shape the answer must have. The judgement
 * (what pages whom) stays with the callers: probe-runner.mjs and
 * tenant-reality.mjs.
 */
import { createConnection } from 'node:net';

import { tenantRealityRows } from './tenant-reality.mjs';

/** Where the socket unit listens (ListenStream= of aqua-dataflow-probe.socket). */
export const PRIVILEGED_PROBE_SOCKET = '/run/aqua-dataflow-probe.sock';

/** The probe's unit stops it after 60 s (RuntimeMaxSec=); the client waits a little longer. */
export const PRIVILEGED_PROBE_TIMEOUT_MS = 75_000;

/** A bound on what the client buffers: the document is a few hundred bytes per tenant. */
export const PRIVILEGED_EVIDENCE_MAX_BYTES = 1024 * 1024;

/** The two measurement ids the probe answers for, in the document's key order. */
export const PRIVILEGED_PROBE_IDS = Object.freeze([
  'container_state_truth',
  'tenant_reality_parity',
]);

/**
 * Connect, send nothing, read the probe's whole answer.
 *
 * @param {string} socketPath
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
export function readPrivilegedEvidence(socketPath, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    const socket = createConnection(socketPath);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`privileged probe gave no complete answer within ${timeoutMs} ms`));
    });
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > PRIVILEGED_EVIDENCE_MAX_BYTES) {
        socket.destroy(
          new Error(`privileged probe answer exceeds ${PRIVILEGED_EVIDENCE_MAX_BYTES} bytes`),
        );
        return;
      }
      chunks.push(chunk);
    });
    socket.on('error', rejectPromise);
    // The answer is complete when the probe exits and systemd closes the
    // connection. The client writes nothing: the probe reads nothing
    // (StandardInput=null), and a half-close would be a second signal for the
    // server side to interpret.
    socket.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
  });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireCount(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`privileged evidence: ${field} is not a non-negative integer`);
  }
  return value;
}

const MEASUREMENT_READERS = {
  container_state_truth: (value) => ({
    listed: requireCount(value.listed, 'container_state_truth.listed'),
    notRunningButListed: requireCount(
      value.not_running_but_listed,
      'container_state_truth.not_running_but_listed',
    ),
  }),
  tenant_reality_parity: (value) => ({ tenants: tenantRealityRows(value.tenants) }),
};

/**
 * Validate the probe's document. Each measurement is either its value or the
 * probe's own `{error}`; anything else is a broken contract and throws.
 *
 * @param {string} text
 * @returns {Record<string, {value: object} | {error: string}>}
 */
export function parsePrivilegedEvidence(text) {
  const document = JSON.parse(text);
  if (!isPlainObject(document)) throw new Error('privileged evidence is not a JSON object');
  const keys = Object.keys(document).sort();
  if (keys.join(',') !== [...PRIVILEGED_PROBE_IDS].sort().join(',')) {
    throw new Error(`privileged evidence carries ${keys.join(',')}, not ${PRIVILEGED_PROBE_IDS}`);
  }
  return Object.fromEntries(
    PRIVILEGED_PROBE_IDS.map((id) => {
      const entry = document[id];
      if (!isPlainObject(entry)) throw new Error(`privileged evidence: ${id} is not an object`);
      if ('error' in entry) {
        if (typeof entry.error !== 'string' || Object.keys(entry).length !== 1) {
          throw new Error(`privileged evidence: ${id} carries a malformed error`);
        }
        return [id, { error: entry.error }];
      }
      return [id, { value: MEASUREMENT_READERS[id](entry) }];
    }),
  );
}

/**
 * The measurement for one probe id; the probe's own error becomes this
 * probe's error, reported by the caller as probe-error.
 *
 * @param {Record<string, {value: object} | {error: string}>} evidence
 * @param {string} id
 */
export function measurementOf(evidence, id) {
  const entry = evidence[id];
  if ('error' in entry) throw new Error(`privileged probe: ${entry.error}`);
  return entry.value;
}
