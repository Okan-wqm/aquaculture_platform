/**
 * The problems of a source as chips — each in words, each with its fix when
 * the view can open it (`onFix`). Read-only views pass no `onFix`.
 */
import React from 'react';

import { useI18n } from '../../i18n';

import { PROBLEM_FIX, problemText, type ProblemFix, type SourceProblemCode } from './problems';

export interface ProblemChipsProps {
  problems: readonly SourceProblemCode[];
  /** Opens the place a problem is fixed; omitted, the chips are text only. */
  onFix?: (code: SourceProblemCode, fix: ProblemFix) => void;
  className?: string;
}

const CHIP =
  'inline-flex items-center rounded-full border border-warning-200 dark:border-warning-800 ' +
  'bg-warning-50 dark:bg-warning-900/30 px-2 py-0.5 text-[11px] leading-4 ' +
  'text-warning-800 dark:text-warning-200';

export const ProblemChips: React.FC<ProblemChipsProps> = ({ problems, onFix, className = '' }) => {
  const { t } = useI18n();
  if (problems.length === 0) return null;
  const unique = [...new Set(problems)];
  return (
    <ul className={`flex flex-wrap gap-1 ${className}`} aria-label={t('wqSource.tile.problems')}>
      {unique.map((code) => {
        const text = problemText(t, code);
        const fix = PROBLEM_FIX[code];
        return (
          <li key={code} data-problem={code}>
            {onFix === undefined ? (
              <span className={CHIP}>{text}</span>
            ) : (
              <button
                type="button"
                className={`${CHIP} hover:bg-warning-100 dark:hover:bg-warning-900/50`}
                title={t(`wqSource.fix.${fix}`)}
                aria-label={t('wqSource.fixProblem', { problem: text })}
                onClick={(event) => {
                  event.stopPropagation();
                  onFix(code, fix);
                }}
              >
                {text}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
};
