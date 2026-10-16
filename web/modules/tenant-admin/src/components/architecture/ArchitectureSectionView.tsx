/**
 * One section of the Platform architecture document: heading and lead, the
 * diagram, the numbered notes, and — where the section has them — its rules,
 * its report tables (§08) and the flow table of the closing section (§14).
 */
import React from 'react';
import { useI18n, type DataTableColumn } from '@aquaculture/shared-ui';

import { architectureAnchorId } from './anchors';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import { DOCUMENT_LANGUAGE } from './content/language';
import { ARCHITECTURE_DOCUMENT } from './content/platform/document';
import { PartHeading } from './DocumentParts';
import { DocumentTable, TableCard, documentCell } from './DocumentTable';
import { NumberedNotes, RuleList } from './SectionNotes';
import type { ArchitectureSection, SectionFlowRow, SectionTable } from './types';

/**
 * A content table: its own column headers, the first column bold. The headers
 * are document content, not chrome, so they are marked Turkish like the cells
 * (`header` stays the column's plain name).
 */
const ReportTable: React.FC<{ table: SectionTable }> = ({ table }) => {
  const columns: DataTableColumn<readonly string[]>[] = table.cols.map((header, index) => ({
    key: String(index),
    header,
    headerRender: <span lang={DOCUMENT_LANGUAGE}>{header}</span>,
    render: (_value, row) => documentCell(row[index], index === 0),
  }));
  return (
    <TableCard title={table.title} sub={table.sub}>
      <DocumentTable
        rows={table.rows}
        columns={columns}
        rowKey={(row, index) => `${row[0]}-${index}`}
      />
    </TableCard>
  );
};

const SectionFlowTable: React.FC<{ flows: readonly SectionFlowRow[] }> = ({ flows }) => {
  const { t } = useI18n();
  const columns: DataTableColumn<SectionFlowRow>[] = [
    {
      key: '0',
      header: t('architecture.flows.source'),
      render: (_value, row) => documentCell(row[0], true),
    },
    {
      key: 'arrow',
      header: '',
      width: '28px',
      render: () => (
        <span aria-hidden="true" className="font-bold text-primary-700 dark:text-primary-300">
          →
        </span>
      ),
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
  ];
  return (
    <TableCard title={ARCHITECTURE_DOCUMENT.flowsTitle} sub={ARCHITECTURE_DOCUMENT.flowsSub}>
      <DocumentTable
        rows={flows}
        columns={columns}
        rowKey={(row, index) => `${row[0]}-${row[1]}-${index}`}
      />
    </TableCard>
  );
};

export const ArchitectureSectionView: React.FC<{ section: ArchitectureSection }> = ({
  section,
}) => {
  const id = architectureAnchorId(section.num);
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="flex scroll-mt-24 flex-col gap-[18px]"
    >
      <PartHeading
        id={`${id}-title`}
        mark={section.num}
        title={section.title}
        intro={section.intro}
      />
      <ArchitectureDiagram section={section} />
      <NumberedNotes notes={section.notes} />
      {section.rules ? <RuleList rules={section.rules} /> : null}
      {section.tables ? (
        <div className="flex flex-col gap-6">
          {section.tables.map((table) => (
            <ReportTable key={table.title} table={table} />
          ))}
        </div>
      ) : null}
      {section.flows ? <SectionFlowTable flows={section.flows} /> : null}
    </section>
  );
};
