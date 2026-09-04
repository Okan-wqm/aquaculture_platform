// Documents tab: what the adapter read, and what it could not read.
//
// WHY: a document row is a claim about a file, not the file itself. Extraction
// status says whether the bytes were readable at all, and kindGuess is a
// mechanical guess carrying a confidence — both stay on the row so a reader can
// never mistake "the adapter guessed CONTRACT at 41%" for "this is a contract".
// Version ordering is likewise mechanical: the panel names its basis and marks
// the group as requiring human review rather than asserting which copy is signed.
// WHAT: a filterable document table, a detail panel for the selected row (its
// identifiers, mentioned dates and amounts, excerpt and links), and the version
// groups the adapter inferred.
import { useState, type ReactNode } from 'react';
import { EXTRACTION_STATUSES, LEGAL_RECORD_KINDS, type LegalDocument, type LegalDocumentVersion } from '../../../../shared/legal-contract.ts';
import { getLegalDocument, getLegalDocuments } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { EmptyState } from '../../design/EmptyState.tsx';
import { Icon } from '../../design/Icon.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { MonoPanel } from '../../design/MonoPanel.tsx';
import { SectionHeading } from '../../design/SectionHeading.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { Toolbar } from '../../design/Toolbar.tsx';
import { formatBytes, formatNumber, formatPercent, textOrEmpty } from '../../design/format.ts';
import { useCaseContext } from './CaseDetailPage.tsx';
import { ExtractionBadge, KindGuessBadge, ReviewMarker, EvidenceRefList } from './legal-badges.tsx';

/** Sentinel for "no server-side filter"; the empty string is what an unset <select> carries. */
const ALL = '';

const COLUMNS: ReadonlyArray<ColumnDef<LegalDocument>> = [
  {
    id: 'file',
    header: 'File',
    headerTitle: 'fileName — hover a row to read its full relativePath',
    render: (row) => (
      <span title={row.relativePath}>
        <span className="mono">{row.fileName}</span>
        {row.versionGroupId !== null ? (
          <>
            {' '}
            <Badge tone="info" mono title="versionGroupId — this file is one version among several">
              v-grp {row.versionGroupId}
            </Badge>
          </>
        ) : null}
      </span>
    ),
    sortValue: (row) => row.fileName,
    filterValue: (row) => `${row.fileName} ${row.relativePath}`,
  },
  {
    id: 'kind',
    header: 'Kind guess',
    headerTitle: 'kindGuess + kindConfidence — a mechanical guess, not a classification',
    render: (row) => <KindGuessBadge kind={row.kindGuess} confidence={row.kindConfidence} />,
    sortValue: (row) => row.kindGuess,
    nowrap: true,
  },
  {
    id: 'extraction',
    header: 'Extraction',
    headerTitle: 'extraction — how the bytes of this file were made readable',
    render: (row) => <ExtractionBadge status={row.extraction} />,
    sortValue: (row) => row.extraction,
    nowrap: true,
  },
  {
    id: 'bytes',
    header: 'Size',
    headerTitle: 'bytes — size of the file on disk',
    render: (row) => formatBytes(row.bytes),
    sortValue: (row) => row.bytes,
    align: 'end',
    nowrap: true,
  },
  {
    id: 'modified',
    header: 'Modified',
    headerTitle: 'modifiedAt — the file mtime in the archive, not a legal date',
    render: (row) => <Timestamp value={row.modifiedAt} />,
    sortValue: (row) => row.modifiedAt,
    nowrap: true,
    width: '16ch',
  },
  {
    id: 'dates',
    header: 'Dates',
    headerTitle: 'datesMentioned — how many dates the adapter read out of this file',
    render: (row) => formatNumber(row.datesMentioned.length),
    sortValue: (row) => row.datesMentioned.length,
    align: 'end',
    width: '9ch',
  },
  {
    id: 'amounts',
    header: 'Amounts',
    headerTitle: 'amountsMentioned — how many monetary amounts the adapter read out of this file',
    render: (row) => formatNumber(row.amountsMentioned.length),
    sortValue: (row) => row.amountsMentioned.length,
    align: 'end',
    width: '10ch',
  },
];

function VersionGroupPanel({ group, documents }: { readonly group: LegalDocumentVersion; readonly documents: ReadonlyArray<LegalDocument> }): ReactNode {
  // WHY: members carry document ids; a reader recognises file names. The id stays
  // in the title so the mapping back to the artifact is never lost.
  const nameOf = (documentId: string): string => documents.find((entry) => entry.documentId === documentId)?.fileName ?? documentId;
  return (
    <div className="version-group">
      <div className="row">
        <span className="mono">{group.versionGroupId}</span>
        <ReviewMarker required={group.humanReviewRequired} />
      </div>
      <ol className="legal-list">
        {[...group.members]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((member) => (
            <li key={member.documentId} title={member.documentId}>
              #{member.ordinal} {nameOf(member.documentId)} · basis={member.basis}
              {member.similarityToPrevious !== null ? ` · similarity=${formatPercent(member.similarityToPrevious)}` : ''}
              {group.signedMember === member.documentId ? ' · signed candidate' : ''}
              {group.filedMember === member.documentId ? ' · filed candidate' : ''}
            </li>
          ))}
      </ol>
      <span className="version-group__note">
        signedMember: {textOrEmpty(group.signedMember)} · filedMember: {textOrEmpty(group.filedMember)} — the ordering is mechanical, and which copy was
        actually signed or filed must be confirmed by a human reviewer.
      </span>
    </div>
  );
}

function DocumentDetail({ caseId, doc }: { readonly caseId: string; readonly doc: LegalDocument }): ReactNode {
  const { state, reload } = useRequest((signal) => getLegalDocument(caseId, doc.documentId, signal), [caseId, doc.documentId]);
  return (
    <div className="stack">
      <div className="row">
        <ExtractionBadge status={doc.extraction} />
        <KindGuessBadge kind={doc.kindGuess} confidence={doc.kindConfidence} />
      </div>
      <KeyValueList
        data={{
          documentId: doc.documentId,
          relativePath: doc.relativePath,
          mediaType: doc.mediaType,
          extension: doc.extension,
          bytes: formatBytes(doc.bytes),
          sha256: doc.sha256,
          modifiedAt: doc.modifiedAt,
          versionGroupId: doc.versionGroupId,
          excludedReason: doc.excludedReason,
        }}
        emptyMessage="This document record carries no fields."
      />
      <div className="stack stack--tight">
        <SectionHeading level={3} title={`Dates mentioned (${formatNumber(doc.datesMentioned.length)})`} plain />
        {doc.datesMentioned.length === 0 ? (
          <EmptyState message="Dates the adapter read out of this file would be listed here; it found none." flush />
        ) : (
          <ul className="chip-list">
            {doc.datesMentioned.map((value, index) => (
              <li key={`${value}-${index}`} className="chip">
                {value}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="stack stack--tight">
        <SectionHeading level={3} title={`Amounts mentioned (${formatNumber(doc.amountsMentioned.length)})`} plain />
        {doc.amountsMentioned.length === 0 ? (
          <EmptyState message="Monetary amounts the adapter read out of this file would be listed here; it found none." flush />
        ) : (
          <ul className="chip-list">
            {doc.amountsMentioned.map((value, index) => (
              <li key={`${value}-${index}`} className="chip">
                {value}
              </li>
            ))}
          </ul>
        )}
      </div>
      {doc.excerpt === null ? (
        <div className="stack stack--tight">
          <SectionHeading level={3} title="Excerpt" plain />
          <EmptyState message={`An excerpt is stored only when text was extracted; this file's extraction status is ${doc.extraction}.`} flush />
        </div>
      ) : (
        <MonoPanel label="Excerpt" text={doc.excerpt} maxHeight="sm" />
      )}
      <AsyncState state={state} onRetry={reload} skeleton="text" skeletonRows={3} errorTitle="Could not load this document's links">
        {(data) => (
          <div className="stack stack--tight">
            <SectionHeading level={3} title={`Links (${formatNumber(data.links.length)})`} plain />
            {data.links.length === 0 ? (
              <EmptyState message="A link appears here when the adapter connects this document to another record; none point at this file." flush />
            ) : (
              <ul className="legal-list">
                {data.links.map((link) => (
                  <li key={link.linkId}>
                    <Badge tone="neutral" mono title="Link kind, from the closed link vocabulary">
                      {link.kind}
                    </Badge>{' '}
                    {link.from.kind}:{link.from.id} → {link.to.kind}:{link.to.id} · confidence {formatPercent(link.confidence)}{' '}
                    <EvidenceRefList refs={link.evidence} max={2} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </AsyncState>
    </div>
  );
}

export function DocumentsTab(): ReactNode {
  const { caseId } = useCaseContext();
  const [extraction, setExtraction] = useState(ALL);
  const [kind, setKind] = useState(ALL);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { state, reload } = useRequest(
    (signal) => getLegalDocuments(caseId, { extraction: extraction === ALL ? undefined : extraction, kind: kind === ALL ? undefined : kind, limit: 1000 }, signal),
    [caseId, extraction, kind],
  );
  const filtered = extraction !== ALL || kind !== ALL;

  return (
    <div className="stack">
      <Toolbar align="end">
        <label className="field" htmlFor="documents-extraction">
          <span>Extraction</span>
          <select id="documents-extraction" value={extraction} onChange={(event) => setExtraction(event.target.value)}>
            <option value={ALL}>All</option>
            {EXTRACTION_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="documents-kind">
          <span>Kind guess</span>
          <select id="documents-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value={ALL}>All</option>
            {LEGAL_RECORD_KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
            <option value="UNKNOWN">UNKNOWN</option>
          </select>
        </label>
        <button type="button" className="button" onClick={reload}>
          <Icon name="refresh" />
          Refresh
        </button>
      </Toolbar>
      <AsyncState state={state} onRetry={reload} skeleton="table" errorTitle="Could not load the documents of this case">
        {(data) => {
          const selected = data.documents.find((entry) => entry.documentId === selectedId) ?? null;
          return (
            <div className="stack">
              <div className="split">
                <Card title="Documents" subtitle={`${formatNumber(data.total)} recorded in documents.json`} flush>
                  <DataTable
                    columns={COLUMNS}
                    rows={data.documents}
                    rowKey={(row) => row.documentId}
                    caption="Documents in this case"
                    countNoun="documents"
                    emptyTitle={filtered ? 'No documents match these filters' : 'No documents yet'}
                    emptyMessage={
                      filtered
                        ? 'Every file the adapter recorded a fate for appears here; none carries the extraction status and kind guess selected above.'
                        : 'A document appears here once the legal adapter sweeps the archive; this case recorded no files.'
                    }
                    filter={{
                      placeholder: 'Search file name, path or kind guess…',
                      predicate: (row, query) => `${row.fileName} ${row.relativePath} ${row.kindGuess}`.toLowerCase().includes(query),
                    }}
                    filterRow
                    initialSort={{ columnId: 'file', direction: 'asc' }}
                    onRowActivate={(row) => setSelectedId(row.documentId)}
                    selectedKey={selected?.documentId}
                    rowClassName={(row) => (row.extraction === 'unreadable' ? 'row-danger' : row.extraction === 'excluded' ? 'row-muted' : undefined)}
                    maxHeight="60vh"
                  />
                </Card>
                <div className="detail-panel">
                  <Card title="Document detail" subtitle={selected === null ? undefined : selected.fileName}>
                    {selected === null ? (
                      <EmptyState
                        title="No document selected"
                        message="Select a row in the table to read that file's identifiers, mentioned dates and amounts, excerpt and links."
                        flush
                      />
                    ) : (
                      <DocumentDetail caseId={caseId} doc={selected} />
                    )}
                  </Card>
                </div>
              </div>
              <Card
                title="Version groups"
                subtitle="Copies of one document; the ordering is mechanical, and the signed or filed copy needs human review"
              >
                {data.versionGroups.length === 0 ? (
                  <EmptyState
                    title="No version groups"
                    message="A version group appears when the adapter reads two files as versions of the same document; it linked none in this archive."
                    flush
                  />
                ) : (
                  <div className="grid-2">
                    {data.versionGroups.map((group) => (
                      <VersionGroupPanel key={group.versionGroupId} group={group} documents={data.documents} />
                    ))}
                  </div>
                )}
              </Card>
            </div>
          );
        }}
      </AsyncState>
    </div>
  );
}
