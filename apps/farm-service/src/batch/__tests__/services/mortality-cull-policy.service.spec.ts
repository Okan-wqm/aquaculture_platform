import { BadRequestException } from '@nestjs/common';

import { MortalityCullPolicyService } from '../../services/mortality-cull-policy.service';

describe('MortalityCullPolicyService', () => {
  const policy = new MortalityCullPolicyService();

  it('allows mortality/cull quantities up to current quantity', () => {
    expect(() =>
      policy.assertQuantityWithinCurrent({
        operation: 'Mortality',
        quantity: 10,
        currentQuantity: 10,
      }),
    ).not.toThrow();
  });

  it('rejects mortality/cull quantities above current quantity', () => {
    expect(() =>
      policy.assertQuantityWithinCurrent({
        operation: 'Cull',
        quantity: 11,
        currentQuantity: 10,
      }),
    ).toThrow(BadRequestException);
  });
});
