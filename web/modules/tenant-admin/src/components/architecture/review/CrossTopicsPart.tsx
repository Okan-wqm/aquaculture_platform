/**
 * K "Kesişen konular" — the principles under many findings that belong to no
 * single section, each with the parts it affects ("Etkiler").
 */
import React from 'react';
import { useI18n } from '@aquaculture/shared-ui';

import { REVIEW_CROSS_ANCHOR, reviewAnchorId } from '../anchors';
import { CROSS_TOPICS } from '../content/review/cross-topics';
import { REVIEW_DOCUMENT } from '../content/review/document';
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

export const CrossTopicsPart: React.FC = () => {
  const { t } = useI18n();
  const id = reviewAnchorId(REVIEW_CROSS_ANCHOR);
  const { cross } = REVIEW_DOCUMENT;
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-24 flex-col gap-3.5">
      <PartHeading id={`${id}-title`} mark={cross.mark} title={cross.title} intro={cross.intro} />
      <ul
        className={`m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))] gap-x-9 p-0 ${DOC_RULED_TOP}`}
      >
        {CROSS_TOPICS.map(([topicId, title, text, affects]) => (
          <li key={topicId} className={`flex flex-col gap-1.5 pb-[18px] pt-4 ${DOC_HAIRLINE}`}>
            <div className="flex items-baseline gap-2.5">
              <span className={DOC_ITEM_ID}>{topicId}</span>
              <h3 lang={DOCUMENT_LANGUAGE} className={DOC_ITEM_TITLE}>
                {title}
              </h3>
            </div>
            <p lang={DOCUMENT_LANGUAGE} className={`m-0 ${DOC_BODY}`}>
              {text}
            </p>
            <p className="m-0 text-sm leading-normal text-gray-700 dark:text-gray-300">
              <span className={`mr-2 ${DOC_LABEL}`}>{t('architectureReview.affects')}</span>
              <span lang={DOCUMENT_LANGUAGE}>{affects}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
};
