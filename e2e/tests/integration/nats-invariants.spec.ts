/**
 * NATS SSoT Invariants
 * ============================================================================
 *
 * Enforces the architectural invariants established by the 2026-04-14
 * NATS cert-is-identity refactor (ADR-015). Every downstream artifact that
 * references per-service NATS identity must agree with the single source
 * of truth at `infrastructure/nats/services.yaml`.
 *
 * # What it checks
 *
 *   1. services.yaml is valid against services.schema.json.
 *   2. Every service in services.yaml has a matching `user: <name>` entry
 *      in nats.conf's authorization{} block with identical publish +
 *      subscribe ACLs.
 *   3. nats.conf's GENERATED authorization block contains ZERO `password:`
 *      fields (cert-is-identity; passwords are a drift vector that
 *      verify_and_map ignores anyway).
 *   4. nats.conf's GENERATED authorization block contains ZERO
 *      `$NATS_*_USER` / `$NATS_*_PASS` substitutions (user names must be
 *      literal, matching cert CNs).
 *   5. Every service name in services.yaml is present as a cert CN in
 *      generate-internal-certs.sh, and vice versa (1:1 correspondence).
 *
 * # When it fails
 *
 *   - Hand-edit of nats.conf inside the BEGIN/END GENERATED sentinels →
 *     regenerate via `scripts/nats/generate-nats-conf.py`.
 *   - Added a service to services.yaml without regenerating nats.conf →
 *     run the generator, commit the diff.
 *   - Added a cert CN to generate-internal-certs.sh without corresponding
 *     services.yaml entry → add it (or remove from the cert script).
 *   - Reintroduced a password: field → remove it (verify_and_map handles
 *     identity; passwords are redundant and drift-prone).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import Ajv from 'ajv';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = join(__dirname, '..', '..', '..');

// The `yaml` package ships its own type declarations (js-yaml does not, and
// e2e is not an npm workspace so its @types never hoist). A typed
// `(input: string) => unknown` binding keeps the parse result `unknown` so
// every caller must narrow it with an explicit assertion instead of letting
// `any` flow through the invariant assertions below.
const parseYaml: (input: string) => unknown = yamlParse;

interface Service {
  name: string;
  description: string;
  publish: string[];
  subscribe: string[];
}

interface ServicesYaml {
  version: number;
  services: Service[];
}

function loadServicesYaml(): ServicesYaml {
  const path = join(REPO_ROOT, 'infrastructure', 'nats', 'services.yaml');
  return parseYaml(readFileSync(path, 'utf-8')) as ServicesYaml;
}

function loadServicesSchema(): object {
  const path = join(REPO_ROOT, 'infrastructure', 'nats', 'services.schema.json');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  return parsed as object;
}

function loadNatsConfAuthBlock(): string {
  const path = join(REPO_ROOT, 'infrastructure', 'docker', 'nats', 'nats.conf');
  const content = readFileSync(path, 'utf-8');
  const begin = content.indexOf('# BEGIN GENERATED');
  const end = content.indexOf('# END GENERATED');
  if (begin < 0 || end < 0) {
    throw new Error(
      'nats.conf is missing BEGIN/END GENERATED sentinels. Run ' +
        '`scripts/nats/generate-nats-conf.py` to regenerate.',
    );
  }
  return content.substring(begin, end);
}

function loadCertCnList(): string[] {
  const path = join(REPO_ROOT, 'infrastructure', 'docker', 'scripts', 'generate-internal-certs.sh');
  const script = readFileSync(path, 'utf-8');
  // Locate the `for svc in <names>; do` block that drives per-service
  // cert generation. The names are whitespace-separated on one or more
  // continuation lines (ending in `\`). Extract the full list.
  const match = script.match(/for svc in\s+([\s\S]+?);\s*do/);
  if (!match) {
    throw new Error(
      'generate-internal-certs.sh does not contain a `for svc in ... ; do` ' +
        'block — the test cannot verify cert CN ↔ services.yaml alignment.',
    );
  }
  return match[1]
    .replace(/\\/g, '') // remove line-continuation backslashes
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

/**
 * Parse a single NATS user entry out of the authorization block.
 *
 * The generator emits deterministic formatting — exactly one `user: <name>`
 * per entry, followed by `publish:` and `subscribe:` allow arrays. We do
 * string-based extraction (not full HOCON parsing) because the generator
 * is the only writer; hand-edits fail other invariants before reaching
 * this parser.
 */
interface NatsUserEntry {
  name: string;
  publish: string[];
  subscribe: string[];
}

function parseAuthBlockUsers(authBlock: string): NatsUserEntry[] {
  const users: NatsUserEntry[] = [];
  // Split on `user: <name>,` lines; each block starts there.
  const entryRegex = /user:\s*(\w+),\s*[\s\S]*?allow:\s*\[([^\]]*)\][\s\S]*?allow:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(authBlock)) !== null) {
    const [, name, publishRaw, subscribeRaw] = m;
    const parseAllow = (raw: string): string[] =>
      raw
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter((s) => s.length > 0);
    users.push({
      name: name,
      publish: parseAllow(publishRaw),
      subscribe: parseAllow(subscribeRaw),
    });
  }
  return users;
}

describe('NATS SSoT Invariants (2026-04-14 cert-is-identity refactor)', () => {
  const servicesDoc = loadServicesYaml();
  const authBlock = loadNatsConfAuthBlock();
  const parsedUsers = parseAuthBlockUsers(authBlock);

  it('services.yaml is valid against services.schema.json', () => {
    const schema = loadServicesSchema();
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);
    const valid = validate(servicesDoc);
    if (!valid) {
      throw new Error(`services.yaml schema violations: ${JSON.stringify(validate.errors)}`);
    }
  });

  it('services.yaml → nats.conf user count matches', () => {
    if (parsedUsers.length !== servicesDoc.services.length) {
      throw new Error(
        `Expected ${servicesDoc.services.length} user entries in nats.conf ` +
          `authorization block, got ${parsedUsers.length}. Run ` +
          `\`scripts/nats/generate-nats-conf.py\` to regenerate.`,
      );
    }
  });

  it.each((() => loadServicesYaml().services.map((s) => [s.name, s] as [string, Service]))())(
    'service %s has a matching nats.conf user entry with identical ACLs',
    (name, svc) => {
      const matched = parsedUsers.find((u) => u.name === name);
      if (!matched) {
        throw new Error(
          `services.yaml declares service "${name}" but nats.conf has no ` +
            `\`user: ${name}\` entry. Run the generator.`,
        );
      }
      if (matched.publish.join('|') !== svc.publish.join('|')) {
        throw new Error(
          `publish ACL drift for "${name}":\n` +
            `  yaml:     ${svc.publish.join(', ')}\n` +
            `  nats.conf: ${matched.publish.join(', ')}`,
        );
      }
      if (matched.subscribe.join('|') !== svc.subscribe.join('|')) {
        throw new Error(
          `subscribe ACL drift for "${name}":\n` +
            `  yaml:     ${svc.subscribe.join(', ')}\n` +
            `  nats.conf: ${matched.subscribe.join(', ')}`,
        );
      }
    },
  );

  it('nats.conf GENERATED block contains ZERO password fields', () => {
    if (/password:/i.test(authBlock)) {
      throw new Error(
        'nats.conf GENERATED authorization block contains a `password:` ' +
          'field. Under mTLS verify_and_map (ADR-015), passwords are ' +
          'redundant (server ignores CONNECT-frame auth) and a drift ' +
          'vector. Regenerate nats.conf via `scripts/nats/generate-nats-conf.py`.',
      );
    }
  });

  it('nats.conf GENERATED block contains ZERO $-interpolated user vars', () => {
    // Literal user names only — no `$NATS_*_USER` / `$NATS_*_PASS`.
    if (/\$NATS_[A-Z]+_(USER|PASS)/.test(authBlock)) {
      throw new Error(
        'nats.conf GENERATED authorization block still contains ' +
          '$NATS_*_USER or $NATS_*_PASS substitutions. Pre-ADR-015 ' +
          'pattern; regenerate via `scripts/nats/generate-nats-conf.py`.',
      );
    }
  });

  it('services.yaml names ↔ cert CN list are 1:1', () => {
    const certCns = new Set(loadCertCnList());
    const yamlNames = new Set(servicesDoc.services.map((s) => s.name));
    const onlyInYaml = [...yamlNames].filter((n) => !certCns.has(n));
    const onlyInCerts = [...certCns].filter((n) => !yamlNames.has(n));
    if (onlyInYaml.length > 0 || onlyInCerts.length > 0) {
      throw new Error(
        `services.yaml ↔ generate-internal-certs.sh CN list mismatch:\n` +
          `  only in services.yaml: ${onlyInYaml.join(', ') || '∅'}\n` +
          `  only in cert script:   ${onlyInCerts.join(', ') || '∅'}\n` +
          `Both sides must be in lockstep — add/remove together.`,
      );
    }
  });
});
