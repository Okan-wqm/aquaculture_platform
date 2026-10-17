/**
 * usePaletteSources — the people and devices the command palette can jump to.
 *
 * WHY: people come from auth-service tenantUsers — the users page a person
 * entry opens lists the same users under the same guard (users:view), and the
 * list carries what the palette finds a person by (name, email) and shows
 * beside them (role). Devices come from every page of sensor-service
 * edgeDevices, the fleet in service, each with its site's name from
 * farm-service activeSites when the viewer holds the farm module (the design
 * hints a device as "site · Online"). Neither list takes a usable search
 * argument, so both are fetched whole, once per palette session, and handed
 * to the palette unfiltered: its ranking (shared-ui rankPalette) is the one
 * rule every group is matched by, and a second matcher here would drop rows
 * it finds (a surname typed first, a double space). The query is no input,
 * so typing can never refetch. `open` is required so no caller can fetch the
 * directory while the palette is closed.
 *
 * WHAT: one StatusResult per source, its `items` the whole list in server
 * order. `reach` narrows the sources further to those the caller can link a
 * result to (the console offers a person only with the users page, a device
 * only with a devices page): a source out of reach is 'unavailable' and not
 * fetched. Devices wait for their site names, and a failed site read fails
 * the device list rather than leaving its sites out unannounced.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import type { Role, User } from '@platform/shared-ui/generated/graphql-types';
import type { UseQueryResult } from '@tanstack/react-query';

import { TENANT_USERS_QUERY } from './console.operations';
import {
  pendingResult,
  readyResult,
  resultFrom,
  type Nulled,
  type StatusResult,
} from './dataStatus';
import { fetchAllEdgeDevices, type EdgeDeviceRow } from './edgeDevicePages';
import { useActiveSites, type ActiveSite } from './useActiveSites';
import { useConsoleDataAccess } from './useConsoleDataAccess';

/** A person the palette can offer. */
export interface PalettePerson {
  id: string;
  /** First and last name; '' when the user has set neither. */
  name: string;
  email: string;
  role: Role;
}

/** An edge device the palette can offer. */
export interface PaletteDevice {
  id: string;
  code: string;
  name: string;
  isOnline: boolean;
  /** Its site, when that is one of the viewer's active sites; null otherwise or without the farm module. */
  siteName: string | null;
}

interface PeopleValues {
  items: readonly PalettePerson[];
}

interface DeviceValues {
  items: readonly PaletteDevice[];
}

export interface PaletteSources {
  people: StatusResult<PeopleValues>;
  devices: StatusResult<DeviceValues>;
}

const NO_PEOPLE: Nulled<PeopleValues> = { items: null };
const NO_DEVICES: Nulled<DeviceValues> = { items: null };

/** One palette session reuses the lists; reopening within a minute shows them at once. */
const PALETTE_STALE_MS = 60_000;

type UserRow = Pick<User, 'id' | 'firstName' | 'lastName' | 'email' | 'role'>;

function toPerson(user: UserRow): PalettePerson {
  return {
    id: user.id,
    name: [user.firstName, user.lastName].filter(Boolean).join(' '),
    email: user.email,
    role: user.role,
  };
}

function toDevices(rows: readonly EdgeDeviceRow[], sites: readonly ActiveSite[]): PaletteDevice[] {
  const siteNames = new Map(sites.map((site) => [site.id, site.name]));
  return rows.map((row) => ({
    id: row.id,
    code: row.deviceCode,
    name: row.deviceName,
    isOnline: row.isOnline,
    // A site outside the viewer's active set has no name they may read.
    siteName: row.siteId ? (siteNames.get(row.siteId) ?? null) : null,
  }));
}

/** Which sources the caller can turn into links; both by default. */
export interface PaletteReach {
  readonly people: boolean;
  readonly devices: boolean;
}

const FULL_REACH: PaletteReach = { people: true, devices: true };

export function usePaletteSources(open: boolean, reach: PaletteReach = FULL_REACH): PaletteSources {
  const access = useConsoleDataAccess();
  const peopleEnabled = open && access.people && reach.people;
  const devicesEnabled = open && access.devices && reach.devices;
  const siteNamesEnabled = devicesEnabled && access.sites;

  const people = useTenantQuery(
    ['console', 'palette', 'tenantUsers'],
    async ({ signal }): Promise<PalettePerson[]> => {
      const data = await graphqlClient.request<{ tenantUsers: UserRow[] }>(
        TENANT_USERS_QUERY,
        undefined,
        { signal },
      );
      return data.tenantUsers.map(toPerson);
    },
    { enabled: peopleEnabled, staleTime: PALETTE_STALE_MS },
  );

  const devices = useTenantQuery(
    ['console', 'palette', 'devices'],
    async ({ signal }) => fetchAllEdgeDevices({}, signal),
    { enabled: devicesEnabled, staleTime: PALETTE_STALE_MS },
  );
  const sites = useActiveSites(siteNamesEnabled);

  return {
    people: resultFrom(people, peopleEnabled, NO_PEOPLE, (items) => ({ items })),
    devices: deviceResult(devicesEnabled, siteNamesEnabled, devices, sites),
  };
}

/**
 * The device source from the device list and, with the farm module, the site
 * names: an error in either wins (as in useSiteStatus), and the list is ready
 * only once its site names are.
 */
function deviceResult(
  enabled: boolean,
  withSiteNames: boolean,
  devices: UseQueryResult<EdgeDeviceRow[]>,
  sites: UseQueryResult<ActiveSite[]>,
): StatusResult<DeviceValues> {
  if (!enabled) return pendingResult('unavailable', NO_DEVICES);
  if (devices.isError || (withSiteNames && sites.isError)) {
    return pendingResult('error', NO_DEVICES);
  }
  if (!devices.isSuccess) return pendingResult('loading', NO_DEVICES);
  if (!withSiteNames) return readyResult({ items: toDevices(devices.data, []) });
  if (!sites.isSuccess) return pendingResult('loading', NO_DEVICES);
  return readyResult({ items: toDevices(devices.data, sites.data) });
}
