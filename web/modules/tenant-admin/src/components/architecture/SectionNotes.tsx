/**
 * A section's numbered notes under its diagram, and its rules ("Kurallar").
 * The notes and rules are document content, marked as Turkish; the rules'
 * label is localized chrome in the reader's language.
 */
import React, { useId } from 'react';
import { useI18n } from '@aquaculture/shared-ui';

import { DOCUMENT_LANGUAGE } from './content/language';
import { DOC_BODY, DOC_HAIRLINE, DOC_LABEL, DOC_RULED_TOP } from './docStyles';

export const NumberedNotes: React.FC<{ notes: readonly string[] }> = ({ notes }) => (
  <ol
    lang={DOCUMENT_LANGUAGE}
    className={`m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] p-0 ${DOC_RULED_TOP}`}
  >
    {notes.map((note, index) => (
      <li key={note} className={`flex gap-3 py-3.5 pr-[18px] ${DOC_HAIRLINE} ${DOC_BODY}`}>
        {/* The list is ordered, so the visible number is for the eye only. */}
        <span
          aria-hidden="true"
          className="min-w-[22px] font-display font-semibold text-primary-700 dark:text-primary-300"
        >
          {index + 1}
        </span>
        <span>{note}</span>
      </li>
    ))}
  </ol>
);

export const RuleList: React.FC<{ rules: readonly string[] }> = ({ rules }) => {
  const { t } = useI18n();
  const labelId = useId();
  return (
    <div className="grid grid-cols-1 gap-x-6 pt-1 sm:grid-cols-[minmax(0,120px)_minmax(0,1fr)]">
      <span id={labelId} className={`${DOC_LABEL} pt-3`}>
        {t('architecture.rules')}
      </span>
      <ul
        aria-labelledby={labelId}
        lang={DOCUMENT_LANGUAGE}
        className="m-0 flex list-none flex-col p-0"
      >
        {rules.map((rule) => (
          <li key={rule} className={`flex gap-3 py-2.5 ${DOC_HAIRLINE} ${DOC_BODY}`}>
            <span
              aria-hidden="true"
              className="mt-2 size-2 shrink-0 border-[1.5px] border-primary-700 dark:border-primary-300"
            />
            <span>{rule}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
