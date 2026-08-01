import { useEffect, useState } from 'react';
import {
  getSessionSnapshot,
  graphqlClient,
  restClient,
  useAuth,
  useTenantQuery,
} from '@aquaculture/shared-ui';
import type {
  EnvironmentAvailabilityStatus as GeneratedEnvironmentAvailabilityStatus,
  EnvironmentLayerResponse,
  EnvironmentProvider as GeneratedEnvironmentProvider,
  EnvironmentQualityStatus as GeneratedEnvironmentQualityStatus,
  EnvironmentSceneConnection as GeneratedEnvironmentSceneConnection,
  EnvironmentSceneResponse,
  EnvironmentSemanticClass as GeneratedEnvironmentSemanticClass,
  EnvironmentValueResponse,
  SiteEnvironmentValuesResponse,
} from '@platform/shared-ui/generated/graphql-types';
import type { UseQueryResult } from '@tanstack/react-query';

import {
  ENVIRONMENT_LAYER_CATALOG_QUERY,
  ENVIRONMENT_SCENES_QUERY,
  SITE_ENVIRONMENT_CURRENT_QUERY,
  SITE_ENVIRONMENT_FORECAST_QUERY,
  SITE_ENVIRONMENT_HISTORY_QUERY,
} from '../graphql/environment.operations';

export const ENVIRONMENT_WINDOW_REFRESH_MS = 5 * 60_000;
export const ENVIRONMENT_SCENE_RENDER_TIMEOUT_MS = 215_000;
const ENVIRONMENT_SCENE_PAGE_SIZE = 100;
const MAX_ENVIRONMENT_SCENE_PAGES = 10;

/**
 * The emitted GraphQL schema is the frontend contract SSoT. Keep local names
 * as aliases so view code remains readable without copying enum members or
 * response shapes by hand.
 */
export type EnvironmentProvider = GeneratedEnvironmentProvider;
export type EnvironmentSemanticClass = GeneratedEnvironmentSemanticClass;
export type EnvironmentQualityStatus = GeneratedEnvironmentQualityStatus;
export type EnvironmentAvailabilityStatus = GeneratedEnvironmentAvailabilityStatus;
export type EnvironmentValue = EnvironmentValueResponse;
export type SiteEnvironmentValues = SiteEnvironmentValuesResponse;
export type EnvironmentLayer = Omit<EnvironmentLayerResponse, 'sources'>;
export type EnvironmentScene = EnvironmentSceneResponse;
export type EnvironmentSceneConnection = GeneratedEnvironmentSceneConnection;

async function requestEnvironmentGraphql<TData, TVariables>(
  operation: string,
  variables: TVariables,
  querySignal: AbortSignal,
): Promise<TData> {
  const controller = new AbortController();
  const abortFromQuery = (): void =>
    controller.abort(new DOMException('Environment request was aborted', 'AbortError'));
  if (querySignal.aborted) {
    abortFromQuery();
  } else {
    querySignal.addEventListener('abort', abortFromQuery, { once: true });
  }
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException('Environment request timed out', 'TimeoutError')),
    30_000,
  );

  try {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    return await graphqlClient.request<TData, TVariables>(operation, variables, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
    querySignal.removeEventListener('abort', abortFromQuery);
  }
}

/**
 * Advances rolling history and satellite windows while the panel remains
 * open. Query keys then move with UTC time instead of refetching a permanently
 * stale mount-time range.
 */
export function useEnvironmentWindowAnchor(): Date {
  const [anchor, setAnchor] = useState(() => new Date());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setAnchor(new Date());
    }, ENVIRONMENT_WINDOW_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  return anchor;
}

export function useEnvironmentCurrent(
  siteId: string,
  enabled: boolean,
): UseQueryResult<SiteEnvironmentValues, Error> {
  return useTenantQuery<SiteEnvironmentValues>(
    ['environment', 'current', siteId],
    async ({ signal }) => {
      const data = await requestEnvironmentGraphql<
        { siteEnvironmentCurrent: SiteEnvironmentValues },
        { siteId: string }
      >(SITE_ENVIRONMENT_CURRENT_QUERY, { siteId }, signal);
      return data.siteEnvironmentCurrent;
    },
    {
      enabled: enabled && siteId.length > 0,
      keepPreviousData: false,
      staleTime: 60_000,
      refetchInterval: 5 * 60_000,
    },
  );
}

export function useEnvironmentLayerCatalog(
  siteId: string,
  enabled: boolean,
): UseQueryResult<EnvironmentLayer[], Error> {
  return useTenantQuery<EnvironmentLayer[]>(
    ['environment', 'catalog', siteId],
    async ({ signal }) => {
      const data = await requestEnvironmentGraphql<
        { environmentLayerCatalog: EnvironmentLayer[] },
        { siteId: string }
      >(ENVIRONMENT_LAYER_CATALOG_QUERY, { siteId }, signal);
      return data.environmentLayerCatalog;
    },
    {
      enabled: enabled && siteId.length > 0,
      keepPreviousData: false,
      staleTime: 60_000,
      refetchInterval: 60_000,
    },
  );
}

export function useEnvironmentHistory(
  siteId: string,
  metric: string,
  from: Date,
  to: Date,
  enabled: boolean,
): UseQueryResult<SiteEnvironmentValues, Error> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return useTenantQuery<SiteEnvironmentValues>(
    ['environment', 'history', siteId, metric, fromIso, toIso],
    async ({ signal }) => {
      const data = await requestEnvironmentGraphql<
        { siteEnvironmentHistory: SiteEnvironmentValues },
        {
          input: {
            siteId: string;
            metrics: string[];
            from: string;
            to: string;
          };
        }
      >(
        SITE_ENVIRONMENT_HISTORY_QUERY,
        {
          input: { siteId, metrics: [metric], from: fromIso, to: toIso },
        },
        signal,
      );
      return data.siteEnvironmentHistory;
    },
    {
      enabled: enabled && siteId.length > 0 && metric.length > 0,
      keepPreviousData: false,
      staleTime: 60_000,
    },
  );
}

export function useEnvironmentForecast(
  siteId: string,
  metric: string,
  days: number,
  enabled: boolean,
): UseQueryResult<SiteEnvironmentValues, Error> {
  return useTenantQuery<SiteEnvironmentValues>(
    ['environment', 'forecast', siteId, metric, days],
    async ({ signal }) => {
      const data = await requestEnvironmentGraphql<
        { siteEnvironmentForecast: SiteEnvironmentValues },
        { input: { siteId: string; metrics: string[]; days: number } }
      >(
        SITE_ENVIRONMENT_FORECAST_QUERY,
        {
          input: { siteId, metrics: [metric], days },
        },
        signal,
      );
      return data.siteEnvironmentForecast;
    },
    {
      enabled: enabled && siteId.length > 0 && metric.length > 0,
      keepPreviousData: false,
      staleTime: 60_000,
    },
  );
}

export function useEnvironmentScenes(
  siteId: string,
  from: Date,
  to: Date,
  enabled: boolean,
): UseQueryResult<EnvironmentSceneConnection, Error> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return useTenantQuery<EnvironmentSceneConnection>(
    ['environment', 'scenes', siteId, fromIso, toIso],
    async ({ signal }) => {
      const nodes: EnvironmentScene[] = [];
      const sceneIds = new Set<string>();
      let after: string | undefined;

      for (let pageNumber = 1; pageNumber <= MAX_ENVIRONMENT_SCENE_PAGES; pageNumber += 1) {
        const data = await requestEnvironmentGraphql<
          { environmentScenes: EnvironmentSceneConnection },
          {
            input: {
              siteId: string;
              from: string;
              to: string;
              first: number;
              after?: string;
            };
          }
        >(
          ENVIRONMENT_SCENES_QUERY,
          {
            input: {
              siteId,
              from: fromIso,
              to: toIso,
              first: ENVIRONMENT_SCENE_PAGE_SIZE,
              ...(after ? { after } : {}),
            },
          },
          signal,
        );
        const page = data.environmentScenes;
        if (page.siteId !== siteId) {
          throw new Error('Environment scene response returned the wrong site');
        }
        for (const scene of page.nodes) {
          if (sceneIds.has(scene.id)) {
            throw new Error('Environment scene pagination returned a duplicate row');
          }
          sceneIds.add(scene.id);
          nodes.push(scene);
        }
        if (!page.hasNextPage) {
          return {
            siteId,
            nodes,
            hasNextPage: false,
            endCursor: page.endCursor,
          };
        }
        if (!page.endCursor || page.endCursor === after) {
          throw new Error('Environment scene pagination did not advance its cursor');
        }
        after = page.endCursor;
      }

      throw new Error('Environment scene list exceeds the bounded page limit');
    },
    {
      enabled: enabled && siteId.length > 0,
      keepPreviousData: false,
      staleTime: 60_000,
      refetchInterval: 5 * 60_000,
    },
  );
}

export interface EnvironmentSceneImageState {
  imageUrl: string | null;
  isLoading: boolean;
  error: string | null;
}

interface OwnedEnvironmentSceneImageState extends EnvironmentSceneImageState {
  readonly ownerTenantId: string | null;
  readonly ownerSessionEpoch: number;
}

interface EnvironmentSceneImageInput {
  siteId: string;
  layerId: string;
  sceneId: string;
  enabled: boolean;
}

/**
 * Fetches an exact, catalog-selected Sentinel scene through the authenticated,
 * site-bound binary endpoint. Every replacement aborts the old request and
 * every generated object URL is revoked.
 */
export function useEnvironmentSceneImage({
  siteId,
  layerId,
  sceneId,
  enabled,
}: EnvironmentSceneImageInput): EnvironmentSceneImageState {
  // Blob URLs live outside React Query, so they need the same tenant/session
  // generation identity explicitly. useAuth provides the reactive tenant
  // boundary; the epoch distinguishes logout/login and A -> B -> A even when
  // a tenant database legitimately reuses the same site/scene UUIDs.
  const { tenantId } = useAuth();
  const { sessionEpoch } = getSessionSnapshot();
  const [state, setState] = useState<OwnedEnvironmentSceneImageState>({
    imageUrl: null,
    isLoading: false,
    error: null,
    ownerTenantId: null,
    ownerSessionEpoch: -1,
  });

  useEffect(() => {
    if (!enabled || !tenantId || !siteId || !layerId || !sceneId) {
      setState({
        imageUrl: null,
        isLoading: false,
        error: null,
        ownerTenantId: tenantId,
        ownerSessionEpoch: sessionEpoch,
      });
      return;
    }

    const controller = new AbortController();
    let objectUrl: string | null = null;
    let active = true;
    setState({
      imageUrl: null,
      isLoading: true,
      error: null,
      ownerTenantId: tenantId,
      ownerSessionEpoch: sessionEpoch,
    });

    void restClient
      .requestBlob('POST', `/marine/sites/${encodeURIComponent(siteId)}/render`, {
        body: {
          layerId,
          sceneId,
          width: 1200,
          height: 675,
        },
        timeout: ENVIRONMENT_SCENE_RENDER_TIMEOUT_MS,
        signal: controller.signal,
      })
      .then((blob) => {
        const currentSession = getSessionSnapshot();
        if (
          !active ||
          currentSession.effectiveTenantId !== tenantId ||
          currentSession.sessionEpoch !== sessionEpoch
        ) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({
          imageUrl: objectUrl,
          isLoading: false,
          error: null,
          ownerTenantId: tenantId,
          ownerSessionEpoch: sessionEpoch,
        });
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setState({
          imageUrl: null,
          isLoading: false,
          error: 'The selected satellite image could not be loaded.',
          ownerTenantId: tenantId,
          ownerSessionEpoch: sessionEpoch,
        });
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [enabled, layerId, sceneId, sessionEpoch, siteId, tenantId]);

  if (state.ownerTenantId !== tenantId || state.ownerSessionEpoch !== sessionEpoch) {
    return { imageUrl: null, isLoading: false, error: null };
  }
  return {
    imageUrl: state.imageUrl,
    isLoading: state.isLoading,
    error: state.error,
  };
}
