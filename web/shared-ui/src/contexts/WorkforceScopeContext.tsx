/**
 * WorkforceScope — which module's people the screen on show is about.
 *
 * The console shell holds the reader's workspace (Production, Greenhouse,
 * Control & sensors, Company). The HR pages are a federated remote and cannot
 * read shell state, so the workspace's module reaches them through this
 * context: the shell provides it, the HR hooks read it, and nothing in between
 * threads a prop.
 *
 * `null` is "no scope" — the Company workspace, and any tree with no provider
 * — and means every module. The value is the schema's own `HrModuleCode`, so a
 * scope can never name a module the HR service does not know.
 */
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

import type { HrModuleCode } from '../generated/graphql-types';
import type { MessageKey } from '../i18n';

/**
 * What each module is called: the message key of the console workspace built on
 * it. The one place a module code is turned into words, so a department card, a
 * scope badge and the workspace switcher can never name a module two ways.
 * Typing the table over every `HrModuleCode` makes the compiler reject a new schema module
 * until it has a name. HR has no workspace of its own (the HR module is the
 * company-wide view), so an HR-owned department is named by its module.
 */
export const WORKFORCE_MODULE_LABEL_KEYS: Record<HrModuleCode, MessageKey> = {
  FARM: 'nav.workspace.aqua',
  HYDROPONICS: 'nav.workspace.gh',
  SENSOR: 'nav.workspace.ctl',
  HR: 'hr.module.hr',
};

const WorkforceScopeContext = createContext<HrModuleCode | null>(null);

export interface WorkforceScopeProviderProps {
  /** The module the workspace is built on; null for a workspace that spans modules. */
  readonly moduleCode: HrModuleCode | null;
  readonly children: ReactNode;
}

export function WorkforceScopeProvider({
  moduleCode,
  children,
}: WorkforceScopeProviderProps): ReactElement {
  return (
    <WorkforceScopeContext.Provider value={moduleCode}>{children}</WorkforceScopeContext.Provider>
  );
}

/** The module the current workspace scopes people to; null = all modules. */
export function useWorkforceScope(): HrModuleCode | null {
  return useContext(WorkforceScopeContext);
}
