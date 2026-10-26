// Semantic fixture known-FP trap (query_handler_read): a @QueryHandler that
// builds its read with createQueryBuilder(). The old write-boundary text rule
// read that call as a write; the handler only reads, whatever its calls are
// named, and it has no test on purpose.
import { QueryHandler } from '@nestjs/cqrs';

@QueryHandler(GetRefundQuery)
export class GetRefundHandler {
  constructor(
    private readonly refunds: { createQueryBuilder(alias: string): { getOne(): unknown } },
  ) {}

  execute() {
    return this.refunds.createQueryBuilder('refund').getOne();
  }
}
