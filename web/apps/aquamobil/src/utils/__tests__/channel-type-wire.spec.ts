/**
 * channel-type-wire codec tests — MSG-HIGH-054.
 *
 * The messaging subgraph registers `ChannelType` WITHOUT a valuesMap, so
 * graphql-js exposes the enum KEYs (`DIRECT`/`GROUP`/`AI`) on the wire while the
 * persisted values are lowercase (`direct`/`group`/`ai`). These tests pin the
 * boundary codec that converts between AquaMobil's internal lowercase form and
 * the wire KEY, in both directions, so the create-channel 400 can never recur.
 */

import { describe, it, expect } from 'vitest';

import { toWireChannelType, fromWireChannelType, normalizeChannelType } from '../channel-type-wire';

import type { ChannelType } from '@/types/messaging';

describe('channel-type-wire — ChannelType GraphQL wire codec (MSG-HIGH-054)', () => {
  describe('toWireChannelType — internal lowercase -> SDL KEY (write boundary)', () => {
    it('maps each internal value to the exact uppercase SDL enum KEY', () => {
      expect(toWireChannelType('direct')).toBe('DIRECT');
      expect(toWireChannelType('group')).toBe('GROUP');
      expect(toWireChannelType('ai')).toBe('AI');
    });

    it('never emits a lowercase value (the value the subgraph 400s on)', () => {
      const internals: ChannelType[] = ['direct', 'group', 'ai'];
      for (const internal of internals) {
        const wire = toWireChannelType(internal);
        expect(wire).toBe(wire.toUpperCase());
        expect(wire).not.toBe(internal);
      }
    });
  });

  describe('fromWireChannelType — SDL KEY -> internal lowercase (read boundary)', () => {
    it('maps each wire KEY back to the internal lowercase value', () => {
      expect(fromWireChannelType('DIRECT')).toBe('direct');
      expect(fromWireChannelType('GROUP')).toBe('group');
      expect(fromWireChannelType('AI')).toBe('ai');
    });

    it('tolerates a legacy already-lowercase value (offline cache round-trip)', () => {
      expect(fromWireChannelType('direct')).toBe('direct');
      expect(fromWireChannelType('group')).toBe('group');
      expect(fromWireChannelType('ai')).toBe('ai');
    });

    it('throws on an unknown wire value rather than silently passing it through', () => {
      expect(() => fromWireChannelType('CHANNEL')).toThrow(
        'Unknown ChannelType wire value: CHANNEL',
      );
      expect(() => fromWireChannelType('')).toThrow();
    });
  });

  describe('round-trip invariant — the two directions cannot drift', () => {
    it('toWire ∘ fromWire is the identity over every internal value', () => {
      const internals: ChannelType[] = ['direct', 'group', 'ai'];
      for (const internal of internals) {
        expect(fromWireChannelType(toWireChannelType(internal))).toBe(internal);
      }
    });
  });

  describe('normalizeChannelType — coerces a wire-shaped object to internal form', () => {
    it('returns a copy with type normalized to the internal lowercase value', () => {
      const wireChannel = { id: 'c1', type: 'GROUP', name: 'Ops' };
      const normalized = normalizeChannelType(wireChannel);
      expect(normalized.type).toBe('group');
      // Non-type fields are preserved unchanged.
      expect(normalized.id).toBe('c1');
      expect(normalized.name).toBe('Ops');
    });

    it('does not mutate the input object', () => {
      const wireChannel = { id: 'c1', type: 'AI' };
      normalizeChannelType(wireChannel);
      expect(wireChannel.type).toBe('AI');
    });
  });
});
