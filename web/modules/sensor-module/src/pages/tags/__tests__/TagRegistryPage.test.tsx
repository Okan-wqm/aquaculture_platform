/**
 * TagRegistryPage (SP-001 / SENSOR-HIGH-048).
 *
 * The registry had no product write path — discover/CRUD hooks existed with
 * zero consumers. These tests pin the page's core contracts:
 *  - Discover fires the discoverTags mutation for the selected device.
 *  - The live-link editor persists source.sensorId/channelId via updateTag
 *    (the linkage the ingestion fan-out resolves, SENSOR-HIGH-046).
 *  - Existing source provenance fields survive a live-link edit.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spies = vi.hoisted(() => ({
  discover: vi.fn(async () => ({ success: true, discoveredCount: 5, createdCount: 3, tags: [] })),
  updateTag: vi.fn(async (input: unknown) => input),
  deleteTag: vi.fn(async () => true),
  retireTag: vi.fn(async () => ({ id: 'tag-1', status: 'retired' })),
  refetch: vi.fn(),
  tags: [] as unknown[],
}));

vi.mock('@aquaculture/shared-ui', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    useAuth: () => ({ tenantId: 'tenant-1', token: 't' }),
    createTenantQueryKey: (tenantId: string, ...rest: unknown[]) => ['tenant', tenantId, ...rest],
    // Faithful stub of the SSoT hook: tenant-prefixed key + the given fetcher
    // on the test's real QueryClient (the auth gate is always-on here).
    useTenantQuery: (segments: readonly unknown[], queryFn: () => Promise<unknown>) =>
      useQuery({ queryKey: ['tenant', 'tenant-1', ...segments], queryFn }),
  };
});

vi.mock('../../../hooks/useUnifiedTags', () => ({
  useUnifiedTags: () => ({
    tags: spies.tags,
    total: spies.tags.length,
    loading: false,
    error: null,
    refetch: spies.refetch,
  }),
  useDiscoverTags: () => ({ mutateAsync: spies.discover, isPending: false }),
  useUpdateTag: () => ({ mutateAsync: spies.updateTag, isPending: false }),
  useDeleteTag: () => ({ mutateAsync: spies.deleteTag, isPending: false }),
  useRetireTag: () => ({ mutateAsync: spies.retireTag, isPending: false }),
}));

vi.mock('../../../hooks/useEdgeDevices', () => ({
  useEdgeDevices: () => ({
    data: { items: [{ id: 'dev-1', deviceCode: 'EDGE-AABB1122' }] },
  }),
}));

// The link pickers fetch sensors + channels through graphqlFetch (TanStack).
vi.mock('../../../config/api', () => ({
  graphqlFetch: vi.fn(async (query: string) => {
    if (query.includes('TagRegistrySensors')) {
      return { sensors: { items: [{ id: 'sensor-9', name: 'Tank 1 DO Probe' }] } };
    }
    return {
      allDataChannels: [
        {
          id: 'chan-5',
          sensorId: 'sensor-9',
          channelKey: 'do',
          displayLabel: 'Dissolved O2',
          unit: 'mg/L',
        },
      ],
    };
  }),
}));

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TagRegistryPage from '../TagRegistryPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TagRegistryPage />
    </QueryClientProvider>,
  );
}

const baseTag = {
  id: 'tag-1',
  tenantId: 'tenant-1',
  fqn: 'EDGE-AABB1122/tank1.do',
  localName: 'tank1.do',
  displayName: 'Tank 1 DO',
  ioType: 'analog_input',
  dataType: 'float',
  direction: 'input',
  engUnit: 'mg/L',
  source: { type: 'edge_device', edgeDeviceId: 'dev-1', ioConfigId: 'io-1' },
  hierarchy: {},
  status: 'active',
  createdAt: '',
  updatedAt: '',
};

describe('TagRegistryPage (SENSOR-HIGH-048)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spies.tags = [];
  });

  it('shows the empty state pointing at discovery', () => {
    renderPage();
    expect(screen.getByText(/Kayıtlı tag yok/)).toBeTruthy();
  });

  it('runs discovery for the selected device and reports the result', async () => {
    renderPage();
    // Discover disabled until a device is chosen. (The empty-state hint also
    // says "Tag Keşfet", so query by role.)
    const discoverBtn = screen.getByRole('button', { name: /Tag Keşfet/ }) as HTMLButtonElement;
    expect(discoverBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Edge cihazı'), { target: { value: 'dev-1' } });
    expect(discoverBtn.disabled).toBe(false);

    fireEvent.click(discoverBtn);
    await waitFor(() => expect(spies.discover).toHaveBeenCalledWith('dev-1'));
    await screen.findByText(/3 yeni tag oluşturuldu/);
    expect(spies.refetch).toHaveBeenCalled();
  });

  it('persists the live link (source.sensorId/channelId) and keeps provenance', async () => {
    spies.tags = [baseTag];
    renderPage();

    fireEvent.click(screen.getByLabelText(`${baseTag.fqn} tag'ini düzenle`));
    await screen.findByText('Canlı Veri Bağlantısı');

    // Options load async — a change to a not-yet-rendered option is a no-op.
    await screen.findByText('Tank 1 DO Probe');

    // Pick the sensor, then its channel (channel list loads per sensor).
    fireEvent.change(screen.getByLabelText('Sensör'), { target: { value: 'sensor-9' } });
    await waitFor(() =>
      expect((screen.getByLabelText('Kanal') as HTMLSelectElement).disabled).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('Kanal'), { target: { value: 'chan-5' } });

    fireEvent.click(screen.getByText('Kaydet'));

    await waitFor(() => expect(spies.updateTag).toHaveBeenCalledTimes(1));
    const input = spies.updateTag.mock.calls[0][0] as {
      id: string;
      source: Record<string, unknown>;
    };
    expect(input.id).toBe('tag-1');
    expect(input.source.sensorId).toBe('sensor-9');
    expect(input.source.channelId).toBe('chan-5');
    // Discovery provenance must survive the live-link edit.
    expect(input.source.type).toBe('edge_device');
    expect(input.source.ioConfigId).toBe('io-1');
  });

  it('clears the live link when the sensor is unset', async () => {
    spies.tags = [
      { ...baseTag, source: { ...baseTag.source, sensorId: 'sensor-9', channelId: 'chan-5' } },
    ];
    renderPage();

    fireEvent.click(screen.getByLabelText(`${baseTag.fqn} tag'ini düzenle`));
    await screen.findByText('Canlı Veri Bağlantısı');

    fireEvent.change(screen.getByLabelText('Sensör'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Kaydet'));

    await waitFor(() => expect(spies.updateTag).toHaveBeenCalledTimes(1));
    const input = spies.updateTag.mock.calls[0][0] as { source: Record<string, unknown> };
    expect(input.source.sensorId).toBeUndefined();
    expect(input.source.channelId).toBeUndefined();
    expect(input.source.type).toBe('edge_device');
  });

  it('deletes a DRAFT tag after confirmation (hard delete is DRAFT-only)', async () => {
    spies.tags = [{ ...baseTag, status: 'draft' }];
    renderPage();

    fireEvent.click(screen.getByLabelText(`${baseTag.fqn} tag'ini sil`));
    await screen.findByText('Tag silinsin mi?');
    fireEvent.click(screen.getByText('Sil'));

    await waitFor(() => expect(spies.deleteTag).toHaveBeenCalledWith('tag-1'));
    expect(spies.refetch).toHaveBeenCalled();
  });

  it('an ACTIVE tag offers Retire, not Delete (SENSOR-HIGH-050)', async () => {
    spies.tags = [baseTag]; // status: 'active'
    renderPage();

    expect(screen.queryByLabelText(`${baseTag.fqn} tag'ini sil`)).toBeNull();
    fireEvent.click(screen.getByLabelText(`${baseTag.fqn} tag'ini emekli et`));
    await screen.findByText('Tag emekli edilsin mi?');
    fireEvent.click(screen.getByText('Emekli Et'));

    await waitFor(() => expect(spies.retireTag).toHaveBeenCalledWith('tag-1'));
    expect(spies.deleteTag).not.toHaveBeenCalled();
    expect(spies.refetch).toHaveBeenCalled();
  });

  it('a RETIRED tag is read-only (no edit, no delete, no retire)', () => {
    spies.tags = [{ ...baseTag, status: 'retired' }];
    renderPage();

    expect(screen.queryByLabelText(`${baseTag.fqn} tag'ini düzenle`)).toBeNull();
    expect(screen.queryByLabelText(`${baseTag.fqn} tag'ini sil`)).toBeNull();
    expect(screen.queryByLabelText(`${baseTag.fqn} tag'ini emekli et`)).toBeNull();
    expect(screen.getByText('retired')).toBeTruthy();
  });
});
