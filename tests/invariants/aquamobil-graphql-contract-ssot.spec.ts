/**
 * AquaMobil GraphQL contract SSoT — the client's write and read shapes come
 * from graphql-codegen, never from a hand-maintained mirror (MOB-HIGH-019,
 * MOB-CRITICAL-018).
 *
 * WHY: the water-quality form failed on every submit for weeks because a
 * hand-written `CreateWaterQualityInput` carried a `parameters` field the
 * server had dropped and lacked the `equipmentId` it had made required. Nothing
 * saw it: codegen only plucked `src/graphql/**`, the untyped
 * `graphqlRequest(DocumentNode, Record<string, unknown>)` overload accepted any
 * variables object, and the document-text CI gate cannot see a variables value.
 * Faz 3 closed each hole; this spec keeps them closed (tier-3, make it
 * detectable):
 *
 *   (a) no hand-written `*Input` type under src — inputs are generated;
 *   (b) no local declaration that shadows a generated type name — the one
 *       exception is the deliberate internal-form codec `ChannelType`;
 *   (c) every `*Payload` type is either derived from the queue contract or an
 *       explicitly listed non-GraphQL payload (transport / auth / push);
 *   (d) the queued-payload map is derived member-by-member from generated
 *       `*MutationVariables`, so a queue shape cannot be hand-typed;
 *   (e) codegen plucks every document under `src/**` (the registry included);
 *   (f) every registry mutation has a generated `<Name>Document`;
 *   (g) `graphqlRequest` has no `DocumentNode` overload;
 *   (h) the codegen CI gate runs on every `web/apps/aquamobil/src/**` change.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const APP = 'web/apps/aquamobil';
const SRC = join(REPO_ROOT, APP, 'src');
const GENERATED = join(SRC, 'generated', 'graphql.ts');

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** Every non-test source file under src, excluding the generated module. */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'generated' || entry === '__tests__' || entry === 'node_modules') continue;
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.spec\.tsx?$/.test(entry) || entry.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

const DECLARATION_RX = /^(?:export )?(interface|type) (\w+)\b([^\n]*)/gm;

interface Declaration {
  readonly file: string;
  readonly kind: 'interface' | 'type';
  readonly name: string;
  /** The rest of the declaration line (the RHS for a type alias). */
  readonly rest: string;
}

function declarations(): Declaration[] {
  const out: Declaration[] = [];
  for (const file of sourceFiles()) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(DECLARATION_RX)) {
      out.push({
        file: relative(REPO_ROOT, file),
        kind: match[1] === 'interface' ? 'interface' : 'type',
        name: match[2] ?? '',
        rest: match[3] ?? '',
      });
    }
  }
  return out;
}

function generatedExportNames(): Set<string> {
  const content = readFileSync(GENERATED, 'utf8');
  return new Set(
    [...content.matchAll(/^export (?:type|enum|const) (\w+)/gm)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    ),
  );
}

/**
 * (b) Local declarations allowed to share a generated name. Each entry needs a
 * reason a reader can verify; the list should only shrink.
 */
const GENERATED_NAME_SHADOWS_ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    'ChannelType',
    'deliberate internal lowercase form with an explicit wire codec (utils/channel-type-wire.ts, MSG-HIGH-054); the wire enum is ChannelTypeWire',
  ],
]);

/**
 * (a) `*Input` names allowed under src: only the derivation helper that
 * strips the command envelope from a generated input.
 */
const INPUT_NAMES_ALLOWED: ReadonlySet<string> = new Set(['QueueInput']);

/**
 * (c) `*Payload` types that are NOT GraphQL inputs and therefore cannot be
 * derived from codegen. Anything else named *Payload must be derived.
 */
const NON_GRAPHQL_PAYLOADS_ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    'UploadAndSendMessageOfflinePayload',
    'client-internal three-step op (presign → PUT → sendMessage); the GraphQL half is the generated SendMessageInput',
  ],
  [
    'GraphQLErrorPayload',
    'transport envelope element (utils/graphql-response.ts), not an operation input',
  ],
  [
    'AuthUserPayload',
    'login/refresh mutation selection consumed before the codegen document set (auth-identity), normalized through normalizeRole',
  ],
  ['ForegroundPushPayload', 'Firebase foreground push message shape, not a GraphQL input'],
  ['QueuedPayloadByType', 'the derivation ROOT — every member is checked in (d)'],
]);

/** A *Payload alias is derived when its RHS reaches the queue contract. */
const DERIVED_PAYLOAD_RX = /QueuedPayload<|QueuedPayloadByType\[|OperationPayload<|QueueInput</;

describe('AquaMobil GraphQL contract SSoT (MOB-HIGH-019 / MOB-CRITICAL-018)', () => {
  const decls = declarations();

  it('(a) declares no hand-written *Input type under src — inputs are generated', () => {
    const offenders = decls
      .filter((d) => /Input$/.test(d.name) && !INPUT_NAMES_ALLOWED.has(d.name))
      .map((d) => `${d.file}: ${d.kind} ${d.name}`);
    expect(offenders).toEqual([]);
  });

  it('(b) declares no local type that shadows a generated type name', () => {
    const generated = generatedExportNames();
    const offenders = decls
      .filter((d) => generated.has(d.name) && !GENERATED_NAME_SHADOWS_ALLOWED.has(d.name))
      .map(
        (d) =>
          `${d.file}: ${d.kind} ${d.name} (generated/graphql.ts exports it — re-export or derive instead)`,
      );
    expect(offenders).toEqual([]);
    // The allowlist may not carry stale entries.
    for (const name of GENERATED_NAME_SHADOWS_ALLOWED.keys()) {
      expect(decls.some((d) => d.name === name)).toBe(true);
    }
  });

  it('(c) every *Payload type is derived from the queue contract or listed as a non-GraphQL payload', () => {
    const offenders = decls
      .filter((d) => /Payload$/.test(d.name))
      .filter((d) => !NON_GRAPHQL_PAYLOADS_ALLOWED.has(d.name))
      .filter((d) => d.kind === 'interface' || !DERIVED_PAYLOAD_RX.test(d.rest))
      .map((d) => `${d.file}: ${d.kind} ${d.name}`);
    expect(offenders).toEqual([]);
    for (const name of NON_GRAPHQL_PAYLOADS_ALLOWED.keys()) {
      expect(decls.some((d) => d.name === name)).toBe(true);
    }
  });

  it('(d) every QueuedPayloadByType member derives from a generated *MutationVariables input', () => {
    const types = read(`${APP}/src/types/index.ts`);
    const block = /export interface QueuedPayloadByType \{\n([\s\S]*?)\n\}/.exec(types);
    expect(block).not.toBeNull();
    const members = (block?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith('//') &&
          !line.startsWith('/*') &&
          !line.startsWith('*'),
      );
    expect(members.length).toBeGreaterThan(10);
    const generated = generatedExportNames();
    const underived = members.filter((line) => {
      if (/UploadAndSendMessageOfflinePayload/.test(line)) return false;
      // Every generated name the member reaches must exist in the generated module:
      // `QueueInput<XInput>` strips the envelope from a generated input, and
      // `XMutationVariables` is the generated variables object itself.
      const referenced = [...line.matchAll(/QueueInput<(\w+)>|(\w+MutationVariables)/g)].flatMap(
        (m) => {
          const name = m[1] ?? m[2];
          return name ? [name] : [];
        },
      );
      return referenced.length === 0 || referenced.some((name) => !generated.has(name));
    });
    expect(underived).toEqual([]);
  });

  it('(e) codegen plucks every document under src/** and does not exclude the queue registry', () => {
    const codegen = read('codegen.ts');
    expect(codegen).toMatch(/'web\/apps\/aquamobil\/src\/\*\*\/\*\.\{ts,tsx\}'/);
    const negatives = [...codegen.matchAll(/'!web\/apps\/aquamobil\/src\/([^']*)'/g)].map(
      (m) => m[1],
    );
    for (const pattern of negatives) {
      expect(pattern).not.toMatch(/pwa|operation-registry|pages|hooks/);
    }
  });

  it('(f) every mutation in the queue registry has a generated TypedDocumentNode', () => {
    const registry = read(`${APP}/src/pwa/operation-registry.ts`);
    const generated = generatedExportNames();
    const names = [...registry.matchAll(/^\s+mutation (\w+)\(/gm)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
    expect(names.length).toBeGreaterThan(10);
    const missing = names.filter((name) => !generated.has(`${name}Document`));
    expect(missing).toEqual([]);
  });

  it('(g) graphqlRequest has exactly one signature and it takes a TypedDocumentNode', () => {
    const fetchModule = read(`${APP}/src/services/authenticated-fetch.ts`);
    const signatures = fetchModule.match(/export (?:async )?function graphqlRequest</g) ?? [];
    expect(signatures).toHaveLength(1);
    expect(fetchModule).not.toMatch(/document: DocumentNode\b/);
    expect(fetchModule).toMatch(/document: TypedDocumentNode<TResult, TVars>/);
  });

  it('(h) the codegen CI gate runs on every aquamobil source change', () => {
    const workflow = read('.github/workflows/graphql-codegen-validate.yml');
    // Both triggers (push + pull_request) carry a `paths:` filter; each must
    // include the whole aquamobil source tree, not just src/graphql.
    const triggers = workflow.match(/paths:/g) ?? [];
    const aquamobilFilters = workflow.match(/- 'web\/apps\/aquamobil\/src\/\*\*'/g) ?? [];
    expect(triggers.length).toBeGreaterThanOrEqual(2);
    expect(aquamobilFilters.length).toBe(triggers.length);
  });
});
