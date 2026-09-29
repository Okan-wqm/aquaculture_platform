import type { NegativeControlReasonCode } from '../kernel/negative-control-registry';

export class VerificationRejection extends TypeError {
  readonly reason_code: NegativeControlReasonCode;

  constructor(reasonCode: NegativeControlReasonCode, message: string) {
    super(message);
    this.name = 'VerificationRejection';
    this.reason_code = reasonCode;
  }
}

export function rejectVerification(reasonCode: NegativeControlReasonCode, message: string): never {
  throw new VerificationRejection(reasonCode, message);
}
