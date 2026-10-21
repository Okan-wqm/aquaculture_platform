/**
 * NATS identity: credential-based auth is forbidden — the one owner (ADR-015, ARIA-HIGH-012).
 *
 * WHY: under ADR-015 a client's identity is its mTLS certificate (verify_and_map maps the
 * certificate's `CN=<name>` to the NATS user). A `password`, `token` or `nkey`, a user given
 * as an environment variable, or a user name that is not a certificate DN means some client
 * authenticates by something other than its certificate.
 *
 * Scope: every `authorization {}` map at any depth (client, cluster, leafnode, websocket ...)
 * and every `accounts { <name> { users [...] } }` list. The tree comes from nats-conf.ts, so
 * a commented-out `password:` is not configuration and is not reported.
 */
import type { NatsEntry, NatsValue } from '../lib/infra/nats-conf';

export type NatsCredentialKind =
  | 'password'
  | 'token'
  | 'nkey'
  | 'interpolated_user'
  | 'non_cert_user';

export interface NatsCredentialHit {
  readonly kind: NatsCredentialKind;
  readonly key: string;
  readonly value: string;
  readonly line: number;
}

// Keys as nats-server reads them: lower-cased, with its aliases (server/opts.go
// parseAuthorization / parseUsers: `case "user", "username"`, `case "pass", "password"`).
const SECRET_KEYS: Readonly<Record<string, NatsCredentialKind>> = {
  password: 'password',
  pass: 'password',
  token: 'token',
  nkey: 'nkey',
};
const USER_KEYS: ReadonlySet<string> = new Set(['user', 'username']);

function scalarText(value: NatsValue): string {
  return value.kind === 'scalar' ? value.raw : value.kind;
}

/** Credential keys of one user map (or of an authorization map's single-user form). */
function scanUserMap(entries: readonly NatsEntry[], hits: NatsCredentialHit[]): void {
  for (const entry of entries) {
    const key = entry.key.toLowerCase();
    const secretKind = SECRET_KEYS[key];
    if (secretKind !== undefined) {
      hits.push({
        kind: secretKind,
        key: entry.key,
        value: scalarText(entry.value),
        line: entry.line,
      });
    } else if (USER_KEYS.has(key) && entry.value.kind === 'scalar') {
      const { raw, quoted } = entry.value;
      if (!quoted && raw.startsWith('$')) {
        hits.push({ kind: 'interpolated_user', key: entry.key, value: raw, line: entry.line });
      } else if (!raw.startsWith('CN=')) {
        hits.push({ kind: 'non_cert_user', key: entry.key, value: raw, line: entry.line });
      }
    }
  }
}

function scanUsers(value: NatsValue, hits: NatsCredentialHit[]): void {
  if (value.kind !== 'array') return;
  for (const item of value.items) if (item.kind === 'map') scanUserMap(item.entries, hits);
}

function scanAuthorization(entries: readonly NatsEntry[], hits: NatsCredentialHit[]): void {
  scanUserMap(entries, hits);
  for (const entry of entries)
    if (entry.key.toLowerCase() === 'users') scanUsers(entry.value, hits);
}

function walk(entries: readonly NatsEntry[], hits: NatsCredentialHit[]): void {
  for (const entry of entries) {
    const key = entry.key.toLowerCase();
    const value = entry.value;
    if (value.kind !== 'map') continue;
    if (key === 'authorization') {
      scanAuthorization(value.entries, hits);
    } else if (key === 'accounts') {
      for (const account of value.entries) {
        if (account.value.kind !== 'map') continue;
        for (const field of account.value.entries)
          if (field.key.toLowerCase() === 'users') scanUsers(field.value, hits);
      }
    } else {
      walk(value.entries, hits);
    }
  }
}

/** Every credential-based identity in a parsed NATS config, in source order. */
export function natsCredentialAuth(tree: readonly NatsEntry[]): NatsCredentialHit[] {
  const hits: NatsCredentialHit[] = [];
  walk(tree, hits);
  return hits.sort((a, b) => a.line - b.line);
}
