/**
 * The building blocks both reference documents share: the document's own
 * header (kicker, headline, lead), its table of contents, and a part's
 * heading (mark, h2, lead). The text they carry is document content, marked
 * as Turkish; only the contents' landmark name is chrome, passed in localized.
 */
import React from 'react';

import { DOCUMENT_LANGUAGE } from './content/language';
import { DOC_HEADING, DOC_INTRO, DOC_MARK } from './docStyles';

export interface DocumentIntroProps {
  kicker: string;
  headline: string;
  intro: string;
}

/**
 * The document's own title block. The headline is not a heading: the page's
 * h1 is the localized title in PageHeader, and the parts are h2.
 */
export const DocumentIntro: React.FC<DocumentIntroProps> = ({ kicker, headline, intro }) => (
  <div lang={DOCUMENT_LANGUAGE} className="flex max-w-[860px] flex-col gap-2.5">
    <span className="text-[13px] font-bold uppercase tracking-[0.12em] text-primary-700 dark:text-primary-300">
      {kicker}
    </span>
    <p className="m-0 font-display text-[length:clamp(2.25rem,6vw,3.25rem)] font-semibold leading-none text-gray-900 dark:text-gray-100">
      {headline}
    </p>
    <p className="m-0 text-[17px] leading-[1.55] text-pretty text-gray-700 dark:text-gray-300">
      {intro}
    </p>
  </div>
);

export interface TocEntry {
  /** DOM id of the part the entry links to */
  id: string;
  mark: string;
  title: string;
  /** Number of items in the part (the review counts its findings) */
  count?: number;
}

export const DocumentToc: React.FC<{ label: string; entries: readonly TocEntry[] }> = ({
  label,
  entries,
}) => (
  <nav
    aria-label={label}
    className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] border-l border-t border-gray-200 dark:border-gray-700"
  >
    {entries.map((entry) => (
      <a
        key={entry.id}
        href={`#${entry.id}`}
        lang={DOCUMENT_LANGUAGE}
        className="flex min-h-12 items-baseline gap-2.5 border-b border-r border-gray-200 px-4 py-2.5 text-gray-900 hover:bg-primary-100 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-primary-900/40"
      >
        <span className="min-w-[22px] font-display font-semibold text-primary-700 dark:text-primary-300">
          {entry.mark}
        </span>
        <span className="font-medium">{entry.title}</span>
        {entry.count === undefined ? null : (
          <span className="ml-auto text-[13px] text-gray-600 dark:text-gray-400">
            {entry.count}
          </span>
        )}
      </a>
    ))}
  </nav>
);

export interface PartHeadingProps {
  /** Id of the h2, for the part's aria-labelledby */
  id: string;
  /** The part's number or letter; omitted for an unnumbered part */
  mark?: string;
  title: string;
  intro?: string;
}

export const PartHeading: React.FC<PartHeadingProps> = ({ id, mark, title, intro }) => (
  <div lang={DOCUMENT_LANGUAGE} className="flex max-w-[900px] flex-col gap-1.5">
    <div className="flex flex-wrap items-baseline gap-3.5">
      {mark === undefined ? null : <span className={DOC_MARK}>{mark}</span>}
      <h2 id={id} className={DOC_HEADING}>
        {title}
      </h2>
    </div>
    {intro ? <p className={DOC_INTRO}>{intro}</p> : null}
  </div>
);
