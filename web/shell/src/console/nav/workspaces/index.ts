/**
 * The console's workspace definitions, in switcher order (FE-HIGH-335). When a
 * page is listed in more than one workspace and the current one lacks it, the
 * first workspace here that lists it owns it (workspaceForPath).
 */
import type { WorkspaceDef } from '../types';

import { AQUA_WORKSPACE } from './aqua';
import { CTL_WORKSPACE } from './ctl';
import { GH_WORKSPACE } from './gh';
import { ORG_WORKSPACE } from './org';

export const CONSOLE_WORKSPACES: readonly WorkspaceDef[] = [
  AQUA_WORKSPACE,
  GH_WORKSPACE,
  CTL_WORKSPACE,
  ORG_WORKSPACE,
];
