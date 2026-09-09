/**
 * The wire shape of the payment aggregate (`GET /billing/payments/stats`).
 *
 * This response was typed by an INTERFACE, and the `@nestjs/swagger` plugin
 * describes classes only — so the generated contract carried
 * `"schema": {"type": "object"}` for it: an endpoint the admin-panel reads its
 * money cards from, with no described shape at all. The frontend answered by
 * hand-writing its own `PaymentStats`, which is exactly the drift the contract
 * exists to prevent (CONTRACT-CRITICAL-003).
 *
 * These classes state the JSON, so the artifact describes it and the client
 * type can be derived from the contract rather than restated beside it.
 */
import { ApiProperty } from '@nestjs/swagger';

export class PaymentStatsWindowDto {
  @ApiProperty({ description: 'Every payment row in the window, whatever its status.' })
  totalPayments!: number;

  @ApiProperty({ description: 'Payments that captured.' })
  succeeded!: number;

  @ApiProperty({ description: 'Payments that attempted capture and did not get it.' })
  failed!: number;

  @ApiProperty({ description: 'Payments fully or partially refunded.' })
  refunded!: number;

  @ApiProperty({ description: 'In flight: pending plus processing.' })
  pending!: number;

  @ApiProperty({
    description:
      'succeeded + refund states over TERMINAL attempts; 0 when there were none. ' +
      'A refunded payment still captured, so it belongs in the numerator; pending ' +
      'and processing are in flight and cancelled never attempted capture, so ' +
      'neither may sit in the denominator and drag the rate down.',
  })
  successRate!: number;

  @ApiProperty({ description: 'Sum of every row amount in the window.' })
  totalAmount!: number;

  @ApiProperty({
    description:
      'Money that actually captured, over EVERY row — a partially refunded ' +
      'payment still captured in full, so it counts here. The admin-panel used ' +
      'to sum this in the browser from one page of at most 50 rows, narrowed by ' +
      'the active status filter, and label the difference "Net Revenue".',
  })
  succeededAmount!: number;

  @ApiProperty({
    description:
      'Money handed back, summed from refunded_amount — NOT the amount of rows ' +
      'whose status is refunded, because a partially refunded payment returned ' +
      'only part of itself.',
  })
  refundedAmount!: number;
}

export class PaymentStatsResponseDto extends PaymentStatsWindowDto {
  @ApiProperty({
    type: PaymentStatsWindowDto,
    description:
      'The trailing 30 days. The dashboard shows this window: an all-time rate ' +
      'on a long-lived tenant is dominated by history and stops moving when ' +
      'something breaks today.',
  })
  last30Days!: PaymentStatsWindowDto;
}
