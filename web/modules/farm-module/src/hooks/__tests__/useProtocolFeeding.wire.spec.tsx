/**
 * FARM-HIGH-482 — the wire contract of protocol settings.
 *
 * The builder keeps `settings.fcrSource` as the stored lowercase value
 * ('band') and the edit modal echoes what it read back from the jsonb; the
 * GraphQL input field is an ENUM whose wire value is the NAME ('BAND'). Every
 * create and every edit therefore died at variable coercion. The conversion is
 * one function at the hook boundary; these tests pin what leaves the client.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../test-utils/sharedUiMock';
import { routeGraphql } from '../../test-utils/mockGraphqlClient';
import {
  toProtocolSettingsInput,
  useCreateFeedingProtocolV2,
  useUpdateFeedingProtocolV2,
  type CreateFeedingProtocolV2Input,
  type ProtocolSettings,
} from '../useProtocolFeeding';

const SETTINGS: ProtocolSettings = {
  autoTransition: true,
  transitionBufferG: 5,
  growthApplicationMode: 'per_meal',
  underfeedAlertThresholdPercent: 80,
  fcrSource: 'band',
};

function protocolInput(settings: ProtocolSettings): CreateFeedingProtocolV2Input {
  return {
    name: 'Standard',
    bands: [],
    defaultMealSchedule: { mealsPerDay: 1, entries: [{ time: '08:00', percentOfDaily: 100 }] },
    settings,
  };
}

function wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function sentInput(): Record<string, unknown> {
  const call = requestMock.mock.calls.at(-1);
  return (call?.[1] as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'mutation CreateFeedingProtocolV2',
      result: { createFeedingProtocolV2: { id: 'p-1' } },
    },
    {
      match: 'mutation UpdateFeedingProtocolV2',
      result: { updateFeedingProtocolV2: { id: 'p-1' } },
    },
  ]);
});

describe('toProtocolSettingsInput', () => {
  it.each([
    ['band', 'BAND'],
    ['matrix', 'MATRIX'],
    ['feed', 'FEED'],
  ] as const)('sends the stored source %s as the enum name %s', (stored, wire) => {
    expect(toProtocolSettingsInput({ ...SETTINGS, fcrSource: stored }).fcrSource).toBe(wire);
  });

  it('sends only the keys the input declares (the jsonb may carry entity-only keys)', () => {
    const readBack = {
      ...SETTINGS,
      minDissolvedOxygen: 5,
      missedMealCatchUpPercent: 20,
      temperatureRecalcThresholdC: 1,
      adjustments: [],
    } as ProtocolSettings;

    expect(Object.keys(toProtocolSettingsInput(readBack)).sort()).toEqual(
      [
        'autoTransition',
        'fcrSource',
        'growthApplicationMode',
        'maxFeedingRatePercent',
        'minDissolvedOxygen',
        'minFeedingRatePercent',
        'transitionBufferG',
        'underfeedAlertThresholdPercent',
      ].sort(),
    );
  });
});

describe('protocol mutations send the wire contract', () => {
  it('create sends fcrSource as the enum name', async () => {
    const { result } = renderHook(() => useCreateFeedingProtocolV2(), { wrapper });

    await result.current.mutateAsync(protocolInput(SETTINGS));

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect((sentInput()['settings'] as Record<string, unknown>)['fcrSource']).toBe('BAND');
  });

  it('edit sends fcrSource as the enum name even though the form echoed the stored value', async () => {
    const { result } = renderHook(() => useUpdateFeedingProtocolV2(), { wrapper });

    await result.current.mutateAsync({
      ...protocolInput({ ...SETTINGS, fcrSource: 'matrix' }),
      id: 'p-1',
    });

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(sentInput()['id']).toBe('p-1');
    expect((sentInput()['settings'] as Record<string, unknown>)['fcrSource']).toBe('MATRIX');
  });
});
