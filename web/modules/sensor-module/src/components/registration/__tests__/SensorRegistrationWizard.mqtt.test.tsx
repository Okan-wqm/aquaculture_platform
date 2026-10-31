/**
 * ADR-047 in the registration wizard: an MQTT device publishes to the
 * platform broker, so its configuration step asks for nothing and its test
 * step runs no test — both explain why and let the user go on; the
 * registration answers with the device's broker credential, which the wizard
 * shows once (password, topic, the message shape its sensors read) before it
 * reports the registration done. The steps around these are stubs here: each
 * has its own tests.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChildSensorConfig, ProtocolInfo } from '../../../types/registration.types';
import { SensorType } from '../../../types/registration.types';
import { SensorRegistrationWizard } from '../SensorRegistrationWizard';

const graphqlFetch = vi.fn();

vi.mock('../../../config/api', () => ({
  graphqlFetch: (query: string, variables: unknown) => graphqlFetch(query, variables),
}));
vi.mock('../../../hooks/useSensorParameterCatalog', () => ({
  useSensorParameterCatalog: () => ({ catalog: [] }),
}));

const MQTT: ProtocolInfo = {
  code: 'MQTT',
  displayName: 'MQTT',
  description: 'MQTT',
  category: 'IOT' as ProtocolInfo['category'],
  subcategory: 'mqtt',
  connectionType: 'tcp',
  activatedByData: true,
};

const CHILD: ChildSensorConfig = {
  dataPath: 'ph',
  name: 'pH',
  type: SensorType.PH,
  calibrationEnabled: false,
  calibrationMultiplier: 1,
  calibrationOffset: 0,
  selected: true,
  isConfigured: true,
};

vi.mock('../steps/ProtocolSelectionStep', () => ({
  ProtocolSelectionStep: ({ onSelect }: { onSelect: (protocol: ProtocolInfo) => void }) => (
    <button onClick={() => onSelect(MQTT)}>pick MQTT</button>
  ),
}));
vi.mock('../steps/ProtocolConfigurationStep', () => ({
  ProtocolConfigurationStep: () => <p>broker form</p>,
}));
vi.mock('../steps/ConnectionTestStep', () => ({
  ConnectionTestStep: () => <p>connection test</p>,
}));
vi.mock('../steps/ParentDeviceInfoStep', () => ({
  ParentDeviceInfoStep: ({ onChange }: { onChange: (info: Record<string, string>) => void }) => (
    <button
      onClick={() => onChange({ name: 'Codex probe', siteId: 'site-1', departmentId: 'dept-1' })}
    >
      fill device
    </button>
  ),
}));
vi.mock('../steps/ChildSensorsStep', () => ({
  ChildSensorsStep: ({ onChange }: { onChange: (children: ChildSensorConfig[]) => void }) => (
    <button onClick={() => onChange([CHILD])}>add pH</button>
  ),
}));
vi.mock('../steps/ReviewStep', () => ({ ReviewStep: () => <p>review</p> }));

const CREDENTIALS = {
  sensorId: 'parent-1',
  host: 'app.suderra.com',
  port: 8883,
  tls: true,
  clientId: 'scccccccccccccccccccccc',
  username: 'scccccccccccccccccccccc',
  password: 'the-one-copy-of-the-password-0123456789abc',
  topic: 'tenants/t-1/sensors/parent-1/data',
};

describe('SensorRegistrationWizard — an MQTT device', () => {
  beforeEach(() => {
    graphqlFetch.mockReset();
    graphqlFetch.mockResolvedValue({
      registerParentWithChildren: {
        success: true,
        parent: { id: 'parent-1' },
        children: [{ id: 'child-1' }],
        connectionTestPassed: false,
        mqttCredentials: CREDENTIALS,
      },
    });
  });

  it('asks for no broker settings, runs no test, and shows the issued credential once', async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(<SensorRegistrationWizard isOpen onClose={onClose} onSuccess={onSuccess} />);
    const next = (): void => {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    };

    fireEvent.click(screen.getByText('pick MQTT'));
    next();
    expect(screen.queryByText('broker form')).toBeNull();
    expect(screen.getByText(/nothing is typed here/)).toBeTruthy();
    next();
    expect(screen.queryByText('connection test')).toBeNull();
    expect(screen.getByText(/there is no connection test/)).toBeTruthy();
    next();
    fireEvent.click(screen.getByText('fill device'));
    next();
    fireEvent.click(screen.getByText('add pH'));
    next();
    fireEvent.click(screen.getByRole('button', { name: 'Register Device & Sensors' }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText(CREDENTIALS.password)).toBeTruthy());
    expect(graphqlFetch).toHaveBeenCalledWith(
      expect.stringContaining('registerParentWithChildren'),
      {
        input: expect.objectContaining({
          parent: expect.objectContaining({ protocolCode: 'MQTT', protocolConfiguration: {} }),
        }),
      },
    );
    expect(within(dialog).getByText(/"ph": 0/)).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onSuccess).toHaveBeenCalledWith('parent-1', ['child-1']);
    expect(onClose).toHaveBeenCalled();
  });
});
