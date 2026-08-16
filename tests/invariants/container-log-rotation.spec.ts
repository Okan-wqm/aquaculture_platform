/**
 * Platform-wide invariant — every service in the production compose file must
 * bound its container log.
 *
 * Docker's default `json-file` driver performs no rotation. A compose anchor
 * sets one finite ceiling for the complete production service set, and this
 * invariant prevents new services or local overrides from escaping it.
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
