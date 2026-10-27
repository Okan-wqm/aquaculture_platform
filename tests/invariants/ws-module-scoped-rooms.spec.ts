/**
 * INVARIANT: every realtime socket joins only module or site rooms (SEC-CRITICAL-206,
 * SEC-CRITICAL-207; ADR-051 §3 step 1 and its Enforcement table, PKG-10).
 *
 * The /farms, /sensors and /st-language gateways joined every socket to one `tenant:{id}` room
 * and pushed farm-private and sensor-private events into it, so any tenant member who opened the
 * socket received them whatever their module. PKG-10 moved them onto the room vocabulary of
 * `libs/backend-common/src/websocket/module-socket-rooms.ts`: a room is built only by its
 * builders (`t:{tenant}:m:{module}[:site:{id}]`, `t:{tenant}:registry:{module}`), the join and
 * emit helpers accept only those rooms, and a socket joins only the rooms `decideAccess` allows.
 * The compiler holds a gateway that uses the helpers; this spec holds every gateway to the
 * helpers, so a new socket or a raw `client.join('tenant:…')` cannot come back unnoticed.
 *
 * It reads the repository the way the runtime does:
 *
 *   1. every `@WebSocketGateway` in apps/ and libs/ has exactly one room policy below, under its
 *      namespace, and no policy outlives its gateway;
 *   2. a `module-rooms` gateway builds its member from the verified token (`socketMemberOf`),
 *      joins and emits only through the vocabulary (no `client.join`, `server.to`, `.in` or
 *      `.except` of its own, no tenant room literal, no raw server handed out) and registers each
 *      socket with `WsTokenRevalidator`, which drops it once its token is revoked;
 *   3. a `requester-only` gateway joins no room at all; a `membership-rooms` gateway joins only
 *      per-user and per-channel rooms under the tenant; a `tenant-room-pending` gateway names the
 *      registered finding and package that move it, and fails here the day it no longer needs the
 *      exemption;
 *   4. every nginx location that forwards an Upgrade header to a service either routes a Socket.IO
 *      engine path whose gateways are all classified here, or is named below with the reason it
 *      serves no socket; and every gateway is reachable through such a location in the droplet
 *      configuration;
 *   5. the gateway's revalidator re-checks each socket at least every 60 s (ADR-051 §7 timing:
 *      sockets dropped within 60 s after a revocation).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { stripComments } from './helpers/ts-source';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DROPLET_NGINX = 'infrastructure/nginx/droplet.conf';
const FINDINGS = 'docs/reviews/_registry/findings.jsonl';
const GATEWAY_WEBSOCKET_MODULE = 'apps/gateway-api/src/websocket/websocket.module.ts';
const DEFAULT_ENGINE_PATH = '/socket.io/';
const MAX_REVALIDATION_INTERVAL_MS = 60_000;

type GatewayRoomPolicy =
  | { readonly kind: 'module-rooms'; readonly namespace: string }
  | { readonly kind: 'requester-only'; readonly namespace: string; readonly reason: string }
  | { readonly kind: 'membership-rooms'; readonly namespace: string; readonly reason: string }
  | {
      readonly kind: 'tenant-room-pending';
      readonly namespace: string;
      readonly owner: string;
      readonly findingId: string;
    };

/** One room policy per socket gateway, keyed by the file that declares it. */
const GATEWAY_ROOM_POLICY: Readonly<Record<string, GatewayRoomPolicy>> = {
  'apps/gateway-api/src/websocket/farm.gateway.ts': { kind: 'module-rooms', namespace: '/farms' },
  'apps/gateway-api/src/websocket/sensor-readings.gateway.ts': {
    kind: 'module-rooms',
    namespace: '/sensors',
  },
  'apps/gateway-api/src/websocket/st-language.gateway.ts': {
    kind: 'module-rooms',
    namespace: '/st-language',
  },
  'apps/gateway-api/src/websocket/ai-chat.gateway.ts': {
    kind: 'requester-only',
    namespace: '/ai',
    reason:
      'answers each ai:chat on the asking socket only; ai-service decides the persona and tools ' +
      'from the forwarded moduleAccess (RBAC-HIGH-028, PKG-09/PKG-12)',
  },
  'apps/gateway-api/src/websocket/messaging.gateway.ts': {
    kind: 'membership-rooms',
    namespace: '/messaging',
    reason:
      'joins user:{tenant}:{user} and, after messaging-service confirms membership, ' +
      'channel:{tenant}:{channel}; module channels are decided by messaging-service (PKG-25)',
  },
  'apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts': {
    kind: 'tenant-room-pending',
    namespace: '/scada',
    owner: 'PKG-11 (release R5)',
    findingId: 'SENSOR-HIGH-202',
  },
};

/**
 * nginx locations that forward an Upgrade header to a service but reach no Socket.IO engine,
 * keyed by `service location`, with the reason.
 */
const NON_SOCKET_UPGRADES: Readonly<Record<string, string>> = {
  'gateway-api /graphql':
    'GraphQL over HTTP; the Upgrade header rides the $connection_upgrade keep-alive map and the ' +
    'gateway runs no subscription transport (checked below)',
};

/** Room operations a module-rooms gateway leaves to the vocabulary. */
const DIRECT_ROOM_OPERATION =
  /\b(?:client|socket|server|this\.server|nsp|namespace)\s*\.\s*(?:join|leave|to|in|except|socketsJoin|socketsLeave)\s*\(/;
const TENANT_ROOM_LITERAL = /['"`]tenant:/;
const REVALIDATION = /\btokenRevalidator\s*\.\s*register\s*\(/;
const SUBSCRIPTION_TRANSPORT = /graphql-ws|subscriptions-transport-ws|installSubscriptionHandlers/;

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

/** Files git tracks or would track (a new, unstaged file counts), for the given pathspecs. */
function trackedFiles(pathspecs: readonly string[]): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

/** The first capture group of `pattern` in `text`, or null. */
function firstGroup(pattern: RegExp, text: string): string | null {
  const match = pattern.exec(text);
  return match === null ? null : (match[1] ?? null);
}

function isSourceFile(file: string): boolean {
  return (
    file.endsWith('.ts') &&
    !file.endsWith('.spec.ts') &&
    !file.endsWith('.test.ts') &&
    !file.includes('/__tests__/')
  );
}

interface DiscoveredGateway {
  readonly file: string;
  readonly service: string;
  readonly namespace: string | null;
  readonly enginePath: string;
}

/** The text of the argument list that starts at `open` (an opening parenthesis). */
function argumentText(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

function discoverGateways(): DiscoveredGateway[] {
  const gateways: DiscoveredGateway[] = [];
  const sources = trackedFiles([':(glob)apps/*/src/**/*.ts', ':(glob)libs/*/src/**/*.ts']);
  for (const file of sources.filter(isSourceFile)) {
    const raw = read(file);
    if (!raw.includes('@WebSocketGateway')) continue;
    const code = stripComments(raw);
    for (const match of code.matchAll(/@WebSocketGateway\s*\(/g)) {
      const options = argumentText(code, (match.index ?? 0) + match[0].length - 1);
      gateways.push({
        file,
        service: file.split('/')[1] as string,
        namespace: firstGroup(/namespace\s*:\s*['"]([^'"]+)['"]/, options),
        enginePath: firstGroup(/\bpath\s*:\s*['"]([^'"]+)['"]/, options) ?? DEFAULT_ENGINE_PATH,
      });
    }
  }
  return gateways;
}

interface UpgradeLocation {
  readonly conf: string;
  readonly path: string;
  readonly host: string;
}

/** Every nginx location of `conf` that forwards an Upgrade header, with its upstream host. */
function upgradeLocations(conf: string): UpgradeLocation[] {
  const text = read(conf).replace(/^\s*#.*$/gm, '');
  const upstreams = new Map<string, string>();
  for (const block of text.matchAll(/upstream\s+(\S+)\s*\{([^}]*)\}/g)) {
    const server = /server\s+([A-Za-z0-9_.-]+)(?::\d+)?/.exec(block[2] as string);
    if (server) upstreams.set(block[1] as string, server[1] as string);
  }
  const locations: UpgradeLocation[] = [];
  for (const match of text.matchAll(/location\s+(?:=|\^~)?\s*(\S+)\s*\{/g)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1;
      if (text[i] === '}') depth -= 1;
      i += 1;
    }
    const body = text.slice(start, i - 1);
    if (!/proxy_set_header\s+Upgrade\b/.test(body)) continue;
    const vars = new Map<string, string>();
    for (const set of body.matchAll(/set\s+\$(\w+)\s+([A-Za-z0-9_.-]+);/g)) {
      vars.set(set[1] as string, set[2] as string);
    }
    const byVariable = /proxy_pass\s+https?:\/\/\$(\w+)/.exec(body);
    const byName = /proxy_pass\s+https?:\/\/([A-Za-z0-9_.-]+)/.exec(body);
    const host = byVariable
      ? vars.get(byVariable[1] as string)
      : byName
        ? (upstreams.get(byName[1] as string) ?? (byName[1] as string))
        : undefined;
    if (host !== undefined) locations.push({ conf, path: match[1] as string, host });
  }
  return locations;
}

function nginxConfigurations(): string[] {
  return trackedFiles(['nginx', 'infrastructure']).filter(
    (file) => /\.conf(\.template)?$/.test(file) && /(^|\/)nginx\//.test(file),
  );
}

/** A host nginx proxies to is a service when an app of that name exists. */
function isService(host: string): boolean {
  return existsSync(resolve(REPO_ROOT, 'apps', host, 'src'));
}

describe('ws-module-scoped-rooms (SEC-CRITICAL-206, SEC-CRITICAL-207)', () => {
  const gateways = discoverGateways();

  it('finds the socket gateways it guards', () => {
    expect(gateways.length).toBeGreaterThanOrEqual(Object.keys(GATEWAY_ROOM_POLICY).length);
  });

  it('gives every @WebSocketGateway exactly one room policy, under its namespace', () => {
    const discovered = gateways.map((gateway) => ({
      file: gateway.file,
      namespace: gateway.namespace,
    }));
    const declared = Object.entries(GATEWAY_ROOM_POLICY).map(([file, policy]) => ({
      file,
      namespace: policy.namespace,
    }));
    const byFile = (a: { file: string }, b: { file: string }): number =>
      a.file.localeCompare(b.file);
    expect(discovered.sort(byFile)).toEqual(declared.sort(byFile));
  });

  describe.each(
    Object.entries(GATEWAY_ROOM_POLICY).filter(([, policy]) => policy.kind === 'module-rooms'),
  )('module-rooms gateway %s', (file) => {
    it('builds its member from the verified token and joins and emits only through the vocabulary', () => {
      const code = stripComments(read(file));
      expect({
        file,
        buildsMember: /\bsocketMemberOf\s*\(/.test(code),
        registersRevalidation: REVALIDATION.test(code),
        usesVocabulary: /\b(?:joinModuleRooms|emitToModuleRooms)\s*\(/.test(code),
        directRoomOperation: DIRECT_ROOM_OPERATION.test(code),
        tenantRoom: TENANT_ROOM_LITERAL.test(code),
        handsOutServer: /\bgetServer\s*\(/.test(code),
      }).toEqual({
        file,
        buildsMember: true,
        registersRevalidation: true,
        usesVocabulary: true,
        directRoomOperation: false,
        tenantRoom: false,
        handsOutServer: false,
      });
    });
  });

  describe.each(
    Object.entries(GATEWAY_ROOM_POLICY).filter(([, policy]) => policy.kind === 'requester-only'),
  )('requester-only gateway %s', (file) => {
    it('joins no room and broadcasts to none', () => {
      const code = stripComments(read(file));
      expect({
        file,
        directRoomOperation: DIRECT_ROOM_OPERATION.test(code),
        holdsServer: /@WebSocketServer\s*\(/.test(code),
        registersRevalidation: REVALIDATION.test(code),
      }).toEqual({
        file,
        directRoomOperation: false,
        holdsServer: false,
        registersRevalidation: true,
      });
    });
  });

  describe.each(
    Object.entries(GATEWAY_ROOM_POLICY).filter(([, policy]) => policy.kind === 'membership-rooms'),
  )('membership-rooms gateway %s', (file) => {
    it('joins only per-user and per-channel rooms under the tenant, never a tenant room', () => {
      const code = stripComments(read(file));
      const rooms = [...code.matchAll(/`(user|channel):\$\{([^}]+)\}/g)];
      expect(rooms.length).toBeGreaterThan(0);
      expect({
        file,
        tenantRoom: TENANT_ROOM_LITERAL.test(code),
        registersRevalidation: REVALIDATION.test(code),
        roomsOutsideTenant: rooms
          .filter((room) => !/tenantId$/.test(room[2] as string))
          .map((room) => room[0]),
      }).toEqual({ file, tenantRoom: false, registersRevalidation: true, roomsOutsideTenant: [] });
    });
  });

  describe.each(
    Object.entries(GATEWAY_ROOM_POLICY).flatMap(([file, policy]) =>
      policy.kind === 'tenant-room-pending' ? [[file, policy] as const] : [],
    ),
  )('tenant-room-pending gateway %s', (file, policy) => {
    it('names a registered finding and the package that moves it to module rooms', () => {
      expect(read(FINDINGS)).toContain(`"id":"${policy.findingId}"`);
      expect(policy.owner).toMatch(/^PKG-\d+/);
    });

    it('still needs the exemption: the day it joins no tenant room, it becomes module-rooms', () => {
      expect({ file, tenantRoom: TENANT_ROOM_LITERAL.test(stripComments(read(file))) }).toEqual({
        file,
        tenantRoom: true,
      });
    });
  });

  it('classifies every nginx location that forwards an Upgrade header to a service', () => {
    const problems: string[] = [];
    for (const location of nginxConfigurations().flatMap(upgradeLocations)) {
      if (!isService(location.host)) continue; // a static frontend container serves no socket
      const routed = gateways.filter(
        (gateway) => gateway.service === location.host && gateway.enginePath === location.path,
      );
      const reason = NON_SOCKET_UPGRADES[`${location.host} ${location.path}`];
      if (routed.length === 0 && reason === undefined) {
        problems.push(`${location.conf}: ${location.path} → ${location.host} is unclassified`);
      }
      for (const gateway of routed) {
        if (GATEWAY_ROOM_POLICY[gateway.file] === undefined) {
          problems.push(`${location.conf}: ${location.path} reaches unclassified ${gateway.file}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('routes every gateway through an Upgrade location of the droplet configuration', () => {
    const routed = upgradeLocations(DROPLET_NGINX);
    const unrouted = gateways
      .filter(
        (gateway) =>
          !routed.some(
            (location) => location.host === gateway.service && location.path === gateway.enginePath,
          ),
      )
      .map((gateway) => gateway.file);
    expect(unrouted).toEqual([]);
  });

  it('keeps each non-socket Upgrade location free of a subscription transport', () => {
    for (const key of Object.keys(NON_SOCKET_UPGRADES)) {
      const service = key.split(' ')[0] as string;
      const offenders = trackedFiles([`apps/${service}/src`])
        .filter(isSourceFile)
        .filter((file) => SUBSCRIPTION_TRANSPORT.test(stripComments(read(file))));
      expect({ service, offenders }).toEqual({ service, offenders: [] });
    }
  });

  it('re-checks every gateway socket at least every 60 s', () => {
    const interval = firstGroup(
      /new WsTokenRevalidator\(\{\s*intervalMs:\s*([\d_]+)/,
      stripComments(read(GATEWAY_WEBSOCKET_MODULE)),
    );
    expect(interval).not.toBeNull();
    expect(Number(String(interval).replace(/_/g, ''))).toBeLessThanOrEqual(
      MAX_REVALIDATION_INTERVAL_MS,
    );
  });
});
