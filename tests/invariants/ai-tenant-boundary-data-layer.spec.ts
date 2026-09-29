import { dirname } from 'node:path';

import {
  aiRequestSubjects,
  appSources,
  code,
  offenders,
  read,
  respondersBySubject,
  sources,
} from './helpers/ai-tenant-boundary-sources';

/**
 * Platform-wide invariant — K10 layer 4 and the consumer half of layer 3
 * (PR-T1, MT-HIGH-062). Companion of ai-tenant-boundary.spec.ts.
 *
 *   E. Every AI-facing responder reads only inside the fail-closed tenant
 *      boundary: its own reads go through `runInTenantRead` (the createTask
 *      write through `runInTenantTransaction`), every query it dispatches is
 *      handled by a handler that reads through `runInTenantRead`, and every
 *      service such a handler calls either holds no repository of its own
 *      (it reads through the manager it is handed) or reads through
 *      `runInTenantRead` itself. WHY: `runInTenantRead` pins AND asserts the
 *      tenant search_path + RLS GUC, so an id that is not the request tenant's
 *      simply does not exist (NOT_FOUND); an ambient pooled read relies on
 *      context that can be lost.
 *   F. Every service OTHER than ai-service that requests one of these
 *      subjects checks the reply's tenant with `verifyTenantBoundReply` — the
 *      envelope only protects a consumer that reads it (ai-service's single
 *      sender is pinned by ai-tenant-boundary.spec.ts §A).
 *   G. K10 layer 5: messaging's AI module (knowledge extraction, retrieval /
 *      RAG, analysis reads) does no ambient repository/DataSource I/O — every
 *      tenant read runs on a query runner pinned to the tenant.
 */

const BOUNDARY = /\brunInTenant(?:Read|Transaction)\s*\(/;
/**
 * Reads that bypass the boundary: ambient DataSource/repository I/O. A
 * repository's pure entity factories (`create`, `merge`) do no I/O and are
 * not reads.
 */
const UNBOUNDED_READ =
  /this\.dataSource\.(?:query|manager|createQueryBuilder)\b|@InjectRepository\(|\.getRepository\(|this\.\w+Repo(?:sitory)?\.(?:find\w*|count\w*|exist\w*|query|createQueryBuilder|manager|save|insert|update|upsert|delete|remove|softDelete|restore|increment|decrement|sum|average|minimum|maximum)\b/;

interface Located {
  readonly file: string;
  readonly text: string;
}

/** The app a source file belongs to (`apps/<app>/src`). */
function appRootOf(file: string): string {
  const [apps, app] = file.split('/');
  return `${apps}/${app}/src`;
}

/** The one handler registered with `@<decorator>(<className>)` in the app. */
function handlerOf(appRoot: string, decorator: string, className: string): Located[] {
  const pattern = new RegExp(`@${decorator}\\(\\s*${className}\\s*\\)`);
  return appSources()
    .filter((file) => file.startsWith(`${appRoot}/`))
    .map((file) => ({ file, text: code(file) }))
    .filter(({ text }) => pattern.test(text));
}

/** `import { … Name … } from './x'` → the resolved `.ts` source of Name (relative imports only). */
function importedSource(from: Located, name: string): Located | null {
  const match = new RegExp(
    `import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'(\\.[^']+)'`,
  ).exec(from.text);
  if (!match?.[1]) return null;
  const file = `${dirname(from.file)}/${match[1]}.ts`.replace(/\/\.\//g, '/');
  const normalised = file.split('/').reduce<string[]>((parts, part) => {
    if (part === '..') parts.pop();
    else parts.push(part);
    return parts;
  }, []);
  const path = normalised.join('/');
  return { file: path, text: code(path) };
}

/** Injected infrastructure that reads nothing itself (buses route to handlers checked separately). */
const NON_READING_COLLABORATORS = new Set(['DataSource', 'QueryBus', 'CommandBus']);

/** Constructor-injected collaborators that may read: `[property, Type]`. */
function injectedCollaborators(owner: Located): Array<[string, string]> {
  const ctor = /constructor\s*\(([\s\S]*?)\)\s*\{/.exec(owner.text)?.[1] ?? '';
  return [...ctor.matchAll(/(?:private|protected|public)\s+readonly\s+(\w+)\s*:\s*(\w+)/g)]
    .map((m): [string, string] => [m[1] ?? '', m[2] ?? ''])
    .filter(([, type]) => !NON_READING_COLLABORATORS.has(type));
}

/** The body of `method` in a class source (from its signature to the next member). */
function methodBody(source: string, method: string): string {
  const signature = new RegExp(`\\n\\s*(?:async\\s+)?${method}\\s*\\(`).exec(source);
  if (signature === null) return '';
  // Everything after the signature's opening parenthesis, up to the next member.
  const rest = source.slice(signature.index + signature[0].length);
  const next = /\n {2}(?:async |private |protected |public |static |get |set )?\w+\s*\(/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/**
 * True when `method` — or any same-class method it calls, transitively —
 * reads through an ambient repository/DataSource. WHY transitive: a method
 * that takes the caller's manager can still hand the work to a private helper
 * that reads through `this.xRepository`.
 */
function readsUnbounded(source: string, method: string, seen = new Set<string>()): boolean {
  if (seen.has(method)) return false;
  seen.add(method);
  const body = methodBody(source, method);
  if (UNBOUNDED_READ.test(body)) return true;
  return [...body.matchAll(/this\.(\w+)\(/g)].some(
    ([, helper]) => helper !== undefined && readsUnbounded(source, helper, seen),
  );
}

/**
 * Why the collaborator calls in `text` (made by `owner`) are not tenant-bounded,
 * or null when they are. A collaborator is bounded when (a) it holds no
 * repository and no DataSource — it can only read through the manager it is
 * handed, which must then come from the caller's boundary — (b) every method
 * called on it reads through the boundary itself, or (c) the bounded caller
 * hands it the boundary's own manager (`qr.manager`, `queryRunner.manager`).
 *
 * @param callerIsBounded - the caller runs its own boundary, so an (a)-type
 *   collaborator can have been handed that boundary's manager.
 */
function collaboratorViolation(
  owner: Located,
  text: string,
  callerIsBounded: boolean,
): string | null {
  for (const [property, type] of injectedCollaborators(owner)) {
    const called = [...text.matchAll(new RegExp(`this\\.${property}\\.(\\w+)\\(`, 'g'))];
    if (called.length === 0) continue;
    const service = importedSource(owner, type);
    if (service === null) return `${type}: source not resolvable`;
    const holdsNoReader =
      !UNBOUNDED_READ.test(service.text) && !/this\.dataSource\b/.test(service.text);
    if (holdsNoReader && callerIsBounded) continue;
    for (const [call, method = ''] of called) {
      if (readsUnbounded(service.text, method)) {
        return `${type}.${method} reads through an ambient repository/DataSource`;
      }
      // (c) The bounded caller hands its own boundary's manager to the method.
      const argumentsText = text.slice(text.indexOf(call) + call.length).split(')')[0] ?? '';
      if (callerIsBounded && /\b\w+\.manager\b/.test(argumentsText)) continue;
      if (!BOUNDARY.test(methodBody(service.text, method))) {
        return `${type}.${method} reads outside runInTenantRead`;
      }
    }
  }
  return null;
}

/** Why a query handler is not tenant-bounded, or null when it is. */
function handlerViolation(handler: Located): string | null {
  if (UNBOUNDED_READ.test(handler.text)) return 'reads through an ambient repository/DataSource';
  const bounded = BOUNDARY.test(handler.text);
  const delegates = injectedCollaborators(handler).length > 0;
  if (!bounded && !delegates) return 'reads without runInTenantRead';
  return collaboratorViolation(handler, handler.text, bounded);
}

describe('INVARIANT (K10 layer 4 / MT-HIGH-062): AI responders read only inside the tenant boundary', () => {
  const subjects = aiRequestSubjects();
  const handlers = respondersBySubject();

  it('covers every AI-facing subject (sanity)', () => {
    expect(subjects.length).toBeGreaterThanOrEqual(46);
    expect(subjects.filter((subject) => (handlers.get(subject) ?? []).length === 0)).toEqual([]);
  });

  it.each(subjects)('%s reads only through runInTenantRead / runInTenantTransaction', (subject) => {
    const violations: string[] = [];
    for (const responder of handlers.get(subject) ?? []) {
      const dispatched = [...responder.body.matchAll(/new (\w+)(Query|Command)\(/g)];
      const owner: Located = { file: responder.file, text: code(responder.file) };
      const bounded = BOUNDARY.test(responder.body);
      const delegated = injectedCollaborators(owner).some(([property]) =>
        responder.body.includes(`this.${property}.`),
      );
      if (!bounded && dispatched.length === 0 && !delegated) {
        violations.push(`${responder.file}: no boundary call, dispatched query or bounded service`);
      }
      if (UNBOUNDED_READ.test(responder.body)) {
        violations.push(`${responder.file}: ambient repository/DataSource read`);
      }
      const serviceViolation = collaboratorViolation(owner, responder.body, bounded);
      if (serviceViolation !== null) violations.push(`${responder.file}: ${serviceViolation}`);
      for (const [, name, kind] of dispatched) {
        const decorator = kind === 'Query' ? 'QueryHandler' : 'CommandHandler';
        const found = handlerOf(appRootOf(responder.file), decorator, `${name}${kind}`);
        if (found.length !== 1) {
          violations.push(`${name}${kind}: ${found.length} handlers found`);
          continue;
        }
        const [handler] = found;
        const violation = handler ? handlerViolation(handler) : 'missing';
        if (violation !== null) violations.push(`${handler?.file ?? name}: ${violation}`);
      }
    }
    expect({ subject, violations }).toEqual({ subject, violations: [] });
  });
});

describe('INVARIANT (K10 layer 3 / MT-HIGH-062): other consumers of AI subjects verify the reply tenant', () => {
  const subjects = new Set(aiRequestSubjects());

  /** Subjects a file sends to — string literals and same-file `const X = '…'` constants. */
  const sentSubjects = (text: string): string[] => {
    const constants = new Map(
      [...text.matchAll(/const\s+(\w+)\s*=\s*'([^']+)'/g)].map((m) => [m[1] ?? '', m[2] ?? '']),
    );
    return [...text.matchAll(/\.send\s*(?:<[^>]*>)?\(\s*(?:'([^']+)'|(\w+))/g)].map(
      (m) => m[1] ?? constants.get(m[2] ?? '') ?? '',
    );
  };

  const consumers = appSources()
    .filter((file) => !file.startsWith('apps/ai-service/'))
    .map((file) => ({ file, text: code(file) }))
    .filter(({ text }) => sentSubjects(text).some((subject) => subjects.has(subject)));

  it('finds the known non-ai-service consumer (sanity: messaging knowledge extraction)', () => {
    expect(consumers.map(({ file }) => file)).toContain(
      'apps/messaging-service/src/ai/services/tank-registry.client.ts',
    );
  });

  it.each(consumers.map(({ file }) => file))(
    '%s checks the reply with verifyTenantBoundReply',
    (file) => {
      expect({ file, verifies: /\bverifyTenantBoundReply\s*\(/.test(read(file)) }).toEqual({
        file,
        verifies: true,
      });
    },
  );
});

describe('INVARIANT (K10 layer 5 / MT-HIGH-062): messaging AI reads are tenant-bound', () => {
  const MESSAGING_AI = 'apps/messaging-service/src/ai';
  const files = sources(MESSAGING_AI);

  it('scans the messaging AI module, including its retrieval and analysis read handlers (sanity)', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        `${MESSAGING_AI}/queries/search-similar-messages.handler.ts`,
        `${MESSAGING_AI}/queries/get-sentiment-trends.handler.ts`,
        `${MESSAGING_AI}/services/knowledge-extraction.service.ts`,
      ]),
    );
  });

  it('no messaging AI source reads or writes through an ambient repository or DataSource', () => {
    // SCENARIO: a retrieval/knowledge path reads with `this.dataSource.query` or an injected repository.
    // EXPECTS: none — the pooled connection it would run on decides the tenant, not the request.
    expect(offenders(files, UNBOUNDED_READ)).toEqual([]);
  });
});
