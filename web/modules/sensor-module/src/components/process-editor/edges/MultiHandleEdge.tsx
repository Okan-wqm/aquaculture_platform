/**
 * Process-editor MultiHandleEdge — thin wrapper around the lib edge with
 * the zustand processStore injected as the persistence override. See
 * `OrthogonalEdge.tsx` in this dir for the same pattern and the
 * AUDIT-HIGH-006 context.
 */
import {
  MultiHandleEdge as LibMultiHandleEdge,
  type MultiHandleEdgeData,
  type MultiHandleEdgeProps,
} from '@aquaculture/node-components/edges';
import { useProcessStore } from '../../../store/processStore';

export type { MultiHandleEdgeData };

export default function MultiHandleEdge(props: MultiHandleEdgeProps) {
  const updateEdgeData = useProcessStore((state) => state.updateEdgeData);
  return <LibMultiHandleEdge {...props} updateEdgeData={updateEdgeData} />;
}
