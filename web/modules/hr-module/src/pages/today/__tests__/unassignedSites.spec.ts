/**
 * unassignedSites — which active sites the Today page flags.
 *
 * farm-service keeps a site's responsible persons in `site_contacts`, one of
 * them optionally primary. A site with no contact has nobody responsible; a
 * site with contacts but none marked primary has nobody answerable first.
 * Both are flagged; a site with a primary contact is not.
 */
import { describe, expect, it } from 'vitest';

import { unassignedSites } from '../unassignedSites';

describe('unassignedSites', () => {
  it('flags a site with no contact and a site with no primary contact, in site order', () => {
    expect(
      unassignedSites([
        { id: 's1', name: 'Ayvalık', contacts: [{ id: 'c1', isPrimary: true }] },
        { id: 's2', name: 'Bodrum', contacts: [] },
        {
          id: 's3',
          name: 'Kalkan',
          contacts: [
            { id: 'c2', isPrimary: false },
            { id: 'c3', isPrimary: false },
          ],
        },
      ]),
    ).toEqual([
      { id: 's2', name: 'Bodrum', gap: 'noContact', contactCount: 0 },
      { id: 's3', name: 'Kalkan', gap: 'noPrimary', contactCount: 2 },
    ]);
  });

  it('flags nothing when every site has a primary contact', () => {
    expect(
      unassignedSites([{ id: 's1', name: 'Ayvalık', contacts: [{ id: 'c1', isPrimary: true }] }]),
    ).toEqual([]);
  });
});
