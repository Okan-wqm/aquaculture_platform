/**
 * ArchitectureReviewPage — /tenant/architecture/review
 *
 * The end-to-end logic review of the platform architecture: each v3 section
 * read on its own and against the others, every finding classed as a
 * contradiction, a gap, a missing rule or an edge case with a recommended
 * fix; then the cross-cutting topics, the proposed new sections and flows,
 * and a twenty-scenario check. Section numbers follow v3 (its proposed
 * §11–§13 are now part of the v4 architecture at /tenant/architecture).
 *
 * Static content with no data source: the body is typed Turkish content
 * (components/architecture/content) and every count is computed from it; the
 * page title, kind names, column headers and labels are localized chrome.
 *
 * SEC-007: Protected by RequireTenantAdmin + an adminOnly capability gate in
 * Module.tsx. Read-only page.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PageHeader, useI18n } from '@aquaculture/shared-ui';

import {
  CrossTopicsPart,
  DocumentIntro,
  DocumentToc,
  FindingSectionView,
  FindingTagLegend,
  PrioritiesPart,
  ProposalsPart,
  REVIEW_CROSS_ANCHOR,
  REVIEW_PROPOSALS_ANCHOR,
  REVIEW_SCENARIOS_ANCHOR,
  ReviewStats,
  ScenarioCheckPart,
  reviewAnchorId,
  reviewSectionAnchor,
  type TocEntry,
} from '../components/architecture';
import {
  CROSS_TOPICS,
  PROPOSED_FLOWS,
  PROPOSED_SECTIONS,
  REVIEW_DOCUMENT,
  REVIEW_SECTIONS,
  SCENARIOS,
} from '../components/architecture/content';
import { countFindings } from '../components/architecture/reviewStats';

const FINDING_COUNTS = countFindings(REVIEW_SECTIONS);

const TOC_ENTRIES: readonly TocEntry[] = [
  ...REVIEW_SECTIONS.map((section) => ({
    id: reviewAnchorId(reviewSectionAnchor(section.num)),
    mark: section.num,
    title: section.title,
    count: section.items.length,
  })),
  {
    id: reviewAnchorId(REVIEW_CROSS_ANCHOR),
    mark: REVIEW_DOCUMENT.cross.mark,
    title: REVIEW_DOCUMENT.cross.toc,
    count: CROSS_TOPICS.length,
  },
  {
    id: reviewAnchorId(REVIEW_PROPOSALS_ANCHOR),
    mark: REVIEW_DOCUMENT.proposals.mark,
    title: REVIEW_DOCUMENT.proposals.toc,
    count: PROPOSED_SECTIONS.length + PROPOSED_FLOWS.length,
  },
  {
    id: reviewAnchorId(REVIEW_SCENARIOS_ANCHOR),
    mark: REVIEW_DOCUMENT.scenarios.mark,
    title: REVIEW_DOCUMENT.scenarios.toc,
    count: SCENARIOS.length,
  },
];

const ArchitectureReviewPage: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="sd-page sd-stack">
      <PageHeader
        eyebrow={<span className="sd-eyebrow">{t('nav.platform')}</span>}
        title={t('architectureReview.title')}
        description={t('architectureReview.description')}
        actions={
          <Link
            to="/tenant/architecture"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700 hover:text-primary-900 hover:underline dark:text-primary-300 dark:hover:text-primary-100"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t('architectureReview.openArchitecture')}
          </Link>
        }
      />
      <article className="flex flex-col gap-16 pb-16 text-gray-900 dark:text-gray-100">
        <header className="flex flex-col gap-5">
          <DocumentIntro
            kicker={REVIEW_DOCUMENT.kicker}
            headline={REVIEW_DOCUMENT.headline}
            intro={REVIEW_DOCUMENT.intro}
          />
          <ReviewStats counts={FINDING_COUNTS} />
          <DocumentToc label={t('architecture.toc')} entries={TOC_ENTRIES} />
          <FindingTagLegend />
        </header>
        <PrioritiesPart />
        {REVIEW_SECTIONS.map((section) => (
          <FindingSectionView key={section.num} section={section} />
        ))}
        <CrossTopicsPart />
        <ProposalsPart />
        <ScenarioCheckPart />
      </article>
    </div>
  );
};

export default ArchitectureReviewPage;
