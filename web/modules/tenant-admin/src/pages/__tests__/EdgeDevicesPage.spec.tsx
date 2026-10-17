/**
 * EdgeDevicesPage — a device card opens the device's page as a link.
 *
 * The card was a `<div onClick={navigate}>`: no role, no tab stop, so a
 * keyboard user could not open a device, and no "open in new tab". It is a
 * router Link to `/tenant/devices/:id` now, drawn as the blueprint card.
 */
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createTenantAdminTestQueryClient } from '../../test/query-client';

vi.mock('../../hooks/useTenantData', () => ({
  useEdgeDevices: () => ({
    isLoading: false,
    data: {
      edgeDevices: {
        total: 1,
        items: [
          {
            id: 'dev-1',
            deviceName: 'Hall A controller',
            deviceCode: 'EDGE-001',
            isOnline: false,
            lifecycleState: 'active',
            agentVersion: null,
            cpuUsage: null,
            memoryUsage: null,
            ipAddress: '10.0.0.5',
            deviceModel: 'RPi',
            lastSeenAt: null,
          },
        ],
      },
      edgeDeviceStats: { total: 1, online: 0, offline: 1, byState: [] },
    },
  }),
  tenantKeys: { invalidateDevices: () => ['tenant', 'tenant-1', 'devices'] },
}));

import EdgeDevicesPage from '../EdgeDevicesPage';

describe('EdgeDevicesPage device cards', () => {
  it('renders each device as a link to its page, drawn as the blueprint card', () => {
    render(
      <QueryClientProvider client={createTenantAdminTestQueryClient()}>
        <MemoryRouter>
          <EdgeDevicesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const card = screen.getByRole('link', { name: /Hall A controller/ });
    expect(card).toHaveAttribute('href', '/tenant/devices/dev-1');
    expect(card).toHaveClass('sd-card');
    expect(card).not.toHaveClass('bg-white');
  });
});
