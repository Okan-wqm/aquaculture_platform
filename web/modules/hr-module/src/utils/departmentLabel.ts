/**
 * departmentLabel — how a department is named wherever one is picked from a list.
 *
 * Two departments in different modules may share a name ("Operations"), so a
 * picker names the module beside it: "Operations · Production". The module name
 * comes from moduleLabels, never retyped here.
 */
import type { EmployeeDepartment } from '../types';
import { moduleLabel, type Translate } from './moduleLabels';

export function departmentLabel(
  department: Pick<EmployeeDepartment, 'name' | 'moduleCode'>,
  t: Translate,
): string {
  return `${department.name} · ${moduleLabel(department.moduleCode, t)}`;
}
