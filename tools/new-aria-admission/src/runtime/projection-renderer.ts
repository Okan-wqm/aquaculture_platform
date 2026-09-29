import { snapshotAdmittedCompletionProjection } from '../application/progress-admission';
import {
  assertCompletionProjectionCurrent,
  serializeCompletionProjectionArtifact,
} from '../kernel/completion-projection-artifact';

export function serializeAdmittedCompletionProjection(value: unknown): Buffer {
  return serializeCompletionProjectionArtifact(snapshotAdmittedCompletionProjection(value));
}

export function renderCompletionProjection(value: unknown): Buffer {
  const projection = snapshotAdmittedCompletionProjection(value);
  assertCompletionProjectionCurrent(projection, Date.now());
  return serializeCompletionProjectionArtifact(projection);
}
