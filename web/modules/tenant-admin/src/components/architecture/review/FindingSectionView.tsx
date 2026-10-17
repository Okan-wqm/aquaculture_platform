/**
 * The review's findings on one v3 section: each with its id as the review
 * cites it ("05.3"), its kind, its title, what is wrong and the recommended
 * fix ("Öneri").
 */
import React from 'react';
import { useI18n } from '@aquaculture/shared-ui';

import { reviewAnchorId, reviewSectionAnchor } from '../anchors';
import { DOCUMENT_LANGUAGE } from '../content/language';
import {
  DOC_BODY,
  DOC_HAIRLINE,
  DOC_ITEM_ID,
  DOC_ITEM_TITLE,
  DOC_LABEL,
  DOC_RULED_TOP,
} from '../docStyles';
import { PartHeading } from '../DocumentParts';
import type { ReviewSection } from '../types';

import { FindingTag } from './reviewTags';

export const FindingSectionView: React.FC<{ section: ReviewSection }> = ({ section }) => {
  const { t } = useI18n();
  const id = reviewAnchorId(reviewSectionAnchor(section.num));
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-24 flex-col gap-3.5">
      <PartHeading
        id={`${id}-title`}
        mark={section.num}
        title={section.title}
        intro={section.intro}
      />
      <ul className={`m-0 flex list-none flex-col p-0 ${DOC_RULED_TOP}`}>
        {section.items.map(([kind, title, text, fix], index) => {
          const findingId = `${section.num}.${index + 1}`;
          return (
            <li
              key={findingId}
              className={`grid grid-cols-1 gap-x-9 gap-y-1.5 pb-[18px] pt-4 md:grid-cols-2 ${DOC_HAIRLINE}`}
            >
              <div className="col-span-full flex flex-wrap items-center gap-2.5">
                <span className={DOC_ITEM_ID}>{findingId}</span>
                <FindingTag kind={kind} />
                <h3 lang={DOCUMENT_LANGUAGE} className={DOC_ITEM_TITLE}>
                  {title}
                </h3>
              </div>
              <p lang={DOCUMENT_LANGUAGE} className={`m-0 ${DOC_BODY}`}>
                {text}
              </p>
              <p className={`m-0 text-gray-700 dark:text-gray-300 ${DOC_BODY}`}>
                <span className={`mr-2 ${DOC_LABEL}`}>
                  {t('architectureReview.recommendation')}
                </span>
                <span lang={DOCUMENT_LANGUAGE}>{fix}</span>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
