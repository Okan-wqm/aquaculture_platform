/**
 * Alarm counts per workspace for the workspace menu — preview data
 * (ALERT-MEDIUM-010).
 *
 * WHY a preview: the menu shows each module's active alarms by priority, but
 * alert-engine has no alarm summary by module (or by priority — the
 * annunciator counts the latest alertHistory pages in the browser). Okan's
 * decision (2026-10-16): an absent backend gets a labelled preview through
 * the typed path, so these samples render only inside MockPreview, beside
 * their MOCK chip. When ALERT-MEDIUM-010 is resolved, web-preview-data-path
 * .spec.ts fails until this file is replaced by the real `byModule` counts.
 */
import { definePreviewData, type AlarmPriorityTally } from '@aquaculture/shared-ui';

import type { AlarmWorkspaceId } from './alarmWorkspaces';

const SAMPLE_COUNTS: Readonly<Record<AlarmWorkspaceId, AlarmPriorityTally>> = {
  aqua: { p1: 1, p2: 2, p3: 1 },
  gh: { p1: 0, p2: 1, p3: 0 },
  ctl: { p1: 1, p2: 0, p3: 3 },
};

export const WORKSPACE_ALARMS_PREVIEW = definePreviewData(
  {
    finding: 'ALERT-MEDIUM-010',
    reasonKey: 'console.workspaceMenu.alarmsPreviewReason',
    needs:
      'alert-engine alarmSummary query with active counts per priority and per module (byModule)',
  },
  SAMPLE_COUNTS,
);
