/**
 * Process-editor DraggableEdge — thin wrapper around the lib edge with
 * the zustand processStore injected as the persistence override. See
 * `OrthogonalEdge.tsx` in this dir for the same pattern and the
 * AUDIT-HIGH-006 context.
 */
import {
  DraggableEdge as LibDraggableEdge,
  type DraggableEdgeData,
  type DraggableEdgeProps,
} from '@aquaculture/node-components/edges';
import { useProcessStore } from '../../../store/processStore';

export type { DraggableEdgeData };

export default function DraggableEdge(props: DraggableEdgeProps) {
  const updateEdgeData = useProcessStore((state) => state.updateEdgeData);
  return <LibDraggableEdge {...props} updateEdgeData={updateEdgeData} />;
}
