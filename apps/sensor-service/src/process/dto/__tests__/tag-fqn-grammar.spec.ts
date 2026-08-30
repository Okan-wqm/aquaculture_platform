import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { CreateTagInput, UpdateTagInput } from '../unified-tag.dto';

/**
 * SENSOR-MEDIUM-020 — the registry FQN must match the canonical TagRef grammar.
 *
 * An fqn that violates `deviceCode/localName` can never be resolved at
 * deploy/subscribe time, so a create/update with a malformed fqn would mint an
 * unresolvable "ghost" row. The DTO now rejects it at the boundary.
 */

async function fqnErrors(instance: object): Promise<boolean> {
  const errors = await validate(instance);
  return errors.some((e) => e.property === 'fqn');
}

describe('tag fqn TagRef grammar (SENSOR-MEDIUM-020)', () => {
  it('accepts a canonical deviceCode/localName fqn on create', async () => {
    const dto = plainToInstance(CreateTagInput, {
      fqn: 'EDGE-AABB1122/tank1.do',
      localName: 'tank1.do',
      ioType: 'analog_input',
      dataType: 'float',
      direction: 'input',
    });
    expect(await fqnErrors(dto)).toBe(false);
  });

  it('rejects an fqn with no device segment on create', async () => {
    const dto = plainToInstance(CreateTagInput, {
      fqn: 'tank1.do', // missing the deviceCode/ prefix
      localName: 'tank1.do',
      ioType: 'analog_input',
      dataType: 'float',
      direction: 'input',
    });
    expect(await fqnErrors(dto)).toBe(true);
  });

  it('rejects an fqn with whitespace or a second slash on create', async () => {
    for (const bad of ['EDGE 1/tank1', 'EDGE-1/tank1/extra', 'EDGE-1/']) {
      const dto = plainToInstance(CreateTagInput, {
        fqn: bad,
        localName: 'tank1',
        ioType: 'analog_input',
        dataType: 'float',
        direction: 'input',
      });
      expect(await fqnErrors(dto)).toBe(true);
    }
  });

  it('rejects a malformed fqn on update but allows omitting it', async () => {
    const bad = plainToInstance(UpdateTagInput, {
      id: '11111111-1111-1111-1111-111111111111',
      fqn: 'no-slash-here',
    });
    expect(await fqnErrors(bad)).toBe(true);

    const omitted = plainToInstance(UpdateTagInput, {
      id: '11111111-1111-1111-1111-111111111111',
      displayName: 'renamed',
    });
    expect(await fqnErrors(omitted)).toBe(false);
  });
});
