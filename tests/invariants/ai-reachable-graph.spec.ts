import { AiReachableGraph, type GraphViolation } from './helpers/ai-reachable-graph';

/**
 * The AI-reachable graph walk's own rules (K10 layer 4, V-T1b-2).
 *
 * WHY: ai-tenant-boundary-data-layer.spec.ts §E passes only if the walk finds
 * nothing. A walk that silently stopped following collaborators would pass
 * too. Each case here feeds the walker a small synthetic app and proves one
 * rule fires — the experiment that shows the gate would go red.
 */

const APP = 'apps/demo/src';

const RESPONDER = `
import { Controller } from '@nestjs/common';
import { QueryBus } from '@platform/cqrs';
import { FarmAiResponder } from '../common/farm-ai-responder';
import { GetThingQuery } from './get-thing.query';
@Controller()
export class ThingResponder {
  constructor(private readonly responder: FarmAiResponder, private readonly queryBus: QueryBus) {}
  getThing(payload: unknown) {
    return this.responder.respond({ handle: (req, scope) => this.queryBus.execute(new GetThingQuery(scope)) }, payload);
  }
}`;

const QUERY = `export class GetThingQuery { constructor(readonly scope: unknown) {} }`;

function walk(files: Record<string, string>): GraphViolation[] {
  const all: Record<string, string> = {
    [`${APP}/thing/thing.responder.ts`]: RESPONDER,
    [`${APP}/thing/get-thing.query.ts`]: QUERY,
    ...files,
  };
  const graph = new AiReachableGraph((path) => all[path] ?? null, Object.keys(all));
  return graph.walkFromClass(`${APP}/thing/thing.responder.ts`, 'ThingResponder');
}

function handler(body: string, ctor = '', imports = ''): string {
  return `
import { QueryHandler } from '@platform/cqrs';
import { GetThingQuery } from './get-thing.query';
${imports}
@QueryHandler(GetThingQuery)
export class GetThingHandler {
  constructor(${ctor}) {}
  async execute(query: GetThingQuery) { ${body} }
}`;
}

const HANDLER_FILE = `${APP}/thing/get-thing.handler.ts`;
const reasons = (violations: GraphViolation[]): string[] => violations.map((v) => v.reason);

describe('AiReachableGraph', () => {
  it('passes a handler that reads only through the scope it is handed', () => {
    // SCENARIO: the handler reads with query.scope.manager and a pure helper.
    // EXPECTS: no violation.
    const violations = walk({
      [HANDLER_FILE]: handler(
        'return format(await query.scope.manager.find(Thing, {}));',
        '',
        "import { format } from './format';\nimport { Thing } from './thing.entity';",
      ),
      [`${APP}/thing/format.ts`]: 'export function format(rows: unknown[]) { return rows.length; }',
    });
    expect(violations).toEqual([]);
  });

  it('flags a dispatched handler that injects a DataSource', () => {
    // SCENARIO: the handler of the dispatched query holds its own DataSource.
    // EXPECTS: a violation on the handler — it could read on any connection.
    const violations = walk({
      [HANDLER_FILE]: handler(
        'return 1;',
        'private readonly dataSource: DataSource',
        "import { DataSource } from 'typeorm';",
      ),
    });
    expect(reasons(violations)).toEqual([expect.stringContaining('injects DataSource')]);
  });

  it('flags @InjectRepository and a repository held under any property name', () => {
    const violations = walk({
      [HANDLER_FILE]: handler(
        'return this.things.find();',
        '@InjectRepository(Thing) private readonly things: Repository<Thing>',
        "import { Repository } from 'typeorm';",
      ),
    });
    expect(reasons(violations)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('@InjectRepository'),
        expect.stringContaining('injects Repository'),
      ]),
    );
  });

  it('follows collaborators of collaborators and flags a boundary opened two levels down', () => {
    // SCENARIO: handler → service → reader, and the reader calls runInTenantRead itself.
    // EXPECTS: the violation is found on the reader, two injections away from the responder.
    const violations = walk({
      [HANDLER_FILE]: handler(
        'return this.service.run();',
        'private readonly service: ThingService',
        "import { ThingService } from './thing.service';",
      ),
      [`${APP}/thing/thing.service.ts`]: `import { ThingReader } from './thing.reader';
export class ThingService { constructor(private readonly reader: ThingReader) {} run() { return this.reader.read(); } }`,
      [`${APP}/thing/thing.reader.ts`]: `import { runInTenantRead } from '@aquaculture/backend-common/database';
export class ThingReader { read() { return runInTenantRead(); } }`,
    });
    expect(violations).toEqual([
      { node: `${APP}/thing/thing.reader.ts#ThingReader`, reason: 'calls runInTenantRead()' },
    ]);
  });

  it('checks only the static method a handler calls, and flags it when it escapes', () => {
    // SCENARIO: a handler calls a static helper on a service that holds a repository.
    // EXPECTS: the service's constructor is not a violation (not reached), but a
    //          static that calls getScopedRepository is.
    const service = `import { Repository } from 'typeorm';
export class ThingService {
  constructor(private readonly repo: Repository<unknown>) {}
  static clean(x: number) { return x + 1; }
  static dirty() { return getScopedRepository(); }
}`;
    const clean = walk({
      [HANDLER_FILE]: handler(
        'return ThingService.clean(1);',
        '',
        "import { ThingService } from './thing.service';",
      ),
      [`${APP}/thing/thing.service.ts`]: service,
    });
    expect(clean).toEqual([]);
    const dirty = walk({
      [HANDLER_FILE]: handler(
        'return ThingService.dirty();',
        '',
        "import { ThingService } from './thing.service';",
      ),
      [`${APP}/thing/thing.service.ts`]: service,
    });
    expect(reasons(dirty)).toEqual(['calls getScopedRepository()']);
  });

  it.each([
    [
      'schema-qualified SQL',
      'return query.scope.query(`SELECT * FROM "farm"."equipment_types"`);',
      'names a schema',
    ],
    [
      'a search_path change',
      'return query.scope.query("SELECT set_config(\'search_path\', $1, true)");',
      'search_path',
    ],
    [
      'the connection behind the manager',
      'return query.scope.manager.connection.query("SELECT 1");',
      '.connection',
    ],
    ['a second query runner', 'return x.createQueryRunner();', '.createQueryRunner()'],
    ['a boundary of its own', 'return TenantScope.read(ds, "farm", t, f);', 'TenantScope.read'],
    [
      'state that outlives a request',
      'this.cache = await query.scope.manager.find(Thing, {}); return this.cache;',
      'outside the constructor',
    ],
  ])('flags %s', (_case, body, expected) => {
    const violations = walk({ [HANDLER_FILE]: handler(body) });
    expect(reasons(violations)).toEqual(
      expect.arrayContaining([expect.stringContaining(expected)]),
    );
  });

  it('flags a process-wide cache field and an unreviewed package collaborator', () => {
    const violations = walk({
      [HANDLER_FILE]: `
import { QueryHandler } from '@platform/cqrs';
import { HttpService } from '@nestjs/axios';
import { GetThingQuery } from './get-thing.query';
@QueryHandler(GetThingQuery)
export class GetThingHandler {
  private readonly cache = new Map<string, unknown>();
  constructor(private readonly http: HttpService) {}
  async execute() { return 1; }
}`,
    });
    expect(reasons(violations)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('holds a Map'),
        expect.stringContaining('injects HttpService from a package that is not reviewed'),
      ]),
    );
  });

  it('refuses a query with no handler or more than one', () => {
    const violations = walk({});
    expect(reasons(violations)).toEqual(['GetThingQuery: 0 handlers found (expected exactly one)']);
  });
});
