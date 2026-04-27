/**
 * Process-editor OrthogonalEdge — thin wrapper around the canonical
 * `libs/node-components` OrthogonalEdge that injects the process-editor's
 * zustand-backed store as the edge-data persistence mechanism.
 *
 * Historical context: before AUDIT-HIGH-006 (cold audit 2026-04-22) this
 * file held a 464-line copy-paste of the lib component with one call site
 * swapped from ReactFlow's setEdges to useProcessStore.updateEdgeData. The
 * lib now accepts `updateEdgeData` as an optional prop (see
 * `EdgeDataUpdater` in libs/node-components/src/edges/OrthogonalEdge.tsx),
 * so the entire copy collapses into this ~10-line adapter.
 *
 * @see docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-HIGH-006
 */
import {
  OrthogonalEdge as LibOrthogonalEdge,
  type OrthogonalEdgeData,
  type OrthogonalEdgeProps,
} from '@aquaculture/node-components/edges';
import { useProcessStore } from '../../../store/processStore';

export type { OrthogonalEdgeData };

export default function OrthogonalEdge(props: OrthogonalEdgeProps) {
  const updateEdgeData = useProcessStore((state) => state.updateEdgeData);
  return <LibOrthogonalEdge {...props} updateEdgeData={updateEdgeData} />;
}
