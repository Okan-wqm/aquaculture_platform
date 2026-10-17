/**
 * fetchAllEdgeDevices — every edge device in service matching a filter, across pages.
 *
 * WHY: the live-site count needs every online device's site and the palette
 * lists the fleet with its device codes, which edgeDevices' own `search` does
 * not match (it matches deviceName only). edgeDevices pages at 20 by default,
 * so a single call would see part of the fleet. The reader walks the pages the
 * first response reports (totalPages), so the request count is bounded by the
 * server's own total rather than by trusting hasNextPage on every page. Every
 * read asks for the fleet in service (`inService`): a decommissioned or revoked
 * device lights no site and is no device to jump to, and which states those
 * are is sensor-service's rule, so the filter runs there.
 *
 * WHAT: the concatenated items, in server order; the abort signal reaches
 * every page request so a closed palette or unmounted cell cancels them.
 */
import { graphqlClient } from '@aquaculture/shared-ui';
import type { EdgeDevice, EdgeDeviceConnection } from '@platform/shared-ui/generated/graphql-types';

import { EDGE_DEVICES_QUERY } from './console.operations';

export const EDGE_DEVICE_PAGE_SIZE = 100;

/** The edgeDevices fields the console reads. */
export type EdgeDeviceRow = Pick<
  EdgeDevice,
  'id' | 'deviceCode' | 'deviceName' | 'isOnline' | 'siteId'
>;

export interface EdgeDeviceFilter {
  isOnline?: boolean;
}

interface EdgeDevicePage {
  edgeDevices: Pick<EdgeDeviceConnection, 'totalPages'> & { items: EdgeDeviceRow[] };
}

async function fetchPage(
  filter: EdgeDeviceFilter,
  page: number,
  signal: AbortSignal | undefined,
): Promise<EdgeDevicePage['edgeDevices']> {
  const data = await graphqlClient.request<EdgeDevicePage>(
    EDGE_DEVICES_QUERY,
    { ...filter, inService: true, page, limit: EDGE_DEVICE_PAGE_SIZE },
    { signal },
  );
  return data.edgeDevices;
}

export async function fetchAllEdgeDevices(
  filter: EdgeDeviceFilter,
  signal: AbortSignal | undefined,
): Promise<EdgeDeviceRow[]> {
  const first = await fetchPage(filter, 1, signal);
  const rest: Promise<EdgeDevicePage['edgeDevices']>[] = [];
  for (let page = 2; page <= first.totalPages; page += 1) {
    rest.push(fetchPage(filter, page, signal));
  }
  const pages = await Promise.all(rest);
  return [first, ...pages].flatMap((page) => page.items);
}
