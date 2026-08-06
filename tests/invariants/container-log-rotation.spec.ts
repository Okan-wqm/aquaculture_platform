/**
 * Platform-wide invariant — every service in the production compose file must
 * bound its container log.
 *
 * # Why this exists
 *
 * Docker's default `json-file` driver performs no rotation at all, and this
 * platform never shipped a `daemon.json` that set one. Measured on the
 * production droplet 2026-08-06: 2.0 GB of `*-json.log` across the running
 * stack, `aqua-auth` alone at 658 MB and still growing, on a host at 94% with
 * 11 GB free. Nothing in the system would ever have stopped that growth except
 * the disk filling up — which it had already done once, on 2026-08-04.
 *
 * The capacity gate (`deploy-capacity-maintenance.yml`) measures free space and
 * so it sees the symptom far too late; `ORPHAN-HIGH-417` records that it could
 * not see the two consumers that actually filled the droplet, and container
 * logs were a third it never named either. A gate that reacts to a full disk is
 * not a substitute for a ceiling that makes it impossible to fill this way.
 *
 * A compose anchor sets that ceiling once. This test is what keeps it true: a
 * service added later inherits the ceiling or fails here, rather than being
 * discovered as an unbounded writer months afterwards.
 *
 * # What a failure means
 *
 * - Service without `logging`: add `logging: *default-logging` to it. If it
 *   genuinely needs different retention, give it explicit bounded options and
 *   say why — an unbounded log is the one thing this test will not accept.
 * - Missing or unbounded option: `max-size` caps a single file and `max-file`
 *   caps how many are kept. Without BOTH, the total is unbounded no matter what
 *   the other one says.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';

const repoRoot = resolve(__dirname, '../..');
const composePath = join(repoRoot, 'docker-compose.droplet.yml');

interface LoggingConfig {
  readonly driver?: string;
  readonly options?: Record<string, string>;
}

interface ComposeFile {
  readonly services: Record<string, { readonly logging?: LoggingConfig }>;
}

function compose(): ComposeFile {
  return parse(readFileSync(composePath, 'utf8')) as ComposeFile;
}

/** `20m`, `512k`, `1g` — a docker size string that is a real finite bound. */
const BOUNDED_SIZE = /^\d+(\.\d+)?[kmg]?$/i;

describe('container log rotation', () => {
  it('bounds the log of every production service', () => {
    const unbounded = Object.entries(compose().services)
      .filter(([, service]) => service.logging === undefined)
      .map(([name]) => name);

    expect(unbounded).toEqual([]);
  });

  it('caps both the size of a log file and how many are kept', () => {
    const defective: string[] = [];
    for (const [name, service] of Object.entries(compose().services)) {
      const options = service.logging?.options;
      if (options === undefined) {
        defective.push(`${name}: logging declares no options`);
        continue;
      }
      const maxSize = options['max-size'];
      const maxFile = options['max-file'];
      // Both halves are load-bearing: a max-size with no max-file keeps
      // unlimited rotated files, and a max-file with no max-size keeps a fixed
      // number of unlimited ones. Either way the total is unbounded.
      if (maxSize === undefined || !BOUNDED_SIZE.test(maxSize)) {
        defective.push(`${name}: max-size "${maxSize}" is not a finite size`);
      }
      if (maxFile === undefined || !/^[1-9]\d*$/.test(maxFile)) {
        defective.push(`${name}: max-file "${maxFile}" is not a positive count`);
      }
    }

    expect(defective).toEqual([]);
  });

  it('drives every service from one declaration, so the ceiling cannot drift per service', () => {
    const shapes = new Set(
      Object.values(compose().services).map((service) => JSON.stringify(service.logging)),
    );

    expect([...shapes]).toHaveLength(1);
  });
});
