import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { load as loadYaml } from 'js-yaml';

const WORKSPACE_ROOT = resolve(__dirname, '..', '..');
const E2E_ENV_FILES = ['.env.local', '.env'] as const;
const COMPOSE_FILES = ['docker-compose.infra.yml', 'docker-compose.yml'] as const;
const POSTGRES_CONTAINER_PORT = '5432';

let loaded = false;

type ParsedEnv = Map<string, string>;
type ComposePostgresConfig = {
  user: string;
  password: string;
  database: string;
  host: string;
  port: string;
};

function parseEnvFile(path: string): ParsedEnv {
  const parsed: ParsedEnv = new Map();

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(trimmed);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    parsed.set(key, normalizeEnvValue(rawValue));
  }

  return parsed;
}

function normalizeEnvValue(rawValue: string): string {
  let value = rawValue.trim();
  const quote = value[0];

  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value
        .replace(/\\n/gu, '\n')
        .replace(/\\r/gu, '\r')
        .replace(/\\t/gu, '\t');
    }
    return value;
  }

  const commentIndex = value.search(/\s#/u);
  return commentIndex === -1 ? value : value.slice(0, commentIndex).trimEnd();
}

function expandEnvValue(value: string, values: ParsedEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, key: string) => {
    return process.env[key] ?? values.get(key) ?? '';
  });
}

function resolveComposeExpression(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/gu,
    (_match, key: string, defaultValue: string | undefined) => {
      return process.env[key] ?? defaultValue ?? '';
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function composeScalarValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return resolveComposeExpression(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function composeEnvValue(environment: unknown, key: string): string | undefined {
  if (isRecord(environment)) {
    const value = environment[key];
    return composeScalarValue(value);
  }

  if (Array.isArray(environment)) {
    const prefix = `${key}=`;
    const entry = environment.find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.startsWith(prefix),
    );
    return entry ? resolveComposeExpression(entry.slice(prefix.length)) : undefined;
  }

  return undefined;
}

function parseComposePort(port: unknown): Pick<ComposePostgresConfig, 'host' | 'port'> | undefined {
  if (typeof port === 'string') {
    const segments = port.split(':');
    if (segments.length === 2 && segments[1] === POSTGRES_CONTAINER_PORT) {
      return { host: 'localhost', port: segments[0] };
    }
    if (segments.length === 3 && segments[2] === POSTGRES_CONTAINER_PORT) {
      const host = segments[0] === '0.0.0.0' || segments[0] === '' ? 'localhost' : segments[0];
      return { host, port: segments[1] };
    }
    return undefined;
  }

  if (isRecord(port)) {
    const target = port['target'];
    const published = port['published'];
    const targetPort = composeScalarValue(target);
    const publishedPort = composeScalarValue(published);
    if (targetPort === POSTGRES_CONTAINER_PORT && publishedPort !== undefined) {
      const hostIp = port['host_ip'];
      const host = typeof hostIp === 'string' && hostIp !== '0.0.0.0' ? hostIp : 'localhost';
      return { host, port: publishedPort };
    }
  }

  return undefined;
}

function deriveDatabaseUrlFromComposeFile(composeFile: string): string | undefined {
  const composePath = resolve(WORKSPACE_ROOT, composeFile);
  if (!existsSync(composePath)) {
    return undefined;
  }

  const compose = loadYaml(readFileSync(composePath, 'utf8'));
  if (!isRecord(compose) || !isRecord(compose['services'])) {
    return undefined;
  }

  const services = compose['services'];
  const postgres = services['postgres'];
  if (!isRecord(postgres)) {
    return undefined;
  }

  const environment = postgres['environment'];
  const ports = Array.isArray(postgres['ports']) ? postgres['ports'] : [];
  const endpoint = ports.map(parseComposePort).find((value) => value !== undefined);
  const user = composeEnvValue(environment, 'POSTGRES_USER');
  const password = composeEnvValue(environment, 'POSTGRES_PASSWORD');
  const database = composeEnvValue(environment, 'POSTGRES_DB');

  if (!endpoint || !user || !password || !database) {
    return undefined;
  }

  const url = new URL('postgresql://localhost');
  url.username = user;
  url.password = password;
  url.hostname = endpoint.host;
  url.port = endpoint.port;
  url.pathname = `/${database}`;
  return url.toString();
}

function deriveDatabaseUrlFromCompose(): string | undefined {
  for (const composeFile of COMPOSE_FILES) {
    const databaseUrl = deriveDatabaseUrlFromComposeFile(composeFile);
    if (databaseUrl) {
      return databaseUrl;
    }
  }
  return undefined;
}

export function loadE2eEnvironment(): void {
  if (loaded) {
    return;
  }

  const values: ParsedEnv = new Map();
  for (const envFile of E2E_ENV_FILES) {
    const path = resolve(WORKSPACE_ROOT, envFile);
    if (!existsSync(path)) {
      continue;
    }

    for (const [key, value] of parseEnvFile(path)) {
      if (!values.has(key)) {
        values.set(key, value);
      }
    }
  }

  for (const [key, value] of values) {
    if (process.env[key] === undefined) {
      process.env[key] = expandEnvValue(value, values);
    }
  }

  loaded = true;
}

export function getRequiredE2eEnv(name: string): string {
  loadE2eEnvironment();

  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required for e2e tests. Set it in the process environment or root .env.`,
    );
  }
  return value;
}

export function getRequiredE2eDatabaseUrl(): string {
  loadE2eEnvironment();

  const explicit = process.env.DATABASE_URL;
  if (explicit) {
    return explicit;
  }

  const derived = deriveDatabaseUrlFromCompose();
  if (derived) {
    process.env.DATABASE_URL = derived;
    return derived;
  }

  throw new Error(
    'DATABASE_URL is required for e2e tests. Set it in the process environment, root .env, ' +
      `or keep ${COMPOSE_FILES.join(' / ')} postgres service environment/ports aligned with root .env.`,
  );
}

export function describeE2eDatabaseUrl(): string {
  loadE2eEnvironment();

  const value = process.env.DATABASE_URL ?? deriveDatabaseUrlFromCompose();
  if (!value) {
    return 'DATABASE_URL is not set';
  }

  try {
    const url = new URL(value);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return 'DATABASE_URL is set but is not a valid URL';
  }
}
