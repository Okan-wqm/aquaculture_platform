/**
 * INVARIANT: every gateway-api surface names an access decision, and today's exceptions may only
 * shrink (ADR-054 draft D-F 2, its rollout PR-2; ADR-051 PKG-10, PKG-43).
 *
 * WHY: gateway-api terminates REST (upload, presigned URLs, the marine proxy, health) and four
 * Socket.IO gateways itself. No subgraph guard runs on them, gateway-api is not in
 * ACCESS_ENROLLED_SERVICES (libs/backend-common/src/security/access-enrolment.ts), and so the
 * ADR-051 classification invariant never reads them. Its global guards (AuthGuard,
 * TenantIsolationGuard, RateLimitGuard in apps/gateway-api/src/app.module.ts) authenticate and fix
 * the tenant; none decides by module. A new route or socket message added today ships with no
 * decision and nothing fails.
 *
 * WHAT: every surface of apps/gateway-api/src (production sources):
 *   - each REST verb handler (`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@All`, …) of a
 *     `@Controller`;
 *   - each `@SubscribeMessage` handler of a `@WebSocketGateway`;
 *   - each `@WebSocketGateway`'s connection (`handleConnection`), because a gateway that only
 *     emits, such as the farm gateway, has no message handler and is still a surface;
 * names a decision on itself or its class: an ADR-051 `@Access.*` spec, an explicit device or
 * service principal (`@ApiKeyAuth()`, `@BasicAuth()` from guards/auth.guard.ts), or an explicit
 * `@Public()`. Everything else is an exception, frozen by key (`file#Class.method`) in
 * tests/invariants/gateway-surface-access.baseline.json together with the `@Public()` set:
 *   - a surface missing from the baseline FAILS (name its decision; adding it to the baseline is
 *     a reviewed decision to ship one more undecided surface);
 *   - a baseline key the code no longer has FAILS until the same PR deletes it (the message names
 *     the keys), so the baseline is always exactly what is undecided.
 * An account-role `@Roles` (the health detail route) is not an access spec and stays an exception
 * until its package gives it one.
 *
 * Not seen: routes registered outside decorators (Express middleware in main.ts) and the
 * federated GraphQL plane, which the subgraphs decide. It changes no runtime behaviour.
 */
import {
  baselineDiff,
  gatewaySurfaceOf,
  staleKeysMessage,
  type GatewaySurfaceEntry,
} from './helpers/access-surface';
import { productionSources } from './helpers/module-access-handlers';
import { readRepoFile } from './helpers/module-dictionary-sources';

const BASELINE_FILE = 'tests/invariants/gateway-surface-access.baseline.json';

interface GatewayBaseline {
  readonly _comment: string;
  readonly generated_against: string;
  readonly undecided: readonly string[];
  readonly public: readonly string[];
}

const baseline = JSON.parse(readRepoFile(BASELINE_FILE)) as GatewayBaseline;

const surface: readonly GatewaySurfaceEntry[] = productionSources(['apps/gateway-api/src']).flatMap(
  (file) => gatewaySurfaceOf(file, readRepoFile(file)),
);

const undecided = surface.filter((entry) => entry.decision === null).map((entry) => entry.key);
const declaredPublic = surface
  .filter((entry) => entry.decision === 'Public')
  .map((entry) => entry.key);

function check(set: 'undecided' | 'public', current: readonly string[]): void {
  const { grown, shrunk } = baselineDiff(current, baseline[set]);
  const problems: string[] = [];
  if (grown.length > 0) {
    problems.push(
      `gateway-api: ${grown.length} new ${set} surface(s).\n` +
        'Name the access decision (@Access.*, or an explicit device/service principal); do not add ' +
        `the key to ${BASELINE_FILE} to silence this spec.\n` +
        grown.map((key) => `  ${key}`).join('\n'),
    );
  }
  if (shrunk.length > 0) problems.push(staleKeysMessage(BASELINE_FILE, `${set} key(s)`, shrunk));
  if (problems.length > 0) throw new Error(problems.join('\n\n'));
}

describe('INVARIANT: every gateway-api surface names an access decision (ADR-054 D-F 2)', () => {
  it('no new surface without a decision', () => {
    check('undecided', undecided);
  });

  it('no new @Public() surface', () => {
    check('public', declaredPublic);
  });

  it('the scan reads the real tree: REST handlers, socket messages and connections are all found', () => {
    const roles = new Set(surface.map((entry) => entry.role));
    expect([...roles].sort()).toEqual(['connection', 'message', 'rest']);
  });
});

describe('gateway surface — self-tests on fixture sources', () => {
  const entriesOf = (source: string): GatewaySurfaceEntry[] =>
    gatewaySurfaceOf('apps/gateway-api/src/x.ts', source);

  it('a REST handler with no decision is undecided; @Public, @ApiKeyAuth and @Access decide, on it or its class', () => {
    const source =
      "@Controller('c')\nclass C {\n  @Post()\n  open() {}\n  @Public()\n  @Get()\n  ping() {}\n" +
      "  @ApiKeyAuth()\n  @Post('ingest')\n  ingest() {}\n  @Access.module('farm')\n  @Delete()\n  remove() {}\n  helper() {}\n}\n" +
      "@Public()\n@Controller('m')\nclass M {\n  @Get()\n  scrape() {}\n}\n";
    expect(entriesOf(source).map((entry) => [entry.key, entry.role, entry.decision])).toEqual([
      ['apps/gateway-api/src/x.ts#C.open', 'rest', null],
      ['apps/gateway-api/src/x.ts#C.ping', 'rest', 'Public'],
      ['apps/gateway-api/src/x.ts#C.ingest', 'rest', 'ApiKeyAuth'],
      ['apps/gateway-api/src/x.ts#C.remove', 'rest', 'Access.module'],
      ['apps/gateway-api/src/x.ts#M.scrape', 'rest', 'Public'],
    ]);
  });

  it('a socket gateway contributes its connection and each message handler; an emit-only gateway still has its connection', () => {
    const source =
      "@WebSocketGateway({ namespace: '/a' })\nclass A {\n  handleConnection(client: Socket) {}\n" +
      "  @SubscribeMessage('subscribe')\n  subscribe() {}\n  emit() {}\n}\n" +
      "@WebSocketGateway({ namespace: '/b' })\nclass B {\n  broadcast() {}\n}\n";
    expect(entriesOf(source).map((entry) => [entry.key, entry.role, entry.decision])).toEqual([
      ['apps/gateway-api/src/x.ts#A.handleConnection', 'connection', null],
      ['apps/gateway-api/src/x.ts#A.subscribe', 'message', null],
      ['apps/gateway-api/src/x.ts#B.<connection>', 'connection', null],
    ]);
  });

  it('an account-role @Roles is not an access decision; a REST verb outside a @Controller is no route', () => {
    const source =
      "@Controller('h')\nclass H {\n  @UseGuards(RolesGuard)\n  @Roles(Role.SUPER_ADMIN)\n  @Get('detail')\n  detail() {}\n}\n" +
      'class Plain {\n  @Get()\n  notARoute() {}\n}\n';
    expect(entriesOf(source).map((entry) => [entry.key, entry.decision])).toEqual([
      ['apps/gateway-api/src/x.ts#H.detail', null],
    ]);
  });
});
