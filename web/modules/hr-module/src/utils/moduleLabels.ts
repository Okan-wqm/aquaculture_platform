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

/** Display name of a module code; no module means the whole company. */
export function moduleLabel(moduleCode: HrModuleCode | null | undefined, t: Translate): string {
  return t(moduleCode ? WORKFORCE_MODULE_LABEL_KEYS[moduleCode] : 'hr.module.companyWide');
}

/** Name of the scope a screen is showing: the workspace's module, or every module. */
export function scopeLabel(scope: HrModuleCode | null | undefined, t: Translate): string {
  return t(scope ? WORKFORCE_MODULE_LABEL_KEYS[scope] : 'hr.module.allModules');
}
