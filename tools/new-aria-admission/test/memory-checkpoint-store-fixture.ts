import type {
  EvidenceCheckpointRequest,
  EvidenceCheckpointResult,
} from '../src/application/evidence-checkpoint';

export class MemoryCheckpointStore {
  private readonly tips = new Map<string, EvidenceCheckpointRequest['next']>();

  compareAndSet(request: EvidenceCheckpointRequest): Promise<EvidenceCheckpointResult> {
    const scope = JSON.stringify([
      request.repository_id,
      request.workspace_id,
      request.program_id,
      request.sprint_id,
    ]);
    const current = this.tips.get(scope) ?? null;
    if (JSON.stringify(current) === JSON.stringify(request.next)) {
      return Promise.resolve('ALREADY_COMMITTED');
    }
    if (JSON.stringify(current) !== JSON.stringify(request.expected)) {
      return Promise.resolve('CONFLICT');
    }
    this.tips.set(scope, request.next);
    return Promise.resolve('COMMITTED');
  }
}
