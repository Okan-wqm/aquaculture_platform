/**
 * tank-operation.enums SSoT invariants (FARM-HIGH-054 / FARM-MEDIUM-052).
 *
 * Asserts the leaf enum module is the single source of truth: the canonical
 * value sets match event-contracts, QUALITY / PREDATION / CANNIBALISM are
 * present, the type guards behave, and the command-file re-exports share ONE
 * identity with the entity copy (so a future drift cannot reintroduce the bug).
 */
import { CULL_REASONS, MORTALITY_REASONS } from '@platform/event-contracts';

import { CullReason as CommandCullReason } from '../../commands/record-cull.command';
import { MortalityReason as CommandMortalityReason } from '../../commands/record-mortality.command';
import {
  CullReason,
  MortalityReason,
  OperationType,
  isCullReason,
  isMortalityReason,
} from '../../entities/tank-operation.enums';
import {
  CullReason as EntityCullReason,
  MortalityReason as EntityMortalityReason,
} from '../../entities/tank-operation.entity';

describe('tank-operation.enums SSoT', () => {
  it('CullReason values exactly match event-contracts CULL_REASONS (case-insensitive)', () => {
    const enumValues = Object.values(CullReason).map((v) => v.toUpperCase()).sort();
    expect(enumValues).toEqual([...CULL_REASONS].sort());
  });

  it('CullReason includes QUALITY (FARM-HIGH-054)', () => {
    expect(CullReason.QUALITY).toBe('quality');
    expect(Object.values(CullReason)).toContain('quality');
  });

  it('MortalityReason values exactly match event-contracts MORTALITY_REASONS (case-insensitive)', () => {
    const enumValues = Object.values(MortalityReason).map((v) => v.toUpperCase()).sort();
    expect(enumValues).toEqual([...MORTALITY_REASONS].sort());
  });

  it('MortalityReason includes PREDATION + CANNIBALISM (FARM-MEDIUM-052)', () => {
    expect(MortalityReason.PREDATION).toBe('predation');
    expect(MortalityReason.CANNIBALISM).toBe('cannibalism');
  });

  it('OperationType carries the full production + cleaner-fish set', () => {
    expect(OperationType.MORTALITY).toBe('mortality');
    expect(OperationType.CULL).toBe('cull');
    expect(OperationType.TRANSFER_IN).toBe('transfer_in');
    expect(OperationType.TRANSFER_OUT).toBe('transfer_out');
  });

  it('the command and entity re-exports are the SAME identity (one SSoT)', () => {
    expect(CommandCullReason).toBe(CullReason);
    expect(EntityCullReason).toBe(CullReason);
    expect(CommandMortalityReason).toBe(MortalityReason);
    expect(EntityMortalityReason).toBe(MortalityReason);
  });

  describe('type guards', () => {
    it('isCullReason accepts canonical values and rejects junk', () => {
      expect(isCullReason('quality')).toBe(true);
      expect(isCullReason('grading')).toBe(true);
      expect(isCullReason('nope')).toBe(false);
      expect(isCullReason(undefined)).toBe(false);
    });

    it('isMortalityReason accepts predation/cannibalism and rejects junk', () => {
      expect(isMortalityReason('predation')).toBe(true);
      expect(isMortalityReason('cannibalism')).toBe(true);
      expect(isMortalityReason('PREDATION')).toBe(false); // values are lowercase
      expect(isMortalityReason('garbage')).toBe(false);
      expect(isMortalityReason(null)).toBe(false);
    });
  });
});
