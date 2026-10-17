/**
 * The hazard glyph of a flagged finance figure, with its meaning in words for
 * readers who cannot see the shape or the ink. Renders nothing when the
 * figure is within plan.
 */
import { useI18n } from '@aquaculture/shared-ui';
import React from 'react';

import { SEVERITY_LABEL_KEY, type Severity } from '../model/severity';

import { SEVERITY_GLYPH } from './severityStyles';

export function SeverityMark({ severity }: { severity: Severity }): React.ReactElement | null {
  const { t } = useI18n();
  if (severity === 'ok') return null;
  return (
    <>
      <span aria-hidden="true" className={SEVERITY_GLYPH[severity]} />
      <span className="sr-only">{t(SEVERITY_LABEL_KEY[severity])}</span>
    </>
  );
}
