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

/** Keys that authenticate a client by something it holds: a password, a token or an nkey. */
export type NatsCredentialKeyKind = 'password' | 'token' | 'nkey';
/** A user identity that is not a literal certificate DN. */
export type NatsUserKind = 'interpolated_user' | 'non_cert_user';
export type NatsCredentialKind = NatsCredentialKeyKind | NatsUserKind;

/**
 * A credential key, located and never copied. A hit becomes the e2e failure message (a CI log)
 * and, through the infrastructure-policy adapter, an ARIA finding, its evidence and state that
 * outlive rotating the credential, so it carries no field that holds the value: path and line
 * locate it, the length tells a reader it is a real value without repeating it. This is the rule
 * secret-allowlist-premise.ts's HiddenSecret follows (ARIA-HIGH-012 landing fix 2).
 */
export interface NatsCredentialKeyHit {
  readonly kind: NatsCredentialKeyKind;
  readonly key: string;
  readonly line: number;
  /** Characters of the value; 0 when the value is a map or an array, which holds no credential string. */
  readonly secretLength: number;
  /** The value is an unquoted `$NAME`: the server substitutes it from its environment. */
  readonly fromVariable: boolean;
}

/** A user name or certificate DN is not a secret: the hit keeps it, so a reader sees which user. */
export interface NatsUserHit {
  readonly kind: NatsUserKind;
  readonly key: string;
  readonly line: number;
  readonly value: string;
}

export type NatsCredentialHit = NatsCredentialKeyHit | NatsUserHit;

// Keys as nats-server reads them: lower-cased, with its aliases (server/opts.go
// parseAuthorization / parseUsers: `case "user", "username"`, `case "pass", "password"`).
const SECRET_KEYS: Readonly<Record<string, NatsCredentialKeyKind>> = {
  password: 'password',
  pass: 'password',
  token: 'token',
  nkey: 'nkey',
};
const USER_KEYS: ReadonlySet<string> = new Set(['user', 'username']);

/** Credential keys of one user map (or of an authorization map's single-user form). */
function scanUserMap(entries: readonly NatsEntry[], hits: NatsCredentialHit[]): void {
  for (const entry of entries) {
    const key = entry.key.toLowerCase();
    const secretKind = SECRET_KEYS[key];
    if (secretKind !== undefined) {
      const { value } = entry;
      hits.push({
        kind: secretKind,
        key: entry.key,
        line: entry.line,
        secretLength: value.kind === 'scalar' ? value.raw.length : 0,
        fromVariable: value.kind === 'scalar' && !value.quoted && value.raw.startsWith('$'),
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
