/**
 * findNavPage (FE-HIGH-334): links the shell builds outside the rail (the
 * annunciator's alarm list, the palette's people and devices) exist exactly
 * when the viewer's nav lists their page.
 */
import { describe, expect, it } from 'vitest';

import { buildConsoleNav } from '../buildConsoleNav';
import { findNavPage } from '../findNavPage';

import { ALL_CAPABILITIES, navInput } from './viewers.fixture';

describe('findNavPage', () => {
  it("finds a page of the viewer's nav by id, at the path the rail uses", () => {
    const nav = buildConsoleNav(
      navInput({ role: 'TENANT_ADMIN', modules: ['sensor'], permissions: ALL_CAPABILITIES }),
    );
    expect(findNavPage(nav, 'alarms')?.path).toBe('/sensor/alerts');
    expect(findNavPage(nav, 'tenant-users')?.path).toBe('/tenant/users');
  });

  it('finds nothing the viewer cannot open', () => {
    const nav = buildConsoleNav(
      navInput({ role: 'MODULE_USER', modules: ['farm'], permissions: [] }),
    );
    expect(findNavPage(nav, 'alarms')).toBeUndefined();
    expect(findNavPage(nav, 'tenant-users')).toBeUndefined();
    expect(findNavPage([], 'alarms')).toBeUndefined();
  });
});
