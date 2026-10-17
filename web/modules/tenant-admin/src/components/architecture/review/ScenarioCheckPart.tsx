/**
 * S "Senaryo sağlaması" — twenty things that will happen on site and what the
 * architecture does with each today: covered, partly (a path exists, a rule
 * is missing) or not covered (no record or flow), each linked to the finding
 * that explains it. The counts are computed from the rows.
 */
import React from 'react';
import { useI18n, type DataTableColumn } from '@aquaculture/shared-ui';

import { REVIEW_SCENARIOS_ANCHOR, reviewAnchorId } from '../anchors';
import { REVIEW_DOCUMENT } from '../content/review/document';
import { DOCUMENT_LANGUAGE } from '../content/language';
import { SCENARIOS } from '../content/review/scenarios';
import { DOC_LINK } from '../docStyles';
import { PartHeading } from '../DocumentParts';
import { DocumentTable, TableCard, documentCell } from '../DocumentTable';
import { countScenarios } from '../reviewStats';
import type { ScenarioRow } from '../types';

import { SCENARIO_STATUSES } from './reviewTagLooks';
import { ScenarioStatusPill } from './reviewTags';

const SCENARIO_COUNTS = countScenarios(SCENARIOS);

export const ScenarioCheckPart: React.FC = () => {
  const { t } = useI18n();
  const id = reviewAnchorId(REVIEW_SCENARIOS_ANCHOR);
  const { scenarios } = REVIEW_DOCUMENT;
  const columns: DataTableColumn<ScenarioRow>[] = [
    {
      key: '0',
      header: t('architectureReview.scenario'),
      render: (_value, row) => documentCell(row[0], true),
    },
    {
      key: '1',
      header: t('architectureReview.scenario.today'),
      render: (_value, row) => documentCell(row[1]),
    },
    {
      key: '2',
      header: t('architectureReview.scenario.status'),
      render: (_value, row) => <ScenarioStatusPill status={row[2]} />,
    },
    {
      key: '3',
      header: t('architectureReview.scenario.finding'),
      render: (_value, row) => (
        <a
          href={`#${reviewAnchorId(row[4])}`}
          lang={DOCUMENT_LANGUAGE}
          className={`whitespace-nowrap ${DOC_LINK}`}
        >
          {row[3]}
        </a>
      ),
    },
  ];
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-24 flex-col gap-3.5">
      <PartHeading
        id={`${id}-title`}
        mark={scenarios.mark}
        title={scenarios.title}
        intro={scenarios.intro}
      />
      <ul
        aria-label={t('architectureReview.scenario.counts')}
        className="m-0 flex list-none flex-wrap gap-x-6 gap-y-2.5 p-0 text-sm text-gray-700 dark:text-gray-300"
      >
        {SCENARIO_STATUSES.map((status) => (
          <li key={status} className="inline-flex items-center gap-2">
            <ScenarioStatusPill status={status} />
            <span className="font-display text-lg font-semibold">{SCENARIO_COUNTS[status]}</span>
          </li>
        ))}
      </ul>
      <TableCard>
        <DocumentTable rows={SCENARIOS} columns={columns} rowKey={(row) => row[0]} />
      </TableCard>
    </section>
  );
};
