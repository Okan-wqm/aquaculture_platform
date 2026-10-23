/**
 * showsFarmSites — farm sites belong to the Production workspace and the all-modules view.
 */
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { describe, expect, it } from 'vitest';

import { showsFarmSites } from '../siteScope';

describe('showsFarmSites', () => {
  it.each<[string, HrModuleCode | undefined, boolean]>([
    ['Production', 'FARM', true],
    ['Company (every module)', undefined, true],
    ['Greenhouse', 'HYDROPONICS', false],
    ['Control & sensors', 'SENSOR', false],
  ])('%s -> %s', (_label, scope, expected) => {
    expect(showsFarmSites(scope)).toBe(expected);
  });
});
