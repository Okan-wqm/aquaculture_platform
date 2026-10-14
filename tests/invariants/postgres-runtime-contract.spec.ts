/**
 * Platform-wide invariant: the Postgres runtime contract is governed by
 * `.github/manifests/postgres-image.json`.
 *
 * INFRA-CRITICAL-017 and INFRA-CRITICAL-018 are one image-family migration
 * class: the HA image changed both the postgres uid/gid and the default PGDATA.
 * The runtime contract must therefore be pinned beside the image SSoT, not
 * remembered in comments or one compose file.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const POSTGRES_MANIFEST_PATH = join(REPO_ROOT, '.github', 'manifests', 'postgres-image.json');

interface PostgresRuntimeManifest {
  consumers: string[];
  productionConsumers: string[];
  dockerfile: string;
  image: string;
  pgdata: string;
  runtimeUser: string;
  sslEntrypoint: string;
}

interface ComposeService {
  image?: unknown;
  extends?: unknown;
  environment?: unknown;
  volumes?: unknown;
  entrypoint?: unknown;
  command?: unknown;
  healthcheck?: unknown;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string field in postgres manifest: ${field}`);
  }
  return value;
}

function manifestStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Expected string array field in postgres manifest: ${field}`);
  }
  return value;
}

function readManifest(): PostgresRuntimeManifest {
  const parsed: unknown = JSON.parse(readFileSync(POSTGRES_MANIFEST_PATH, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('Postgres manifest must be a JSON object');
  }
  return {
    consumers: manifestStringArray(parsed.consumers, 'consumers'),
    productionConsumers: manifestStringArray(parsed.production_consumers, 'production_consumers'),
    dockerfile: stringField(parsed.dockerfile, 'dockerfile'),
    image: stringField(parsed.image, 'image'),
    pgdata: stringField(parsed.pgdata, 'pgdata'),
    runtimeUser: stringField(parsed.runtime_user, 'runtime_user'),
    sslEntrypoint: stringField(parsed.ssl_entrypoint, 'ssl_entrypoint'),
  };
}

function repoFiles(pattern: string): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', pattern], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

function readCompose(path: string): ComposeFile {
  const parsed = yaml.load(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${path} must parse to a YAML object`);
  }
  return parsed as ComposeFile;
}

function concretePostgresComposeFiles(): string[] {
  return repoFiles('docker-compose*.yml').filter((path) => {
    const service = readCompose(path).services?.postgres;
    if (!service || service.extends) return false;
    return Boolean(service.image || service.volumes);
  });
}

function environmentValue(environment: unknown, key: string): string | undefined {
  if (isRecord(environment)) {
    const value = environment[key];
    return typeof value === 'string' ? value : undefined;
  }
  if (Array.isArray(environment)) {
    const prefix = `${key}=`;
    const entry = environment.find((item): item is string => {
      return typeof item === 'string' && item.startsWith(prefix);
    });
    return entry?.slice(prefix.length);
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nonCommentShellLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

const IMAGE_BIN = '/usr/local/bin/';
const CHECKOUT_SCRIPTS = 'infrastructure/docker/scripts/';

/** Script names the production Dockerfile COPYs into the image's /usr/local/bin/. */
function imageBakedScripts(dockerfile: string): Set<string> {
  const baked = new Set<string>();
  for (const instruction of dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const tokens = instruction.trim().split(/\s+/);
    if (tokens[0] !== 'COPY' || tokens[tokens.length - 1] !== IMAGE_BIN) continue;
    for (const token of tokens.slice(1, -1)) {
      if (token.startsWith(CHECKOUT_SCRIPTS)) baked.add(basename(token));
    }
  }
  return baked;
}

describe('INVARIANT: Postgres runtime contract is SSoT-backed', () => {
  const manifest = readManifest();

  it('keeps concrete compose Postgres services on the manifest PGDATA path', () => {
    const manifestComposeConsumers = manifest.consumers.filter((consumer) => {
      return consumer.startsWith('docker-compose') && consumer.endsWith('.yml');
    });
    const concreteFiles = concretePostgresComposeFiles();

    expect(concreteFiles.sort()).toEqual([...manifestComposeConsumers].sort());

    const violations = concreteFiles.flatMap((path) => {
      const service = readCompose(path).services?.postgres;
      if (!service) return [`${path}: missing services.postgres`];

      const pgdata = environmentValue(service.environment, 'PGDATA');
      const volumes = stringList(service.volumes);
      const hasDataVolume = volumes.some((volume) => {
        const [source, target] = volume.split(':');
        return source === 'postgres_data' && target === manifest.pgdata;
      });

      return [
        pgdata === manifest.pgdata
          ? null
          : `${path}: services.postgres.environment.PGDATA=${pgdata ?? '<missing>'}`,
        hasDataVolume
          ? null
          : `${path}: services.postgres.volumes must mount postgres_data at ${manifest.pgdata}`,
      ].filter((message): message is string => typeof message === 'string');
    });

    expect(violations).toEqual([]);
  });

  it('keeps the SSL entrypoint image-agnostic by resolving the manifest runtime user', () => {
    const entrypointPath = resolve(REPO_ROOT, manifest.sslEntrypoint);
    const content = readFileSync(entrypointPath, 'utf8');
    const executableLines = nonCommentShellLines(content);

    expect(content).toContain(`PG_UID=$(id -u ${manifest.runtimeUser}`);
    expect(content).toContain(`PG_GID=$(id -g ${manifest.runtimeUser}`);
    expect(executableLines).toContain('exec docker-entrypoint.sh "$@"');

    const chownLines = executableLines.filter((line) => line.startsWith('chown '));
    expect(chownLines.length).toBeGreaterThan(0);
    const rootOwnedTlsSource = 'chown 0:0 "${SERVER_KEY_SOURCE}"';
    expect(chownLines.filter((line) => !line.includes('${PG_UID}:${PG_GID}'))).toEqual([
      rootOwnedTlsSource,
    ]);
    expect(chownLines).not.toEqual(expect.arrayContaining([expect.stringMatching(/\b999:999\b/)]));
  });

  it('runs the production entrypoint, command and healthcheck from the image, never the checkout', () => {
    // ORPHAN-CRITICAL-810. The deploy lane preserves the postgres container by
    // design while the checkout moves. When the entrypoint was bind-mounted from
    // the checkout, a container created from one release executed the entrypoint
    // of a later one: on 2026-09-05 a July base-image container restarted into a
    // root-staging entrypoint it could not run (exit 126, 25 restarts). Every
    // script the production service executes must be COPYed into the image, so a
    // preserved container keeps running the release it was created from.
    const baked = imageBakedScripts(readFileSync(resolve(REPO_ROOT, manifest.dockerfile), 'utf8'));
    expect(baked.has(basename(manifest.sslEntrypoint))).toBe(true);

    for (const path of manifest.productionConsumers) {
      const service = readCompose(path).services?.postgres;
      expect(service).toBeDefined();
      if (!service) continue;

      expect(service.entrypoint).toEqual([`${IMAGE_BIN}${basename(manifest.sslEntrypoint)}`]);
      const executed =
        JSON.stringify([service.entrypoint, service.command, service.healthcheck]).match(
          /\/usr\/local\/bin\/[A-Za-z0-9._-]+/g,
        ) ?? [];
      expect(executed.length).toBeGreaterThan(0);
      expect(executed.filter((script) => !baked.has(basename(script)))).toEqual([]);

      const checkoutExecutables = stringList(service.volumes).filter((volume) => {
        const [source = '', target = ''] = volume.split(':');
        return source.includes(CHECKOUT_SCRIPTS) || target.startsWith(IMAGE_BIN);
      });
      expect(checkoutExecutables).toEqual([]);
    }
  });
});
