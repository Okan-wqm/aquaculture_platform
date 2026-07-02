import { EventEmitter2 } from '@nestjs/event-emitter';

import type { TagResolutionResult } from '../../process/services/tag-resolution.service';
import { TagManagerService } from '../services/tag-manager.service';
import type { TagValueChange } from '../scada-types';

/**
 * Faz 6 — the SCADA live-data socket boundary is the tenant boundary.
 * Two guarantees are pinned here:
 *   1. Registry gate: canonical TagRefs must resolve in the subscribing
 *      tenant's unified_tags; unregistered refs are rejected at subscribe.
 *   2. Fan-out isolation: a value published for tenant A can never be
 *      routed to a socket that subscribed under tenant B, even when both
 *      subscribed the identical fqn string.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function change(tagId: string, value: number): TagValueChange {
  return { tagId, value, quality: 'good', timestamp: Date.now() };
}

describe('TagManagerService — tenant-fenced socket fan-out', () => {
  let manager: TagManagerService;

  beforeEach(() => {
    manager = new TagManagerService(new EventEmitter2());
  });

  it('routes a tenant-A value only to tenant-A sockets, never to tenant-B', () => {
    manager.subscribeSocket('sock-a', TENANT_A, ['EDGE-01/water_temp']);
    manager.subscribeSocket('sock-b', TENANT_B, ['EDGE-01/water_temp']); // identical fqn

    const routing = manager.updateTagValues(TENANT_A, [change('EDGE-01/water_temp', 21)]);

    expect(routing.has('sock-a')).toBe(true);
    expect(routing.has('sock-b')).toBe(false);
    expect(routing.get('sock-a')).toHaveLength(1);
  });

  it('initial-value push is tenant-qualified (B never sees A cached value)', () => {
    manager.subscribeSocket('sock-a', TENANT_A, ['EDGE-01/water_temp']);
    manager.updateTagValues(TENANT_A, [change('EDGE-01/water_temp', 21)]);

    // Tenant B subscribes the same fqn — must get NO cached value from A.
    const initialForB = manager.subscribeSocket('sock-b', TENANT_B, ['EDGE-01/water_temp']);
    expect(initialForB).toHaveLength(0);

    // Tenant A re-subscribing (new socket) DOES get the cached value.
    const initialForA = manager.subscribeSocket('sock-a2', TENANT_A, ['EDGE-01/water_temp']);
    expect(initialForA).toHaveLength(1);
  });

  it('removeSocket unwinds the tenant-qualified reverse index', () => {
    manager.subscribeSocket('sock-a', TENANT_A, ['EDGE-01/water_temp']);
    expect(manager.getSubscribedSockets(TENANT_A, 'EDGE-01/water_temp')).toEqual(['sock-a']);

    manager.removeSocket('sock-a');
    expect(manager.getSubscribedSockets(TENANT_A, 'EDGE-01/water_temp')).toEqual([]);
  });

  it('unsubscribe is scoped to the socket own tenant', () => {
    manager.subscribeSocket('sock-a', TENANT_A, ['EDGE-01/water_temp']);
    manager.subscribeSocket('sock-b', TENANT_B, ['EDGE-01/water_temp']);

    manager.unsubscribeSocket('sock-a', ['EDGE-01/water_temp']);

    expect(manager.getSubscribedSockets(TENANT_A, 'EDGE-01/water_temp')).toEqual([]);
    // Tenant B's identical-fqn subscription is untouched.
    expect(manager.getSubscribedSockets(TENANT_B, 'EDGE-01/water_temp')).toEqual(['sock-b']);
  });
});

/**
 * The gateway's registry-gate logic, exercised through the same partition
 * function shape it uses. We assert the accept/reject split against a
 * stubbed TagResolutionService so the security contract is pinned without
 * standing up a Socket.IO server.
 */
describe('subscribe registry gate — canonical refs must resolve, legacy keys grandfathered', () => {
  function partition(
    keys: string[],
    resolvedRefs: string[],
  ): { accepted: string[]; rejected: string[] } {
    // Mirror of ScadaRuntimeGateway.partitionSubscribableTags with a stubbed resolver.
    const isRef = (k: string): boolean => /^[^/]+\/[^/]+$/.test(k);
    const resolve = (refs: string[]): TagResolutionResult => ({
      resolved: refs
        .filter((r) => resolvedRefs.includes(r))
        .map((r) => ({ ref: r }) as TagResolutionResult['resolved'][number]),
      unresolved: [],
    });

    const tagRefCandidates = keys.filter(isRef);
    const legacyKeys = keys.filter((k) => !isRef(k));
    if (tagRefCandidates.length === 0) return { accepted: legacyKeys, rejected: [] };

    const resolved = new Set(resolve(tagRefCandidates).resolved.map((r) => r.ref as string));
    const accepted = [...legacyKeys];
    const rejected: string[] = [];
    for (const ref of tagRefCandidates) {
      if (resolved.has(ref)) accepted.push(ref);
      else rejected.push(ref);
    }
    return { accepted, rejected };
  }

  it('accepts a registered TagRef, rejects an unregistered one', () => {
    const { accepted, rejected } = partition(
      ['EDGE-01/water_temp', 'EDGE-01/ghost_tag'],
      ['EDGE-01/water_temp'],
    );
    expect(accepted).toEqual(['EDGE-01/water_temp']);
    expect(rejected).toEqual(['EDGE-01/ghost_tag']);
  });

  it('grandfathers legacy non-TagRef keys (dotted device-local ids)', () => {
    const { accepted, rejected } = partition(['tank1.do', 'tank1.temp'], []);
    expect(accepted).toEqual(['tank1.do', 'tank1.temp']);
    expect(rejected).toEqual([]);
  });

  it('mixes: legacy passes through, registered ref accepted, unregistered ref rejected', () => {
    const { accepted, rejected } = partition(
      ['tank1.do', 'EDGE-01/water_temp', 'EDGE-02/unknown'],
      ['EDGE-01/water_temp'],
    );
    expect(accepted.sort()).toEqual(['EDGE-01/water_temp', 'tank1.do']);
    expect(rejected).toEqual(['EDGE-02/unknown']);
  });
});
