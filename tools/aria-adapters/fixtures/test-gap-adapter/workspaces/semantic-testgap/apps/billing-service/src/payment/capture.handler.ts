// Semantic fixture known-FP trap (adjacent_spec_present): the same risky
// shape as refund.handler.ts, covered by the spec under __tests__/.
export class CaptureHandler {
  constructor(private readonly ledger: { record(kind: string): boolean }) {}

  createCapture() {
    return this.ledger.record('capture');
  }
}
