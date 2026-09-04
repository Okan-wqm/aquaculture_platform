import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LegalCaseSummary } from '../../../../shared/legal-contract.ts';
import { getLegalCases } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState, EmptyBlock } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { formatNumber } from '../../design/format.ts';
import './legal.css';

function CaseCard({ summary }: { readonly summary: LegalCaseSummary }): ReactNode {
  return (
    <Link to={ROUTES.legalCase(summary.caseId)} className="case-card">
      <div>
        <div className="case-card__title">{summary.title}</div>
        <div className="case-card__id">{summary.caseId}</div>
      </div>
      <div className="row">
        {summary.unreadable > 0 ? <Badge tone="danger">{formatNumber(summary.unreadable)} okunamayan dosya</Badge> : <Badge tone="success">tüm dosyalar okundu</Badge>}
        {summary.statementsNeedingReview > 0 ? <Badge tone="warning">{formatNumber(summary.statementsNeedingReview)} ifade insan doğrulaması bekliyor</Badge> : null}
      </div>
      <div className="case-card__stats">
        <div className="case-card__stat">
          <strong>{formatNumber(summary.documents)}</strong>
          <span>belge</span>
        </div>
        <div className="case-card__stat">
          <strong>{formatNumber(summary.statements)}</strong>
          <span>ifade</span>
        </div>
        <div className="case-card__stat">
          <strong>{formatNumber(summary.timelineEvents)}</strong>
          <span>zaman çizelgesi olayı</span>
        </div>
        <div className="case-card__stat">
          <strong>{formatNumber(summary.parties)}</strong>
          <span>taraf</span>
        </div>
        <div className="case-card__stat">
          <strong>
            <Timestamp value={summary.createdAt} />
          </strong>
          <span>oluşturuldu</span>
        </div>
      </div>
    </Link>
  );
}

export function CasesPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getLegalCases(signal), []);
  return (
    <>
      <PageHeader
        title="Davalar"
        subtitle="packs/legal/cases/ — hukuk adaptörünün mekanik çıktıları; hukuki sonuç içermez"
        actions={
          <button type="button" className="button" onClick={reload}>
            Yenile
          </button>
        }
      />
      <div className="stack">
        <Callout tone="neutral" title="Okuma disiplini">
          Buradaki her kayıt bir <em>beyan</em> veya mekanik bir çıkarımdır. <code>verified</code> dışındaki hiçbir durum olgu değildir;
          <code>ai_inference</code> kaynaklı satırlar kanıt sayılmaz. Tarihlerde <code>occurredAt</code> (olayın tarihi) ile <code>learnedAt</code> (öğrenildiği tarih) ayrı tutulur.
        </Callout>
        <AsyncState state={state} onRetry={reload}>
          {(data) =>
            data.cases.length === 0 ? (
              <EmptyBlock message="Henüz dava artefaktı yok. Hukuk adaptörü bir arşiv işlediğinde burada görünür." />
            ) : (
              <div className="case-grid">
                {data.cases.map((summary) => (
                  <CaseCard key={summary.caseId} summary={summary} />
                ))}
              </div>
            )
          }
        </AsyncState>
      </div>
    </>
  );
}
