import { validate } from 'class-validator';

import { AssignUserToSiteInput } from './tenant-admin.dto';

describe('AssignUserToSiteInput', () => {
  it('accepts only UUID v4 user and site identities', async () => {
    const valid = Object.assign(new AssignUserToSiteInput(), {
      userId: '11111111-1111-4111-8111-111111111111',
      siteId: '22222222-2222-4222-8222-222222222222',
    });
    await expect(validate(valid)).resolves.toHaveLength(0);

    const nonV4 = Object.assign(new AssignUserToSiteInput(), {
      userId: '11111111-1111-1111-8111-111111111111',
      siteId: '22222222-2222-1222-8222-222222222222',
    });
    const errors = await validate(nonV4);
    expect(errors.map((error) => error.property).sort()).toEqual(['siteId', 'userId']);
  });
});
