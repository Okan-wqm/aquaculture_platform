/**
 * Ö "Önerilen yeni bölümler ve eklenecek akışlar" — the three sections the
 * review proposed (all now part of v4 as §11–§13), each with its parts, and
 * the flows it proposed adding to the "which section gives which what" table.
 */
import React from 'react';
import { useI18n, type DataTableColumn } from '@aquaculture/shared-ui';

import { REVIEW_PROPOSALS_ANCHOR, reviewAnchorId } from '../anchors';
import { REVIEW_DOCUMENT } from '../content/review/document';
import { DOCUMENT_LANGUAGE } from '../content/language';
import { PROPOSED_FLOWS, PROPOSED_SECTIONS } from '../content/review/proposals';
import { DOC_BODY, DOC_FRAME, DOC_MARK, DOC_PILL } from '../docStyles';
import { PartHeading } from '../DocumentParts';
import { DocumentTable, TableCard, documentCell } from '../DocumentTable';
import type { ProposedFlowRow } from '../types';

const ProposedFlowTable: React.FC = () => {
  const { t } = useI18n();
  const columns: DataTableColumn<ProposedFlowRow>[] = [
    {
      key: '0',
      header: t('architecture.flows.source'),
      render: (_value, row) => documentCell(row[0], true),
    },
    {
      key: '1',
      header: t('architecture.flows.target'),
      render: (_value, row) => documentCell(row[1], true),
    },
    {
      key: '2',
      header: t('architecture.flows.what'),
      render: (_value, row) => documentCell(row[2]),
    },
    {
      key: '3',
      header: t('architectureReview.flows.why'),
      render: (_value, row) => documentCell(row[3]),
    },
  ];
  return (
    <TableCard>
      <DocumentTable
        rows={PROPOSED_FLOWS}
        columns={columns}
        rowKey={(row, index) => `${row[0]}-${row[1]}-${index}`}
      />
    </TableCard>
  );
};

export const ProposalsPart: React.FC = () => {
  const id = reviewAnchorId(REVIEW_PROPOSALS_ANCHOR);
  const { proposals } = REVIEW_DOCUMENT;
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-24 flex-col gap-3.5">
      <PartHeading
        id={`${id}-title`}
        mark={proposals.mark}
        title={proposals.title}
        intro={proposals.intro}
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-4">
        {PROPOSED_SECTIONS.map((proposal) => (
          <div
            key={proposal.num}
            lang={DOCUMENT_LANGUAGE}
            className={`${DOC_FRAME} flex flex-col gap-2 px-5 py-[18px]`}
          >
            <span className={DOC_MARK}>{proposal.num}</span>
            <h3 className="m-0 font-display text-2xl font-semibold leading-[1.05] text-gray-900 dark:text-gray-100">
              {proposal.title}
            </h3>
            <p className={`m-0 ${DOC_BODY}`}>{proposal.text}</p>
            <ul className="m-0 mt-auto flex list-none flex-wrap gap-1 p-0">
              {proposal.parts.map((part) => (
                <li key={part} className={DOC_PILL}>
                  {part}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <ProposedFlowTable />
    </section>
  );
};
