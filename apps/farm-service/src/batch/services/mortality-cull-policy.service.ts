import { BadRequestException, Injectable } from '@nestjs/common';

type MortalityCullOperation = 'Mortality' | 'Cull';

@Injectable()
export class MortalityCullPolicyService {
  assertQuantityWithinCurrent(args: {
    readonly operation: MortalityCullOperation;
    readonly quantity: number;
    readonly currentQuantity: number;
  }): void {
    if (args.quantity <= args.currentQuantity) {
      return;
    }

    const label = args.operation === 'Mortality' ? 'Mortality sayısı' : 'Cull sayısı';
    throw new BadRequestException(
      `${label} (${args.quantity}) mevcut sayıdan (${args.currentQuantity}) fazla olamaz`,
    );
  }
}
