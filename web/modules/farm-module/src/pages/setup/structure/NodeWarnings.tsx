/**
 * Setup gaps of the selected node's chain, as a banner: the levels with no
 * responsible person recorded (each a chip that selects that level, so the
 * gap is one click from its record), and the node no process diagram draws.
 *
 * Only gaps the platform can actually read are raised; a read that failed or
 * is still loading is not a gap (the cards below show the error instead).
 */
import { Button, useI18n } from '@aquaculture/shared-ui';
import { AlertTriangle, Unlink } from 'lucide-react';
import React, { useId } from 'react';

import type { DepartmentNode, FacilityNode, SiteNode } from './facilityTree';
import { FRAME } from './panelStyles';

export interface NodeWarningsProps {
  missingResponsible: ReadonlyArray<SiteNode | DepartmentNode>;
  notLinked: boolean;
  onSelect: (node: FacilityNode) => void;
}

/** Row label of one kind of gap: icon + text, fixed width so chips line up. */
const GAP_LABEL = 'inline-flex items-center gap-2 min-w-56 text-sm font-semibold';
const WARN_INK = 'text-warning-800 dark:text-warning-200';

export function NodeWarnings({
  missingResponsible,
  notLinked,
  onSelect,
}: NodeWarningsProps): React.ReactElement | null {
  const { t } = useI18n();
  const noResponsibleId = useId();
  // TODO(data): the design also flags "unlinked data channels" (edge-device
  // channels bound to no node) — needs a sensor-service query of registered
  // channels without a site/department/system/equipment binding.
  if (missingResponsible.length === 0 && !notLinked) return null;
  return (
    <div
      role="group"
      aria-label={t('facilityStructure.warn.label')}
      className={`flex flex-col gap-2.5 px-6 py-4 ${FRAME}`}
    >
      {missingResponsible.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span id={noResponsibleId} className={`${GAP_LABEL} ${WARN_INK}`}>
            <AlertTriangle aria-hidden="true" className="w-4 h-4 shrink-0" />
            {t('facilityStructure.warn.noResponsible')}
          </span>
          {missingResponsible.map((node) => (
            <Button
              key={node.key}
              variant="secondary"
              size="md"
              aria-describedby={noResponsibleId}
              onClick={() => onSelect(node)}
            >
              {node.code} · {node.name}
            </Button>
          ))}
        </div>
      ) : null}
      {notLinked ? (
        <p className={`${GAP_LABEL} min-h-10 text-gray-900 dark:text-gray-100`}>
          <Unlink aria-hidden="true" className="w-4 h-4 shrink-0" />
          {t('facilityStructure.warn.notLinked')}
        </p>
      ) : null}
    </div>
  );
}
