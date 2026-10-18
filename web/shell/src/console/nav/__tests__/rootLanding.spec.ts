/**
 * rootLanding — where `/` sends a signed-in user: the admin consoles for the
 * admins, else the first module workspace's own dashboard, else the company
 * dashboard every member may open.
 */
import { describe, expect, it } from 'vitest';

import { rootLanding } from '../rootLanding';

describe('rootLanding', () => {
  it('sends a platform admin to /admin and a tenant admin to the company dashboard', () => {
    expect(rootLanding('SUPER_ADMIN', [])).toBe('/admin');
    expect(rootLanding('TENANT_ADMIN', ['farm', 'sensor'])).toBe('/tenant');
  });

  it('sends a module user to the dashboard of the first module workspace they hold', () => {
    expect(rootLanding('MODULE_USER', ['sensor', 'farm'])).toBe('/dashboard');
    expect(rootLanding('MODULE_MANAGER', ['sensor', 'hydroponics'])).toBe('/dashboard/greenhouse');
    expect(rootLanding('MODULE_USER', ['sensor'])).toBe('/dashboard/control');
    expect(rootLanding('MODULE_USER', ['hydroponics', 'hr'])).toBe('/dashboard/greenhouse');
  });

  it('sends a user without a module workspace to the company dashboard', () => {
    expect(rootLanding('MODULE_USER', ['hr'])).toBe('/tenant');
    expect(rootLanding('MODULE_USER', [])).toBe('/tenant');
  });
});
