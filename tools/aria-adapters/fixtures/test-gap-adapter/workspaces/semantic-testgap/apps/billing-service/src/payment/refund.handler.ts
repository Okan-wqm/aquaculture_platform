// Semantic fixture TP: a write handler with a dependency and no test. It
// takes a collaborator on purpose — a class that only returns constants is
// not high-risk (ARIA-MEDIUM-329), and this fixture pins the risky shape. It
// is a @CommandHandler on purpose too: that, not a method name, is what makes
// it a write boundary (DET testgap-1).
import { CommandHandler } from '@nestjs/cqrs';

@CommandHandler(RefundCommand)
export class RefundHandler {
  constructor(private readonly ledger: { record(kind: string): boolean }) {}

  createRefund() {
    return this.ledger.record('refund');
  }
}
