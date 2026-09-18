import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ChannelType } from '../entities/channel.entity';
import { CreateChannelInput } from '../dto/create-channel.input';

/**
 * FARM-AI PR-0 (Sprint 1.1) — channel aiPersona validation migration.
 *
 * The old loose `@Matches(/^[a-z][a-z0-9-]*-v\d+$/)` accepted any specialty
 * token (`operator-bogus-v1`) and deferred the failure to chat time inside
 * ai-service. The catalogue check now fails fast at the trust boundary while
 * every legacy id and all 13 catalogue ids keep passing (existing AI channels
 * are unaffected).
 */
const UUID = '11111111-1111-4111-8111-111111111111';

function inputWith(aiPersona?: string): CreateChannelInput {
  return plainToInstance(CreateChannelInput, {
    type: ChannelType.AI,
    memberIds: [UUID],
    ...(aiPersona === undefined ? {} : { aiPersona }),
  });
}

async function aiPersonaErrors(value?: string) {
  const errors = await validate(inputWith(value));
  return errors.filter((e) => e.property === 'aiPersona');
}

describe('CreateChannelInput.aiPersona — catalogue membership (FARM-AI PR-0)', () => {
  it.each([
    'operator-v1',
    'manager-v1',
    'expert-v1',
    'supervisor-v1',
    'operator-farm-water-health-v1',
    'manager-farm-production-v1',
    'expert-farm-operations-v1',
  ])('accepts catalogue id %s', async (id) => {
    expect(await aiPersonaErrors(id)).toHaveLength(0);
  });

  it('accepts absence (null = tenant default assistant)', async () => {
    expect(await aiPersonaErrors(undefined)).toHaveLength(0);
  });

  it.each([
    'operator-bogus-v1', // grammar-valid, not in catalogue
    'expert-general-v1', // non-canonical form (general written by absence)
    'admin-v1', // unknown tier
    'operator-v01',
    'OPERATOR-V1',
    'operator_v1',
  ])('rejects %s at the trust boundary', async (id) => {
    const errors = await aiPersonaErrors(id);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isKnownAiPersonaId');
  });

  it('error message names the constraint and stays actionable', async () => {
    const errors = await aiPersonaErrors('operator-bogus-v1');
    expect(errors[0].constraints?.isKnownAiPersonaId).toContain('known AI persona id');
  });
});
