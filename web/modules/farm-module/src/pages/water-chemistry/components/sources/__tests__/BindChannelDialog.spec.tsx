/**
 * BindChannelDialog: the dry run decides — its problems keep Bind disabled; a
 * refused bind shows its stable code and problems; when the sensor service
 * cannot answer, the dialog says nothing was decided and offers a retry.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { routeGraphql } from '../../../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../../../test-utils/renderWithProviders';
import { BindChannelDialog } from '../BindChannelDialog';

import { SENSOR_ID, TANK_ID } from './sourceFixtures';

/** A refusal as the shared client throws it: the GraphQL errors kept on the error. */
function refusal(code: string, problems: string[] = []): Error {
  return Object.assign(new Error(code), {
    code,
    graphqlErrors: [{ message: code, extensions: { code, context: { problems } } }],
  });
}

const CHANNELS = [
  {
    id: 'c1',
    channelKey: 'tan',
    displayLabel: 'TAN probe',
    unit: 'mg/L',
    isEnabled: true,
    quantity: 'tan',
    quantityFamily: null,
    displayOrder: 1,
  },
  {
    id: 'c2',
    channelKey: 'ph',
    displayLabel: 'pH probe',
    unit: 'pH',
    isEnabled: true,
    quantity: 'ph',
    quantityFamily: null,
    displayOrder: 2,
  },
];

const CHECKED_CHANNEL = {
  sensorId: SENSOR_ID,
  channelKey: 'tan',
  presence: 'FOUND',
  sensorActive: true,
  enabled: true,
  quantity: 'tan',
  unit: 'mg/L',
  latestValue: 0.4,
  latestAt: '2026-10-08T09:55:00.000Z',
  latestQuality: 'GOOD',
  calibrationDueAt: null,
};

interface Answers {
  check: () => Record<string, unknown>;
  bind?: () => Record<string, unknown>;
}

function routes(answers: Answers): void {
  routeGraphql([
    {
      match: 'query Sensors',
      result: {
        sensors: {
          items: [{ id: SENSOR_ID, name: 'Tank 3 probe', type: 'MULTI', siteId: null }],
          total: 1,
        },
      },
    },
    { match: 'query SensorChannelsForBinding', result: { dataChannelsBySensor: CHANNELS } },
    { match: 'query CheckParameterChannelBinding', result: () => answers.check() },
    {
      match: 'mutation BindParameterChannel',
      result: () => (answers.bind === undefined ? {} : answers.bind()),
    },
  ]);
}

function dialog(): React.ReactElement {
  return (
    <BindChannelDialog
      parameter={{ id: 'p-tan', name: 'TAN', unit: 'mg/L', quantity: 'tan' }}
      point={{ kind: 'tank', id: TANK_ID }}
      position="REPRESENTATIVE"
      mode={{ kind: 'bind', priority: 'PRIMARY' }}
      siteId={null}
      onClose={vi.fn()}
      onDone={vi.fn()}
    />
  );
}

async function pickTanChannel(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderWithProviders(<Parent />);
  await screen.findByRole('option', { name: 'Tank 3 probe' });
  await user.selectOptions(screen.getByLabelText('Sensor'), SENSOR_ID);
  await screen.findByRole('option', { name: /TAN probe/ });
  await user.selectOptions(screen.getByLabelText('Channel'), 'tan');
  return user;
}

/** A parent that re-renders the dialog with a NEW point object each time (as a page does). */
function Parent(): React.ReactElement {
  const [renders, setRenders] = React.useState(0);
  return (
    <>
      <button type="button" onClick={() => setRenders(renders + 1)}>
        re-render parent
      </button>
      {dialog()}
    </>
  );
}

describe('BindChannelDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists the channels of the parameter quantity first and greys the others with why', async () => {
    routes({
      check: () => ({ checkParameterChannelBinding: { channel: CHECKED_CHANNEL, problems: [] } }),
    });
    await pickTanChannel();
    const other = screen.getByRole('option', { name: /pH probe/ });
    expect(other).toBeDisabled();
    expect(other.textContent).toContain(
      'The channel measures another quantity than the parameter records',
    );
  });

  it('keeps Bind disabled while the dry run reports problems', async () => {
    routes({
      check: () => ({
        checkParameterChannelBinding: { channel: CHECKED_CHANNEL, problems: ['NOT_AT_POINT'] },
      }),
    });
    await pickTanChannel();

    expect(
      await screen.findByText('The sensor does not stand at this measurement point'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bind' })).toBeDisabled();
  });

  it('shows a refused bind by its stable code and problems', async () => {
    routes({
      check: () => ({ checkParameterChannelBinding: { channel: CHECKED_CHANNEL, problems: [] } }),
      bind: () => {
        throw refusal('CHANNEL_BINDING_REFUSED', ['CHANNEL_DISABLED']);
      },
    });
    const user = await pickTanChannel();

    const bind = screen.getByRole('button', { name: 'Bind' });
    await waitFor(() => expect(bind).toBeEnabled());
    await user.click(bind);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The channel cannot feed this parameter here');
    expect(alert).toHaveTextContent('The channel is disabled');
  });

  it('says nothing was decided when the sensor service does not answer, and retries', async () => {
    let calls = 0;
    routes({
      check: () => {
        calls += 1;
        if (calls === 1) throw refusal('SENSOR_DIRECTORY_UNAVAILABLE');
        return { checkParameterChannelBinding: { channel: CHECKED_CHANNEL, problems: [] } };
      },
    });
    const user = await pickTanChannel();

    expect(
      await screen.findByText('The sensor service did not answer; nothing was decided. Try again'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bind' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('The channel can feed this parameter here.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bind' })).toBeEnabled();
  });
});

describe('BindChannelDialog dry run', () => {
  it('keeps a passed dry run on a parent render: no re-check, Bind stays enabled', async () => {
    const check = vi.fn(() => ({
      checkParameterChannelBinding: { channel: CHECKED_CHANNEL, problems: [] },
    }));
    routes({ check });
    await pickTanChannel();
    await screen.findByText('The channel can feed this parameter here.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bind' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 're-render parent' }));
    // A new point object from the parent must not put the dialog back to "checking".
    expect(screen.queryByText('Checking the channel…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Bind' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 're-render parent' }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(check).toHaveBeenCalledTimes(1);
  });
});
