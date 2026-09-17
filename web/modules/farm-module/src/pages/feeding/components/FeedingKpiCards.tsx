/**
 * FeedingKpiCards — hub header KPI row (SUDERRA stat-card pattern).
 *
 * DATA SOURCES (all real — no mocked data):
 * - Total Biomass / fish count: useBatchList (ACTIVE/GROWING/PRE_HARVEST).
 * - Today's Feed / Feed Stock / Alerts: useProtocolFeedForecast v2 snapshot
 *   (30-day horizon, site-scoped — see FeedingPage). On forecast failure the
 *   cards show an honest '—' + 'Forecast unavailable'; no zeros are invented
 *   (FARM-MEDIUM-233).
 */
import React from 'react';

export interface FeedingKpiCardsProps {
  /** Total biomass in kg (real batch data). */
  totalBiomassKg: number;
  totalFishCount: number;
  /** Today's planned feed in kg (forecast snapshot, day 0). */
  todaysFeedKg: number | null;
  /** Total current feed stock in kg (forecast snapshot). */
  feedStockKg: number | null;
  /** Distinct feed types in the snapshot. */
  feedTypeCount: number | null;
  /** Active forecast alerts. */
  alertCount: number | null;
}

const sdStatCard = 'sd-card sd-card--dash sd-stat-card';

const Card: React.FC<{
  title: string;
  value: string;
  unit?: string;
  change: string;
  dot: string;
  danger?: boolean;
  icon: React.ReactNode;
}> = ({ title, value, unit, change, dot, danger, icon }) => (
  <div className={`${sdStatCard}${danger ? ' sd-stat-card--danger' : ''}`}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
      <span className="sd-stat-title">{title}</span>
      {icon}
    </div>
    <div>
      <span className="sd-stat-value">{value}</span>{' '}
      {unit && <span className="sd-stat-unit">{unit}</span>}
    </div>
    <div className="sd-stat-change">
      <span className={`sd-dot ${dot}`} />
      {change}
    </div>
  </div>
);

export const FeedingKpiCards: React.FC<FeedingKpiCardsProps> = ({
  totalBiomassKg,
  totalFishCount,
  todaysFeedKg,
  feedStockKg,
  feedTypeCount,
  alertCount,
}) => {
  const forecastFailed = todaysFeedKg === null || feedStockKg === null;
  const biomassTonnes = (totalBiomassKg / 1000).toFixed(1);
  const feedPct =
    totalBiomassKg > 0 && todaysFeedKg !== null
      ? `${((todaysFeedKg / totalBiomassKg) * 100).toFixed(2)}% of biomass`
      : '—';
  const alerts = alertCount ?? 0;

  return (
    <div className="sd-stat-grid">
      <Card
        title="Total Biomass"
        value={biomassTonnes}
        unit="t"
        change={`${totalFishCount.toLocaleString()} fish`}
        dot="sd-dot--cyan"
        icon={
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#0b4f60" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
          </svg>
        }
      />
      <Card
        title="Today's Feed"
        value={todaysFeedKg === null ? '—' : todaysFeedKg.toFixed(0)}
        unit={todaysFeedKg === null ? undefined : 'kg'}
        change={todaysFeedKg === null ? 'Forecast unavailable' : feedPct}
        dot={todaysFeedKg === null ? 'sd-dot--faint' : 'sd-dot--mint'}
        icon={
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#166f5a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        }
      />
      <Card
        title="Feed Stock"
        value={feedStockKg === null ? '—' : (feedStockKg / 1000).toFixed(1)}
        unit={feedStockKg === null ? undefined : 't'}
        change={feedTypeCount === null ? 'Forecast unavailable' : `${feedTypeCount} feed types`}
        dot={feedTypeCount === null ? 'sd-dot--faint' : 'sd-dot--cyan'}
        icon={
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#6d5ac8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
        }
      />
      <Card
        title="Alerts"
        value={alertCount === null ? '—' : String(alerts)}
        change={
          alertCount === null
            ? 'Forecast unavailable'
            : alerts === 0
              ? 'All good'
              : 'Action required'
        }
        dot={alertCount === null ? 'sd-dot--faint' : alerts > 0 ? 'sd-dot--red' : 'sd-dot--mint'}
        danger={alerts > 0}
        icon={
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke={alerts > 0 ? '#b04a28' : '#5c7783'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        }
      />
    </div>
  );
};

export default FeedingKpiCards;
