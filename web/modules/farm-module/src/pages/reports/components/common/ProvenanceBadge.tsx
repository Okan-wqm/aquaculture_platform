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
import { Pencil, Radio, Redo2 } from 'lucide-react';

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
        <Redo2 className="w-3.5 h-3.5" aria-hidden="true" />
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
        <Radio className="w-3.5 h-3.5" aria-hidden="true" />
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
      <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
      {meta.blocking ? 'Required — enter manually' : 'Manual entry'}
    </span>
  );
};

export default ProvenanceBadge;
