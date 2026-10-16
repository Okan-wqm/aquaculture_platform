/**
 * Header of the selected facility node: the chain as a breadcrumb (each
 * ancestor code selects that ancestor), the kind · code kicker and the name.
 */
import { Button, useI18n } from '@aquaculture/shared-ui';
import React from 'react';

import type { FacilityNode } from './facilityTree';
import { KIND_LABEL_KEY } from './kindLabels';
import { KICKER } from './panelStyles';

export interface NodeHeaderProps {
  node: FacilityNode;
  path: readonly FacilityNode[];
  headingId: string;
  onSelect: (node: FacilityNode) => void;
}

export function NodeHeader({
  node,
  path,
  headingId,
  onSelect,
}: NodeHeaderProps): React.ReactElement {
  const { t } = useI18n();
  return (
    <header className="flex flex-col gap-1.5">
      <nav aria-label={t('facilityStructure.path')}>
        <ol className="flex flex-wrap items-center gap-1 text-sm">
          {/* An ancestor step is a ghost Button at md — the shared Button's 40px
              touch size (xs is 24px) — with the design's accent code text inside. */}
          {path.map((step, index) => (
            <li key={step.key} className="flex items-center gap-1">
              {index > 0 ? (
                <span aria-hidden="true" className="text-gray-500 dark:text-gray-400">
                  ›
                </span>
              ) : null}
              {step.key === node.key ? (
                <span
                  aria-current="location"
                  className="font-semibold text-gray-900 dark:text-gray-100"
                >
                  {step.code}
                </span>
              ) : (
                <Button variant="ghost" size="md" onClick={() => onSelect(step)}>
                  <span className="font-semibold tracking-wide text-primary-700 dark:text-primary-300">
                    {step.code}
                  </span>
                </Button>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <p className={KICKER}>
        {t(KIND_LABEL_KEY[node.kind])} · {node.code}
      </p>
      <h2
        id={headingId}
        className="text-3xl leading-tight font-semibold text-gray-900 dark:text-gray-100"
      >
        {node.name}
      </h2>
    </header>
  );
}
