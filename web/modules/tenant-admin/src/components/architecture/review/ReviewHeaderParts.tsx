/**
 * The review header's chrome: the finding counts by kind (computed from the
 * findings, reviewStats) and the key to the four finding kinds.
 */
import React from 'react';
import { useI18n } from '@aquaculture/shared-ui';

import type { FindingCounts } from '../reviewStats';

import { FINDING_KINDS, FINDING_TAGS } from './reviewTagLooks';
import { FindingTag } from './reviewTags';

export const ReviewStats: React.FC<{ counts: FindingCounts }> = ({ counts }) => {
  const { t } = useI18n();
  const tiles: ReadonlyArray<readonly [string, number]> = [
    [t('architectureReview.stats.total'), counts.total],
    ...FINDING_KINDS.map((kind) => [t(FINDING_TAGS[kind].label), counts[kind]] as const),
  ];
  return (
    <ul
      aria-label={t('architectureReview.stats')}
      className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] border-l border-t border-gray-200 p-0 dark:border-gray-700"
    >
      {tiles.map(([label, count]) => (
        <li
          key={label}
          className="flex flex-col gap-0.5 border-b border-r border-gray-200 px-4 py-3.5 dark:border-gray-700"
        >
          <span className="font-display text-4xl font-semibold leading-none">{count}</span>
          <span className="text-[13px] text-gray-700 dark:text-gray-300">{label}</span>
        </li>
      ))}
    </ul>
  );
};

export const FindingTagLegend: React.FC = () => {
  const { t } = useI18n();
  return (
    <ul
      aria-label={t('architectureReview.tags')}
      className="m-0 flex list-none flex-wrap items-center gap-x-7 gap-y-2.5 p-0 text-sm text-gray-700 dark:text-gray-300"
    >
      {FINDING_KINDS.map((kind) => (
        <li key={kind} className="inline-flex items-center gap-2">
          <FindingTag kind={kind} />
          {t(FINDING_TAGS[kind].description)}
        </li>
      ))}
    </ul>
  );
};
