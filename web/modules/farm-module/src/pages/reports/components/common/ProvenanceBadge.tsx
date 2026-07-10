/**
 * Provenance Badge — shows WHERE a prefilled report value came from.
 *
 * RECORDS: aggregated from operational journal rows (count + query shown on
 * hover). SENSOR: read from a sensor projection (sensor + timestamp shown).
 * MANUAL_REQUIRED: the platform holds no source — the operator must enter
 * it; blocking entries prevent submission until filled.
 */
import React from 'react';

import type { ReportFieldMeta } from '../../../../hooks/useReportPrefill';

interface ProvenanceBadgeProps {
  meta: ReportFieldMeta;
  size?: 'sm' | 'md';
}

const sizeConfig = {
  sm: 'px-2 py-0.5 text-xs gap-1',
  md: 'px-2.5 py-1 text-sm gap-1.5',
};

export const ProvenanceBadge: React.FC<ProvenanceBadgeProps> = ({ meta, size = 'sm' }) => {
  const sizes = sizeConfig[size];

  if (meta.provenance === 'RECORDS') {
    const count = meta.sourceRecordCount ?? 0;
    return (
      <span
        className={`inline-flex items-center ${sizes} font-medium rounded-full bg-green-100 text-green-800`}
        title={meta.sourceQuery ? `Source: ${meta.sourceQuery}` : undefined}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 17v-2a4 4 0 014-4h6m0 0l-3-3m3 3l-3 3M5 7h6"
          />
        </svg>
        From records{count > 0 ? ` (${count})` : ''}
      </span>
    );
  }

  if (meta.provenance === 'SENSOR') {
    const measured = meta.measuredAt ? new Date(meta.measuredAt).toLocaleString() : undefined;
    return (
      <span
        className={`inline-flex items-center ${sizes} font-medium rounded-full bg-blue-100 text-blue-800`}
        title={[meta.sensorId && `Sensor ${meta.sensorId}`, measured].filter(Boolean).join(' · ')}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9.348 14.652a3.75 3.75 0 010-5.304m5.304 0a3.75 3.75 0 010 5.304m-7.425 2.121a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M12 12h.008v.008H12V12z"
          />
        </svg>
        Sensor
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center ${sizes} font-medium rounded-full ${
        meta.blocking ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
      }`}
      title={meta.message ?? undefined}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
        />
      </svg>
      {meta.blocking ? 'Required — enter manually' : 'Manual entry'}
    </span>
  );
};

export default ProvenanceBadge;
