import { validate as isUUID } from 'uuid';

import { SYSTEM_ACTOR_ID } from '../system-actor';

describe('SYSTEM_ACTOR_ID', () => {
  it('is the RFC-4122 nil UUID and a syntactically valid uuid', () => {
    expect(SYSTEM_ACTOR_ID).toBe('00000000-0000-0000-0000-000000000000');
    // Must be a structurally valid uuid so it can be stored in uuid columns
    // (the whole point — 'system' fails Postgres 22P02).
    expect(isUUID(SYSTEM_ACTOR_ID)).toBe(true);
  });
});
