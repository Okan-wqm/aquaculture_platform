/**
 * A finding's kind and a scenario's coverage as pills, localized; their looks
 * and message keys are in reviewTagLooks.
 */
import React from 'react';
import { useI18n } from '@aquaculture/shared-ui';

import type { FindingKind, ScenarioStatus } from '../types';

import { FINDING_TAGS, SCENARIO_LOOKS } from './reviewTagLooks';

export const FindingTag: React.FC<{ kind: FindingKind }> = ({ kind }) => {
  const { t } = useI18n();
  return <span className={FINDING_TAGS[kind].className}>{t(FINDING_TAGS[kind].label)}</span>;
};

export const ScenarioStatusPill: React.FC<{ status: ScenarioStatus }> = ({ status }) => {
  const { t } = useI18n();
  return (
    <span className={SCENARIO_LOOKS[status].className}>{t(SCENARIO_LOOKS[status].label)}</span>
  );
};
