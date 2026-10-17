/**
 * "Önce bunlar" — the review's opening list: the eight items that affect more
 * than one section or produce a wrong result, each linking to the part that
 * holds its findings.
 */
import React from 'react';

import { reviewAnchorId } from '../anchors';
import { PRIORITIES } from '../content/review/priorities';
import { REVIEW_DOCUMENT } from '../content/review/document';
import { DOCUMENT_LANGUAGE } from '../content/language';
import { DOC_BODY, DOC_HAIRLINE, DOC_LINK, DOC_RULED_TOP } from '../docStyles';
import { PartHeading } from '../DocumentParts';

export const PrioritiesPart: React.FC = () => {
  const id = reviewAnchorId('top');
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="flex scroll-mt-24 flex-col gap-[18px]"
    >
      <PartHeading
        id={`${id}-title`}
        title={REVIEW_DOCUMENT.priorities.title}
        intro={REVIEW_DOCUMENT.priorities.intro}
      />
      <ol
        lang={DOCUMENT_LANGUAGE}
        className={`m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))] p-0 ${DOC_RULED_TOP}`}
      >
        {PRIORITIES.map(([title, text, refs, anchor], index) => (
          <li key={title} className={`flex gap-3.5 py-3.5 pr-[18px] ${DOC_HAIRLINE} ${DOC_BODY}`}>
            <span
              aria-hidden="true"
              className="min-w-[26px] font-display text-[22px] font-semibold leading-none text-primary-700 dark:text-primary-300"
            >
              {index + 1}
            </span>
            <span className="flex flex-col gap-1">
              <span className="font-semibold">{title}</span>
              <span className="text-gray-700 dark:text-gray-300">{text}</span>
              <a href={`#${reviewAnchorId(anchor)}`} className={`${DOC_LINK} text-[13px]`}>
                {refs}
              </a>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
};
