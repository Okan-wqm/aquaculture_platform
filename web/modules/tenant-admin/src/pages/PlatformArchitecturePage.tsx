/**
 * PlatformArchitecturePage — /tenant/architecture
 *
 * The platform's reference document "Platform architecture v4": how places,
 * data, people, production, maintenance, finance, alarms, reporting, control,
 * stock and time connect, one section per concern, each with a diagram drawn
 * from data, numbered notes and rules, closing with how they all fit together.
 *
 * Static content with no data source (no backend owns it): the body is typed
 * Turkish content (components/architecture/content); the page title, contents
 * label, legend and column headers are localized chrome.
 *
 * SEC-007: Protected by RequireTenantAdmin + an adminOnly capability gate in
 * Module.tsx. Read-only page.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { PageHeader, useI18n } from '@aquaculture/shared-ui';

import {
  ArchitectureSectionView,
  DiagramLegend,
  DocumentIntro,
  DocumentToc,
  architectureAnchorId,
} from '../components/architecture';
import { ARCHITECTURE_DOCUMENT, ARCHITECTURE_SECTIONS } from '../components/architecture/content';

const TOC_ENTRIES = ARCHITECTURE_SECTIONS.map((section) => ({
  id: architectureAnchorId(section.num),
  mark: section.num,
  title: section.title,
}));

const PlatformArchitecturePage: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="sd-page sd-stack">
      <PageHeader
        eyebrow={<span className="sd-eyebrow">{t('nav.platform')}</span>}
        title={t('architecture.title')}
        description={t('architecture.description')}
        actions={
          <Link
            to="/tenant/architecture/review"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700 hover:text-primary-900 hover:underline dark:text-primary-300 dark:hover:text-primary-100"
          >
            {t('architecture.openReview')}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        }
      />
      <article className="flex flex-col gap-16 pb-16 text-gray-900 dark:text-gray-100">
        <header className="flex flex-col gap-5">
          <DocumentIntro
            kicker={ARCHITECTURE_DOCUMENT.kicker}
            headline={ARCHITECTURE_DOCUMENT.headline}
            intro={ARCHITECTURE_DOCUMENT.intro}
          />
          <DocumentToc label={t('architecture.toc')} entries={TOC_ENTRIES} />
          <DiagramLegend />
        </header>
        {ARCHITECTURE_SECTIONS.map((section) => (
          <ArchitectureSectionView key={section.num} section={section} />
        ))}
      </article>
    </div>
  );
};

export default PlatformArchitecturePage;
