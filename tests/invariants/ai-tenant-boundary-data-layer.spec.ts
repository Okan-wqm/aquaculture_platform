import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ts from 'typescript';

import { AiReachableGraph } from './helpers/ai-reachable-graph';
import {
  aiRequestSubjects,
  appSources,
  code,
  offenders,
  read,
  REPO_ROOT,
  respondersBySubject,
  sources,
} from './helpers/ai-tenant-boundary-sources';

/**
 * Platform-wide invariant — K10 layer 4 and the consumer half of layer 3
 * (PR-T1, MT-HIGH-062). Companion of ai-tenant-boundary.spec.ts.
 *
 *   E. Every AI-facing responder answers through its service's responder
 *      skeleton (a `*AiResponder` built on `respondTenantBound`, which opens
 *      the tenant boundary itself), and no code the responder reaches — its
 *      handlers, their collaborators, the functions and static helpers they
 *      call, transitively — can read outside the TenantScope that skeleton
 *      hands it: no injected DataSource / repository / EntityManager /
 *      QueryRunner / ModuleRef / scope opener, no boundary of its own, no
 *      `.connection`, no schema-qualified SQL or search_path change, no state
 *      that outlives a request. The walk is an AST walk
 *      (helpers/ai-reachable-graph.ts, its own rules proven by
 *      ai-reachable-graph.spec.ts).
 *   F. Every service OTHER than ai-service that requests one of these
 *      subjects checks the reply's tenant with `verifyTenantBoundReply` — the
 *      envelope only protects a consumer that reads it (ai-service's single
 *      sender is pinned by ai-tenant-boundary.spec.ts §A).
 *   G. K10 layer 5: messaging's AI module (knowledge extraction, retrieval /
 *      RAG, analysis reads) does no ambient repository/DataSource I/O — every
 *      tenant read runs on a query runner pinned to the tenant.
 */

/** Reads that bypass the boundary: ambient DataSource/repository I/O (layer 5, §G). */
const UNBOUNDED_READ =
  /this\.dataSource\.(?:query|manager|createQueryBuilder)\b|@InjectRepository\(|\.getRepository\(|this\.\w+Repo(?:sitory)?\.(?:find\w*|count\w*|exist\w*|query|createQueryBuilder|manager|save|insert|update|upsert|delete|remove|softDelete|restore|increment|decrement|sum|average|minimum|maximum)\b/;

function readOrNull(path: string): string | null {
  const absolute = resolve(REPO_ROOT, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf-8') : null;
}

/** The app a source file belongs to (`apps/<app>/src`). */
function appRootOf(file: string): string {
  const [apps, app] = file.split('/');
  return `${apps}/${app}/src`;
}

interface ResponderClass {
  readonly className: string;
  /** The class injects a `*AiResponder` skeleton. */
  readonly injectsSkeleton: boolean;
  /** Names of @MessagePattern methods whose body does not call `.respond(`. */
  readonly methodsNotResponding: string[];
}

/** Classes in `file` that own a @MessagePattern method, with their skeleton wiring. */
function responderClasses(file: string): ResponderClass[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const out: ResponderClass[] = [];
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
    const patternMethods = statement.members.filter(
      (m): m is ts.MethodDeclaration =>
        ts.isMethodDeclaration(m) &&
        (ts.getDecorators(m) ?? []).some((d) => d.getText(source).startsWith('@MessagePattern(')),
    );
    if (patternMethods.length === 0) continue;
    const ctor = statement.members.find(ts.isConstructorDeclaration);
    const injectsSkeleton = (ctor?.parameters ?? []).some((p) =>
      /AiResponder$/.test(p.type?.getText(source) ?? ''),
    );
    out.push({
      className: statement.name.text,
      injectsSkeleton,
      methodsNotResponding: patternMethods
        .filter((m) => !/\.respond\(/.test(m.body?.getText(source) ?? ''))
        .map((m) => m.name.getText(source)),
    });
  }
  return out;
}

describe('INVARIANT (K10 layer 4 / MT-HIGH-062): AI-reachable code reads only through the TenantScope', () => {
  const subjects = aiRequestSubjects();
  const responders = respondersBySubject();
  const graphs = new Map<string, AiReachableGraph>();
  const graphFor = (file: string): AiReachableGraph => {
    const root = appRootOf(file);
    let graph = graphs.get(root);
    if (graph === undefined) {
      graph = new AiReachableGraph(
        readOrNull,
        appSources().filter((f) => f.startsWith(`${root}/`)),
      );
      graphs.set(root, graph);
    }
    return graph;
  };

  it('covers every AI-facing subject (sanity)', () => {
    expect(subjects.length).toBeGreaterThanOrEqual(46);
    expect(subjects.filter((subject) => (responders.get(subject) ?? []).length === 0)).toEqual([]);
  });

  it('every responder skeleton opens the boundary through respondTenantBound (sanity)', () => {
    // SCENARIO: a service wires a `*AiResponder` that skips the shared skeleton.
    // EXPECTS: each skeleton class the responders inject is built on respondTenantBound.
    const skeletons = appSources().filter((file) => /-ai-responder\.ts$/.test(file));
    expect(skeletons.length).toBeGreaterThan(0);
    for (const file of skeletons) {
      expect({ file, usesSkeleton: /\brespondTenantBound\(/.test(code(file)) }).toEqual({
        file,
        usesSkeleton: true,
      });
    }
  });

  it.each(subjects)(
    '%s: responder answers through the skeleton and every reachable node stays in the scope',
    (subject) => {
      const violations: string[] = [];
      for (const { file } of responders.get(subject) ?? []) {
        for (const cls of responderClasses(file)) {
          if (!cls.injectsSkeleton)
            violations.push(`${file}#${cls.className}: injects no *AiResponder skeleton`);
          for (const method of cls.methodsNotResponding) {
            violations.push(
              `${file}#${cls.className}.${method}: does not answer through .respond(`,
            );
          }
          for (const v of graphFor(file).walkFromClass(file, cls.className)) {
            violations.push(`${v.node}: ${v.reason}`);
          }
        }
      }
      expect({ subject, violations }).toEqual({ subject, violations: [] });
    },
  );

  it('the walk reaches handlers, collaborators, pure helpers and statics (sanity)', () => {
    // SCENARIO: the walk silently stops at the responder (e.g. a resolver bug).
    // EXPECTS: from the batch/growth responders it enters the query handlers,
    //          the cost collaborator, the FCR reader function and the
    //          harvest-eligibility collaborator.
    const nodes = new Set<string>();
    const farm = 'apps/farm-service/src';
    graphFor(`${farm}/batch/responders/batch-ai-query.responder.ts`).walkFromClass(
      `${farm}/batch/responders/batch-ai-query.responder.ts`,
      'BatchAiQueryResponder',
      nodes,
    );
    graphFor(`${farm}/fish-health/responders/fish-health-ai-query.responder.ts`).walkFromClass(
      `${farm}/fish-health/responders/fish-health-ai-query.responder.ts`,
      'FishHealthAiQueryResponder',
      nodes,
    );
    expect([...nodes]).toEqual(
      expect.arrayContaining([
        `${farm}/batch/query-handlers/get-batch-performance.handler.ts#GetBatchPerformanceHandler`,
        `${farm}/batch/services/batch-cost-calculator.service.ts#BatchCostCalculatorService`,
        `${farm}/growth/services/cumulative-fcr.reader.ts#readCumulativeFcr`,
        `${farm}/fish-health/services/batch-harvest-eligibility.service.ts#BatchHarvestEligibilityService`,
        `${farm}/fish-health/handlers/list-health-events.handler.ts#ListHealthEventsHandler`,
        `${farm}/fish-health/services/health-event-filters.ts#applyHealthEventFilters`,
      ]),
    );
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
