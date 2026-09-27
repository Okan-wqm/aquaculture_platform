import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateChannelInput } from '../create-channel.input';
import { ChannelType } from '../../entities/channel.entity';

/**
 * AISAFETY-MEDIUM-024 — an AI channel can only pin a PUBLISHED persona id.
 * Grammar-valid-but-unknown ids (which every subsequent turn would reject)
 * are refused at creation.
 */
describe('CreateChannelInput.aiPersona (IsKnownAiPersonaId)', () => {
  const build = (aiPersona?: string | null): CreateChannelInput =>
    plainToInstance(CreateChannelInput, {
      type: ChannelType.AI,
      name: 'Production help',
      memberIds: [],
      ...(aiPersona !== undefined ? { aiPersona } : {}),
    });

  it('accepts a published composite id and the legacy general ids', async () => {
    for (const id of ['expert-farm-production-v1', 'operator-v1', 'supervisor-v1']) {
      const errors = await validate(build(id));
      expect(errors.filter((e) => e.property === 'aiPersona')).toEqual([]);
    }
  });

  it('accepts no persona (tenant default)', async () => {
    const errors = await validate(build());
    expect(errors.filter((e) => e.property === 'aiPersona')).toEqual([]);
  });

  it('rejects grammar-valid but unpublished ids and malformed ids', async () => {
    for (const id of [
      'expert-hr-payroll-v1',
      'supervisor-farm-production-v1',
      'expert-general-v1',
      'bogus',
    ]) {
      const errors = await validate(build(id));
      const personaError = errors.find((e) => e.property === 'aiPersona');
      expect(personaError?.constraints).toHaveProperty('isKnownAiPersonaId');
    }
  });
});
