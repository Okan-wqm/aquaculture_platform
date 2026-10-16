/**
 * Detail panel of the selected facility node (right pane).
 *
 * WHY: one place reads the chain's responsibility and the node's linked
 * flows, because both the setup-gap chips and their cards are drawn from the
 * same reads — the chips can never disagree with the cards below them.
 *
 * WHAT: header (chain, kind · code, name) › setup gaps › subtree counts ›
 * cost share (a site's booked electricity; its tariff and the split below a
 * site as labelled previews, FARM-MEDIUM-440) › responsibility › linked flows.
 */
import React, { useId } from 'react';

import { CostShareCard } from './CostShareCard';
import type { FacilityNode } from './facilityTree';
import { FlowsCard } from './FlowsCard';
import { NodeHeader } from './NodeHeader';
import { NodeKpis } from './NodeKpis';
import { NodeWarnings } from './NodeWarnings';
import { ResponsibilityCard } from './ResponsibilityCard';
import { useChainResponsibility } from './useChainResponsibility';
import { useNodeFlows } from './useNodeFlows';

export interface NodePanelProps {
  node: FacilityNode;
  /** Root-first chain ending at `node`. */
  path: readonly FacilityNode[];
  onSelect: (node: FacilityNode) => void;
}

export function NodePanel({ node, path, onSelect }: NodePanelProps): React.ReactElement {
  const headingId = useId();
  const responsibility = useChainResponsibility(path);
  const flows = useNodeFlows(node);

  const missingResponsible = responsibility
    .filter((row) => row.status === 'ready' && row.responsible === null)
    .map((row) => row.node);
  // Only a complete diagram list proves a node is drawn nowhere: when the list
  // was capped at one page, the node may be drawn on a later page.
  const notLinked = flows.status === 'ready' && flows.flows.length === 0 && flows.capped === null;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-6">
      <NodeHeader node={node} path={path} headingId={headingId} onSelect={onSelect} />
      <NodeWarnings
        missingResponsible={missingResponsible}
        notLinked={notLinked}
        onSelect={onSelect}
      />
      <NodeKpis node={node} />
      <CostShareCard node={node} />
      <ResponsibilityCard rows={responsibility} onSelect={onSelect} />
      <FlowsCard state={flows} />
    </section>
  );
}
