/**
 * moduleLabels — the one place the HR module names a module for a reader.
 *
 * A department belongs to a module (`HrModuleCode`) or to none (company-wide).
 * Every screen that prints that fact — the department cards, the employee
 * table, the department pickers, the organization chart — reads it from here.
 * The module names are the console's own workspace names
 * (`WORKFORCE_MODULE_LABEL_KEYS`, shared-ui), translated for the reader, so a
 * module is never spelled two ways and never in the wrong language.
 */
import type { I18nContextValue } from '@aquaculture/shared-ui';
import { WORKFORCE_MODULE_LABEL_KEYS } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';

export type Translate = I18nContextValue['t'];

function isHrModuleCode(key: string): key is HrModuleCode {
  return Object.prototype.hasOwnProperty.call(WORKFORCE_MODULE_LABEL_KEYS, key);
}

/** Every module, in the order the console declares them — derived, never re-listed. */
export const MODULE_CODES: readonly HrModuleCode[] = Object.keys(
  WORKFORCE_MODULE_LABEL_KEYS,
).filter(isHrModuleCode);

/**
 * The module the console names but does not offer for placing a department: HR.
 *
 * WHY: release R1 (PKG-01 PR1) adds HR to the HRModuleCode wire enum, and contract rule C1
 * (backend first) lets the web send a value only from the release after the one that adds it.
 * The deploy restarts the gateway last, so an R1 save of HR would meet the old supergraph, and a
 * tab still on the R0 bundle could not name the department it made. A department already in HR is
 * still named (MODULE_CODES keeps its label). PKG-01 PR2 (release R2, RBAC-MEDIUM-032) deletes
 * this exclusion when it moves the web onto the single OwnerModule enum; the moduleLabels and
 * DepartmentsPage specs pin the R1 lists, so that change cannot pass with them unchanged.
 */
const NAMED_NOT_ASSIGNABLE: HrModuleCode = 'HR';

/** The modules a department can be placed in from the web, in the console's order. */
export const ASSIGNABLE_MODULE_CODES: readonly HrModuleCode[] = MODULE_CODES.filter(
  (code) => code !== NAMED_NOT_ASSIGNABLE,
);

/**
 * The modules a department form offers: the assignable ones plus the department's own module,
 * so editing a department in a module the web does not assign shows that module and keeps it.
 */
export function moduleChoicesFor(
  current: HrModuleCode | null | undefined,
): readonly HrModuleCode[] {
  return MODULE_CODES.filter((code) => code === current || ASSIGNABLE_MODULE_CODES.includes(code));
}

/** Display name of a module code; no module means the whole company. */
export function moduleLabel(moduleCode: HrModuleCode | null | undefined, t: Translate): string {
  return t(moduleCode ? WORKFORCE_MODULE_LABEL_KEYS[moduleCode] : 'hr.module.companyWide');
}

/** Name of the scope a screen is showing: the workspace's module, or every module. */
export function scopeLabel(scope: HrModuleCode | null | undefined, t: Translate): string {
  return t(scope ? WORKFORCE_MODULE_LABEL_KEYS[scope] : 'hr.module.allModules');
}
