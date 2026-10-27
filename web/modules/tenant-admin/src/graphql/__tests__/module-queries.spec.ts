/**
 * The module documents stop reading tenant_modules.managerId in release R3 (PKG-06; ADR-051 §5:
 * "the web stops reading managerId in R3"), so PKG-06 PR2 can remove the field in R4 as a class
 * (c) change that no client of the previous release uses. The console never showed it: every
 * module card's manager was already unset. Assign / Remove Manager keep the R2 input, the module
 * id; the module code and the manager listing are read one release after the backend adds them
 * (C1).
 */
import { describe, expect, it } from 'vitest';

import {
  ASSIGN_MODULE_MANAGER_MUTATION,
  MY_TENANT_MODULES_QUERY,
  REMOVE_MODULE_MANAGER_MUTATION,
} from '../module-queries';

describe('tenant-admin module documents', () => {
  it.each([
    ['MY_TENANT_MODULES_QUERY', MY_TENANT_MODULES_QUERY],
    ['ASSIGN_MODULE_MANAGER_MUTATION', ASSIGN_MODULE_MANAGER_MUTATION],
    ['REMOVE_MODULE_MANAGER_MUTATION', REMOVE_MODULE_MANAGER_MUTATION],
  ])('%s selects no managerId', (_name, document) => {
    expect(document).not.toContain('managerId');
  });

  it('names the module of Assign / Remove Manager by the id every deployed gateway accepts', () => {
    expect(ASSIGN_MODULE_MANAGER_MUTATION).toContain('$input: AssignModuleManagerInput!');
    expect(REMOVE_MODULE_MANAGER_MUTATION).toContain('removeModuleManager(moduleId: $moduleId)');
    expect(REMOVE_MODULE_MANAGER_MUTATION).not.toContain('moduleCode');
  });
});
