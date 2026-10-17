/**
 * Hook stand-ins for the facility-structure specs (London school).
 *
 * WHY a shared module: every structure spec mocks the same five data-hook
 * modules; each spec's hoisted `vi.mock` factory imports these objects lazily,
 * and the spec sets `state` to describe what the API would answer. Changing
 * `state` and re-rendering stands in for a refetch.
 *
 * WHAT: one site (SITE-A) › department A-BUY › system RAS-1 › pump P-101, with
 * switches for the cases the specs exercise.
 */
import type { SiteElectricityState } from '../useSiteElectricity';

export interface FlowFixture {
  id: string;
  name: string;
  status: string;
  equipmentIds: string[];
}

export interface StructureFixtureState {
  /** useCanMutate('deleteSite') — whether the delete-preview counts are readable. */
  canRead: boolean;
  /** useCanReadFinance() — whether the role may see cost figures. */
  canReadFinance: boolean;
  /** What useSiteElectricity answers for the selected site. */
  electricity: SiteElectricityState;
  /** Every site id useSiteElectricity was asked about. */
  electricitySites: string[];
  primaryContact: boolean;
  /** The contacts read still shows the PREVIOUS site's list (keepPreviousData). */
  contactsPlaceholder: boolean;
  managerName: string | null;
  managerUserId: string | null;
  /** False once RAS-1 is deleted elsewhere (the systems list refetched without it). */
  hasSystem: boolean;
  /** The equipment reads are in flight (no rows yet). */
  equipmentLoading: boolean;
  flows: FlowFixture[];
  /** Total diagrams in scope; above flows.length the list is capped at one page. */
  flowsTotal: number | null;
  flowScopes: unknown[];
}

/** The electricity SITE-A booked this month, as the ledger total reports it. */
export const BOOKED_ELECTRICITY: SiteElectricityState = {
  status: 'ready',
  totals: [{ currency: 'TRY', amount: 12345.6 }],
};

export const state: StructureFixtureState = {
  canRead: true,
  canReadFinance: true,
  electricity: BOOKED_ELECTRICITY,
  electricitySites: [],
  primaryContact: true,
  contactsPlaceholder: false,
  managerName: null,
  managerUserId: null,
  hasSystem: true,
  equipmentLoading: false,
  flows: [],
  flowsTotal: null,
  flowScopes: [],
};

export function resetState(): void {
  Object.assign(state, {
    canRead: true,
    canReadFinance: true,
    electricity: BOOKED_ELECTRICITY,
    electricitySites: [],
    primaryContact: true,
    contactsPlaceholder: false,
    managerName: null,
    managerUserId: null,
    hasSystem: true,
    equipmentLoading: false,
    flows: [],
    flowsTotal: null,
    flowScopes: [],
  } satisfies StructureFixtureState);
}

interface Read<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
}

function ok<T>(data: T, isPlaceholderData = false): Read<T> {
  return { data, isLoading: false, isError: false, isPlaceholderData };
}

function loading<T>(): Read<T> {
  return { data: undefined, isLoading: true, isError: false, isPlaceholderData: false };
}

const STAMP = '2026-01-01T00:00:00.000Z';

const SITE_CONTACT = {
  id: 'c1',
  siteId: 'site-a',
  name: 'Deniz Kaya',
  role: 'Site manager',
  isPrimary: true,
};

/** Another site's primary contact, kept by the query while SITE-A's loads. */
const PREVIOUS_SITE_CONTACT = {
  id: 'c9',
  siteId: 'site-b',
  name: 'Mert Aydin',
  role: 'Site manager',
  isPrimary: true,
};

export const sitesHooks = {
  useSiteList: (): Read<unknown> =>
    ok({
      items: [
        {
          id: 'site-a',
          code: 'SITE-A',
          name: 'Ayvalik Grow-out',
          type: 'LAND_BASED',
          status: 'ACTIVE',
          siteManager: null,
          isActive: true,
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      ],
      total: 1,
    }),
  useSiteContacts: (): Read<unknown> =>
    state.contactsPlaceholder
      ? ok([PREVIOUS_SITE_CONTACT], true)
      : ok(state.primaryContact ? [SITE_CONTACT] : []),
  useSiteDeletePreview: (id: string | null): Read<unknown> =>
    ok(
      id
        ? {
            affectedItems: {
              departments: [{ id: 'dep-a' }],
              systems: [{ id: 'sys-1' }, { id: 'sys-2' }],
              equipment: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
              tanks: [
                { id: 't1', hasActiveBiomass: true },
                { id: 't2', hasActiveBiomass: false },
              ],
            },
          }
        : undefined,
    ),
};

export const departmentsHooks = {
  useDepartmentList: (): Read<unknown> =>
    ok({
      items: [
        {
          id: 'dep-a',
          code: 'A-BUY',
          name: 'Grow-out',
          type: 'GROW_OUT',
          status: 'ACTIVE',
          siteId: 'site-a',
          managerName: state.managerName,
          managerUserId: state.managerUserId,
          isActive: true,
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      ],
      total: 1,
    }),
  useDepartmentDeletePreview: (id: string | null): Read<unknown> =>
    ok(id ? { affectedItems: { equipment: [{ id: 'e1' }], tanks: [] } } : undefined),
};

export const systemsHooks = {
  useSystemList: (): Read<unknown> =>
    ok({
      items: state.hasSystem
        ? [
            {
              id: 'sys-1',
              code: 'RAS-1',
              name: 'Grow-out line 1',
              type: 'RAS',
              status: 'ACTIVE',
              siteId: 'site-a',
              departmentId: 'dep-a',
              isActive: true,
              createdAt: STAMP,
              updatedAt: STAMP,
            },
          ]
        : [],
      total: state.hasSystem ? 1 : 0,
    }),
  useSystemDeletePreview: (id: string | null): Read<unknown> =>
    ok(id ? { affectedItems: { childSystems: [], equipment: [{ id: 'eq-pump' }] } } : undefined),
};

export const equipmentHooks = {
  useEquipmentList: (filter?: { systemId?: string; departmentId?: string }): Read<unknown> => {
    if (state.equipmentLoading) return loading();
    return ok({
      items: filter?.systemId
        ? [
            {
              id: 'eq-pump',
              code: 'P-101',
              name: 'Circulation pump P-101',
              status: 'OPERATIONAL',
              departmentId: 'dep-a',
              systemIds: ['sys-1'],
              isActive: true,
            },
          ]
        : [],
      total: filter?.systemId ? 1 : 0,
    });
  },
  useEquipmentDeletePreview: (id: string | null): Read<unknown> =>
    ok(id ? { affectedItems: { childEquipment: [], subEquipment: [{ id: 's1' }] } } : undefined),
};

export const processFlowsHooks = {
  useProcessFlows: (scope: unknown): Read<unknown> => {
    state.flowScopes.push(scope);
    return ok({
      flows: state.flows.map((flow) => ({ ...flow, siteId: 'site-a', departmentId: null })),
      total: state.flowsTotal ?? state.flows.length,
    });
  },
};

export const financeAccessHooks = {
  useCanReadFinance: (): boolean => state.canReadFinance,
};

export const siteElectricityHooks = {
  useSiteElectricity: (siteId: string): SiteElectricityState => {
    state.electricitySites.push(siteId);
    return state.electricity;
  },
};
