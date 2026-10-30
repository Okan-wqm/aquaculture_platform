/**
 * ADR-047 on the device page: a sensor its data activates shows the username
 * it connects as, or that it holds none; a role the resolver admits issues it
 * a credential through rotateSensorMqttCredentials, asked first when one would
 * be replaced; the new connection, password included, is shown once in a
 * dialog and is gone when the dialog closes; a refusal is worded by its code.
 */
import { GraphQLClientError } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BrokerConnectionSection } from '../BrokerConnectionSection';

const graphqlFetch = vi.fn();
const toast = vi.fn();
const confirm = vi.fn();

vi.mock('@aquaculture/shared-ui', async (original) => ({
  ...(await original<typeof import('@aquaculture/shared-ui')>()),
  useToast: () => ({ toast }),
  useConfirm: () => confirm,
}));
vi.mock('../../../config/api', () => ({
  graphqlFetch: (query: string, variables: unknown) => graphqlFetch(query, variables),
}));

const ISSUED = {
  sensorId: 'sensor-1',
  host: 'app.suderra.com',
  port: 8883,
  tls: true,
  clientId: 'sbbbbbbbbbbbbbbbbbbbbbb',
  username: 'sbbbbbbbbbbbbbbbbbbbbbb',
  password: 'the-one-copy-of-the-password-0123456789abc',
  topic: 'tenants/t-1/sensors/sensor-1/data',
};

function renderSection(props: Partial<React.ComponentProps<typeof BrokerConnectionSection>> = {}): {
  onIssued: ReturnType<typeof vi.fn>;
} {
  const onIssued = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BrokerConnectionSection
        sensorId="sensor-1"
        mqttUsername={null}
        canIssue
        onIssued={onIssued}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onIssued };
}

describe('BrokerConnectionSection', () => {
  beforeEach(() => {
    graphqlFetch.mockReset();
    toast.mockReset();
    confirm.mockReset();
    graphqlFetch.mockResolvedValue({ rotateSensorMqttCredentials: ISSUED });
  });

  it('issues a first credential and shows the connection once', async () => {
    const { onIssued } = renderSection();
    expect(screen.getByText(/No credential yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    const dialog = await screen.findByRole('dialog');
    expect(graphqlFetch).toHaveBeenCalledWith(
      expect.stringContaining('rotateSensorMqttCredentials'),
      { sensorId: 'sensor-1' },
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(within(dialog).getByText(ISSUED.password)).toBeTruthy();
    expect(within(dialog).getByText(ISSUED.topic)).toBeTruthy();
    expect(within(dialog).getByText('8883 (TLS)')).toBeTruthy();
    expect(within(dialog).getByRole('alert').textContent).toMatch(/shown only this once/);
    expect(onIssued).toHaveBeenCalledWith(ISSUED.username);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText(ISSUED.password)).toBeNull());
  });

  it('asks before replacing the credential the sensor uses, and does nothing when declined', async () => {
    confirm.mockResolvedValue(false);
    renderSection({ mqttUsername: 'saaaaaaaaaaaaaaaaaaaaaa' });
    expect(screen.getByText('saaaaaaaaaaaaaaaaaaaaaa')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Issue new credential' }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(graphqlFetch).not.toHaveBeenCalled();
  });

  it('words a refusal by its code in the user’s language', async () => {
    graphqlFetch.mockRejectedValue(
      new GraphQLClientError('A suspended sensor', 'MQTT_IDENTITY_SUSPENDED'),
    );
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'error',
          description: 'The sensor is suspended. Reactivate it first.',
        }),
      ),
    );
  });

  it('offers nothing to a role the resolver refuses', () => {
    renderSection({ canIssue: false });
    expect(screen.queryByRole('button', { name: /credential/ })).toBeNull();
  });
});
