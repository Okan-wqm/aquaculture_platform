/**
 * fetchAllEdgeDevices — every page of sensor-service edgeDevices, not the first.
 *
 * The live-site count and the palette's device list both need the whole
 * fleet in service; edgeDevices pages at 20 by default, so the reader walks the
 * pages the server reports (totalPages) and stops there even if hasNextPage
 * misbehaves. Every page asks for the fleet in service, so a decommissioned
 * or revoked device never reaches the console.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());

vi.mock('@aquaculture/shared-ui', () => ({ graphqlClient: { request } }));

import { EDGE_DEVICES_QUERY } from '../console.operations';
import { EDGE_DEVICE_PAGE_SIZE, fetchAllEdgeDevices } from '../edgeDevicePages';

function device(id: string): {
  id: string;
  deviceCode: string;
  deviceName: string;
  isOnline: boolean;
  siteId: string | null;
} {
  return { id, deviceCode: `EG-${id}`, deviceName: `Gateway ${id}`, isOnline: true, siteId: 's1' };
}

beforeEach(() => {
  request.mockReset();
});

describe('fetchAllEdgeDevices', () => {
  it('walks every page the server reports and concatenates the items', async () => {
    request
      .mockResolvedValueOnce({ edgeDevices: { items: [device('1'), device('2')], totalPages: 3 } })
      .mockResolvedValueOnce({ edgeDevices: { items: [device('3')], totalPages: 3 } })
      .mockResolvedValueOnce({ edgeDevices: { items: [device('4')], totalPages: 3 } });

    const devices = await fetchAllEdgeDevices({ isOnline: true }, undefined);

    expect(devices.map((d) => d.id)).toEqual(['1', '2', '3', '4']);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(
      1,
      EDGE_DEVICES_QUERY,
      { isOnline: true, inService: true, page: 1, limit: EDGE_DEVICE_PAGE_SIZE },
      { signal: undefined },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      EDGE_DEVICES_QUERY,
      { isOnline: true, inService: true, page: 3, limit: EDGE_DEVICE_PAGE_SIZE },
      { signal: undefined },
    );
  });

  it('makes one request when everything fits on the first page', async () => {
    request.mockResolvedValueOnce({ edgeDevices: { items: [device('1')], totalPages: 1 } });

    const devices = await fetchAllEdgeDevices({}, undefined);

    expect(devices).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('asks for the fleet in service on every page, with no filter given too', async () => {
    request.mockResolvedValue({ edgeDevices: { items: [device('1')], totalPages: 2 } });

    await fetchAllEdgeDevices({}, undefined);

    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ inService: true }));
    }
  });

  it('returns no devices, after one request, for an empty fleet', async () => {
    request.mockResolvedValueOnce({ edgeDevices: { items: [], totalPages: 0 } });

    await expect(fetchAllEdgeDevices({}, undefined)).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('passes the abort signal to every page request', async () => {
    const controller = new AbortController();
    request.mockResolvedValue({ edgeDevices: { items: [device('1')], totalPages: 2 } });

    await fetchAllEdgeDevices({}, controller.signal);

    for (const call of request.mock.calls) {
      expect(call[2]).toEqual({ signal: controller.signal });
    }
  });
});
