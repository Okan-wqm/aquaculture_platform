/**
 * The discount code form's redemption caps, and a revenue leak in an `||`.
 *
 * `discount-rules.ts` enforces a cap only when it is neither null nor
 * undefined, so **undefined means unlimited**. The form built the value with
 * `parseInt(e.target.value, 10) || undefined`, which produced undefined from
 * three separate inputs an operator can supply:
 *
 *   - "abc", or any typo → NaN || undefined → unlimited
 *   - ""                 → NaN || undefined → unlimited (intended)
 *   - "0"                → 0   || undefined → UNLIMITED
 *
 * The last is the sharpest. `0` is the clearest way an operator can say "this
 * code may not be redeemed", and it created a code with no cap at all — on a
 * field whose only purpose is to stop a discount being used without limit.
 *
 * Empty still means unlimited, because that is what the field's own
 * placeholder promises. A typo now leaves the previous value alone rather than
 * silently removing the limit.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import DiscountCodePage from '../DiscountCodePage';
import { billingApi } from '../../services/adminApi';
import type { DiscountStats } from '../../services/types/billing';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    billingApi: {
      getDiscountCodes: vi.fn(),
      getDiscountStats: vi.fn(),
      createDiscountCode: vi.fn(),
      deactivateDiscountCode: vi.fn(),
      generateUniqueCode: vi.fn(),
    },
  };
});

const codes = vi.mocked(billingApi.getDiscountCodes);
const stats = vi.mocked(billingApi.getDiscountStats);

/** Complete, as the contract declares it — no cast. */
function statsFixture(): DiscountStats {
  return {
    totalCodes: 0,
    activeCodes: 0,
    expiredCodes: 0,
    totalRedemptions: 0,
    totalDiscountAmount: '0',
    topCodes: [],
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DiscountCodePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Render, open the create modal, and return the "Max Total Uses" box.
 *
 * Found through its label's own container rather than `getByLabelText`: the
 * label carries no `htmlFor`, and both cap fields share the placeholder
 * "Leave empty for unlimited", so a placeholder query would match two inputs
 * and prove nothing about either.
 */
async function openCapField(label: string): Promise<HTMLInputElement> {
  renderPage();
  const actor = userEvent.setup();
  await actor.click(await screen.findByRole('button', { name: 'Create Discount Code' }));

  const labelEl = await screen.findByText(label);
  const field = labelEl.parentElement?.querySelector('input');
  if (!field) throw new Error(`no input beside the "${label}" label`);
  return field;
}

describe('DiscountCodePage redemption caps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codes.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    stats.mockResolvedValue(statsFixture());
  });

  it('keeps a cap of 0 instead of turning it into "unlimited"', async () => {
    const field = await openCapField('Max Total Uses');
    await userEvent.setup().type(field, '0');

    // `0 || undefined` was undefined, and undefined is unlimited.
    expect(field).toHaveValue(0);
  });

  it('keeps a real cap the operator typed', async () => {
    const field = await openCapField('Max Total Uses');
    await userEvent.setup().type(field, '25');

    expect(field).toHaveValue(25);
  });

  it('names a failed code listing rather than showing an empty catalogue', async () => {
    codes.mockRejectedValue(new Error('discount codes are unreachable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('discount codes are unreachable');
  });

  it('forwards an abort signal to both reads', async () => {
    renderPage();

    await waitFor(() => expect(codes).toHaveBeenCalled());
    expect(codes.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(stats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('asks for active codes only when the Active box is ticked', async () => {
    renderPage();

    await waitFor(() => expect(codes).toHaveBeenCalled());
    // `showActive || undefined` sent no filter at all when unticked, widening
    // the list instead of narrowing it.
    expect(codes.mock.calls[0]?.[0]).toMatchObject({ isActive: true });
  });
});
