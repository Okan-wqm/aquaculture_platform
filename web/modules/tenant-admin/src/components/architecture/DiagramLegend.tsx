/**
 * The diagrams' notation key: the six box kinds a reader meets, the four line
 * kinds and the dated-link frame. Swatches are drawn by the same BoxFrame and
 * link styles as the diagrams; the labels are localized chrome.
 */
import React from 'react';
import { useI18n, type MessageKey } from '@aquaculture/shared-ui';

import { BoxFrame } from './BoxFrame';
import { LINK_STYLE } from './diagramStyles';
import type { BoxKind, LinkKind } from './types';

const LEGEND_BOXES: ReadonlyArray<readonly [BoxKind, MessageKey]> = [
  ['place', 'architecture.legend.place'],
  ['asset', 'architecture.legend.asset'],
  ['data', 'architecture.legend.data'],
  ['org', 'architecture.legend.org'],
  ['calc', 'architecture.legend.calc'],
  ['ext', 'architecture.legend.ext'],
];

const LEGEND_LINES: ReadonlyArray<readonly [LinkKind, MessageKey]> = [
  ['solid', 'architecture.legend.linked'],
  ['data', 'architecture.legend.dataFlow'],
  ['assign', 'architecture.legend.assignment'],
  ['ctrl', 'architecture.legend.control'],
];

const ITEM = 'inline-flex items-center gap-2';

export const DiagramLegend: React.FC = () => {
  const { t } = useI18n();
  return (
    <ul
      aria-label={t('architecture.legend')}
      className="m-0 flex list-none flex-wrap items-center gap-x-7 gap-y-2.5 p-0 text-sm text-gray-700 dark:text-gray-300"
    >
      {LEGEND_BOXES.map(([kind, label]) => (
        <li key={kind} className={ITEM}>
          <svg
            width={26}
            height={18}
            viewBox="0 0 26 18"
            aria-hidden="true"
            className="overflow-visible"
          >
            <BoxFrame kind={kind} x={1} y={1} w={24} h={16} />
          </svg>
          {t(label)}
        </li>
      ))}
      {LEGEND_LINES.map(([kind, label]) => {
        const style = LINK_STYLE[kind];
        return (
          <li key={kind} className={ITEM}>
            <svg width={30} height={6} viewBox="0 0 30 6" aria-hidden="true">
              <path
                d="M0 3H30"
                fill="none"
                className={style.line}
                strokeWidth={style.strokeWidth}
                strokeDasharray={style.dash}
                strokeLinecap={style.roundCaps ? 'round' : undefined}
              />
            </svg>
            {t(label)}
          </li>
        );
      })}
      <li className={ITEM}>
        <span className="inline-flex min-h-5 items-center border border-primary-500 px-1.5 text-xs font-semibold text-primary-800 dark:text-primary-200">
          {t('architecture.legend.dated')}
        </span>
        {t('architecture.legend.datedDescription')}
      </li>
    </ul>
  );
};
