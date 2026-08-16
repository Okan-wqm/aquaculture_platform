import { validate as isUuid } from 'uuid';

import { SYSTEM_ACTOR_ID } from '../system-actor';

describe('SYSTEM_ACTOR_ID', () => {
  it('is the collision-free RFC 4122 nil UUID accepted by UUID persistence', () => {
    expect(SYSTEM_ACTOR_ID).toBe('00000000-0000-0000-0000-000000000000');
    expect(isUuid(SYSTEM_ACTOR_ID)).toBe(true);
  });
});
