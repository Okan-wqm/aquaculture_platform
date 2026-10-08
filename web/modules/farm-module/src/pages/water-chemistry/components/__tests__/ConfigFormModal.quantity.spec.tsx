/**
 * ConfigFormModal — what a parameter records: declared from its declarable
 * quantities on its own write, fixed (with the unit) while a channel is bound,
 * and a refusal shown by its stable code.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../../test-utils/renderWithProviders';
import { ConfigFormModal, EMPTY_FORM } from '../ConfigFormModal';

const PARAMETER_ID = 'c0a80121-7ac0-4e1c-9a6a-5f2b3c4d5e6f';

function state(liveChannelSourceCount: number): Record<string, unknown> {
  return {
    parameterConfig: {
      id: PARAMETER_ID,
      code: 'ammonia',
      unit: 'mg/L',
      quantity: null,
      declaredQuantity: null,
      quantityFamily: 'ammonia',
      declarableQuantities: ['tan', 'nh3', 'nh4', 'nh4Ion'],
      liveChannelSourceCount,
    },
  };
}

function renderModal(): void {
  renderWithProviders(
    <ConfigFormModal
      mode="edit"
      parameterConfigId={PARAMETER_ID}
      initialData={{ ...EMPTY_FORM, code: 'ammonia', name: 'Ammonia', unit: 'mg/L' }}
      onSubmit={vi.fn()}
      onClose={vi.fn()}
      isSubmitting={false}
      error={null}
    />,
  );
}

describe('ConfigFormModal measured quantity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declares one of the declarable quantities on its own write', async () => {
    routeGraphql([
      { match: 'query ParameterQuantityState', result: state(0) },
      {
        match: 'mutation DeclareParameterQuantity',
        result: {
          declareParameterQuantity: { id: PARAMETER_ID, quantity: 'tan', declaredQuantity: 'tan' },
        },
      },
    ]);
    const user = userEvent.setup();
    renderModal();

    const select = await screen.findByLabelText('Measured quantity');
    expect(select).toBeEnabled();
    expect(screen.getByRole('option', { name: /names the ammonia family/ })).toBeInTheDocument();
    await user.selectOptions(select, 'tan');

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining('mutation DeclareParameterQuantity'),
        { input: { parameterConfigId: PARAMETER_ID, quantity: 'tan' } },
      ),
    );
  });

  it('fixes the quantity and the unit while a channel is bound', async () => {
    routeGraphql([{ match: 'query ParameterQuantityState', result: state(2) }]);
    renderModal();

    const select = await screen.findByLabelText('Measured quantity');
    expect(select).toBeDisabled();
    expect(screen.getByText(/A sensor channel is bound \(2\): unbind it/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByDisplayValue('mg/L')).toBeDisabled());
  });

  it('shows a refused declaration by its stable code', async () => {
    routeGraphql([
      { match: 'query ParameterQuantityState', result: state(0) },
      {
        match: 'mutation DeclareParameterQuantity',
        result: () => {
          throw Object.assign(new Error('bound'), {
            graphqlErrors: [{ message: 'bound', extensions: { code: 'PARAMETER_BOUND' } }],
          });
        },
      },
    ]);
    const user = userEvent.setup();
    renderModal();

    await user.selectOptions(await screen.findByLabelText('Measured quantity'), 'nh3');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A sensor channel is bound: unbind it before changing what the parameter records',
    );
  });
});
