/**
 * One source of a water-chemistry parameter as a tile: its value with unit and
 * age, the sample quality, what kind of source it is (primary, backup,
 * manual) and where it stands when the value is inherited, an optional trend,
 * and — when it cannot feed the parameter — why, with the way to fix it.
 *
 * Presentation only: the caller hands the facts (from parameterSourcesAtPoint
 * or a resolved reading) and the clock, so the tile renders the same in a
 * test as on a page.
 */
import React from 'react';

import { SparklineChart } from '../../components/Charts/SparklineChart';
import { QualityIndicator } from '../../components/Quality';
import type { ReadingSourceKind, SampleQuality } from '../../generated/graphql-types';
import { useI18n, type I18nContextValue } from '../../i18n';

import type { PointKind } from './pointRef';
import { ProblemChips } from './ProblemChips';
import type { ProblemFix, SourceProblemCode } from './problems';

export interface ParameterSourceTileProps {
  /** The parameter's name. */
  name: string;
  value: number | null;
  unit: string | null;
  /** Decimals shown (the parameter's precision). */
  precision: number;
  /** When the value was observed (ISO), null when there is none. */
  observedAt: string | null;
  /** The clock the age is measured to (ms). */
  now: number;
  /** Shown as stale when older than this many seconds; null: no window applies. */
  windowSeconds: number | null;
  quality: SampleQuality | null;
  kind: ReadingSourceKind | null;
  /** The point an inherited value was read at (a system or site). */
  inheritedFrom: PointKind | null;
  /** The channel or sample behind the value, e.g. "Probe 3 · ph". */
  detail: string | null;
  /** The recent trend of the value, oldest first. */
  trend: readonly number[] | null;
  color: string;
  problems: readonly SourceProblemCode[];
  onFix?: (code: SourceProblemCode, fix: ProblemFix) => void;
  /** Makes the tile a button (e.g. to expand its trend). */
  onSelect?: () => void;
  selected?: boolean;
}

const QUALITY_TAG: Readonly<Record<SampleQuality, 'good' | 'uncertain' | 'bad'>> = {
  GOOD: 'good',
  UNCERTAIN: 'uncertain',
  BAD: 'bad',
};

/** How long ago, in the current language. */
export function formatAge(t: I18nContextValue['t'], seconds: number): string {
  if (seconds < 60) return t('wqSource.age.now');
  if (seconds < 3_600) return t('wqSource.age.minutes', { n: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t('wqSource.age.hours', { n: Math.floor(seconds / 3_600) });
  return t('wqSource.age.days', { n: Math.floor(seconds / 86_400) });
}

export const ParameterSourceTile: React.FC<ParameterSourceTileProps> = ({
  name,
  value,
  unit,
  precision,
  observedAt,
  now,
  windowSeconds,
  quality,
  kind,
  inheritedFrom,
  detail,
  trend,
  color,
  problems,
  onFix,
  onSelect,
  selected = false,
}) => {
  const { t } = useI18n();
  const ageSeconds =
    observedAt === null ? null : Math.max(0, Math.floor((now - Date.parse(observedAt)) / 1000));
  const stale = ageSeconds !== null && windowSeconds !== null && ageSeconds > windowSeconds;
  const blocked = problems.length > 0;

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span
          className="truncate text-xs font-medium text-gray-700 dark:text-gray-300"
          title={name}
        >
          <span
            className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
          {name}
        </span>
        {quality !== null && (
          <QualityIndicator
            quality={QUALITY_TAG[quality]}
            label={t(`wqSource.quality.${quality}`)}
            size="xs"
            tone="soft"
          />
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        {value === null ? (
          <span className="text-sm text-gray-400 dark:text-gray-500">
            {t('wqSource.tile.noValue')}
          </span>
        ) : (
          <>
            <span
              className={`text-xl font-semibold tabular-nums ${
                blocked || stale
                  ? 'text-gray-400 dark:text-gray-500'
                  : 'text-gray-900 dark:text-gray-100'
              }`}
            >
              {value.toFixed(precision)}
            </span>
            {unit !== null && unit !== '' && (
              <span className="text-xs text-gray-500 dark:text-gray-400">{unit}</span>
            )}
          </>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-gray-500 dark:text-gray-400">
        {kind !== null && <span>{t(`wqSource.kind.${kind}`)}</span>}
        {inheritedFrom !== null && (
          <span>
            {t('wqSource.inheritedFrom', { point: t(`wqSource.point.${inheritedFrom}`) })}
          </span>
        )}
        {ageSeconds !== null && <span>{formatAge(t, ageSeconds)}</span>}
        {stale && (
          <span className="font-medium text-warning-700 dark:text-warning-300">
            {t('wqSource.tile.stale')}
          </span>
        )}
      </div>
      {detail !== null && (
        <div className="truncate text-[11px] text-gray-400 dark:text-gray-500" title={detail}>
          {detail}
        </div>
      )}
      {trend !== null && trend.length > 1 && (
        <SparklineChart
          data={[...trend]}
          width={160}
          height={28}
          color={color}
          showDot={false}
          animate={false}
          className="mt-1 w-full"
        />
      )}
      <ProblemChips problems={problems} onFix={onFix} className="mt-1.5" />
    </>
  );

  const frame = `rounded-lg border bg-white dark:bg-gray-900 p-2.5 text-left ${
    selected
      ? 'border-info-500 ring-1 ring-info-500'
      : blocked
        ? 'border-warning-300 dark:border-warning-700'
        : 'border-gray-200 dark:border-gray-700'
  }`;

  if (onSelect === undefined) {
    return (
      <div className={frame} data-testid="parameter-source-tile">
        {body}
      </div>
    );
  }
  // A div with a button role: the tile holds fix buttons, and a button element cannot.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={`${frame} cursor-pointer hover:border-info-400`}
      data-testid="parameter-source-tile"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      {body}
    </div>
  );
};
