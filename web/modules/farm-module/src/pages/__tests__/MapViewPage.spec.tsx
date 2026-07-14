/**
 * MapViewPage specs (FARM-MEDIUM-120 — the map surface the original test
 * campaign never covered).
 *
 * Leaflet needs real layout (it cannot render in jsdom), so react-leaflet and
 * leaflet are stubbed; the spec covers MapViewPage's own logic — it fetches the
 * active sites from the backend (ActiveSites) and renders the site panel around
 * the map, rather than any hardcoded site list.
 */
import { screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);

// Leaflet has no layout engine under jsdom — stub the map primitives so the
// page's non-map logic (site fetch + panel) is what's under test. useMap
// returns a self-referential stub so any real in-map child's `map.*` effect
// (tile layers, AOI layers) resolves to a no-op instead of throwing.
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('leaflet', () => {
  class Stub {
    readonly __leafletStub = true;
  }
  return {
    default: {
      divIcon: () => ({}),
      icon: () => ({}),
      Icon: Stub,
      Marker: Stub,
      Layer: Stub,
      GridLayer: Stub,
      TileLayer: Stub,
    },
  };
});
vi.mock('react-leaflet', () => {
  const mapStub: unknown = new Proxy(function noop() {}, {
    get: () => mapStub,
    apply: () => mapStub,
  });
  return {
    MapContainer: ({ children }: { children?: React.ReactNode }) => children,
    Marker: ({ children }: { children?: React.ReactNode }) => children,
    Popup: ({ children }: { children?: React.ReactNode }) => children,
    TileLayer: () => null,
    useMap: () => mapStub,
    useMapEvents: () => mapStub,
  };
});
// GeomanController is a side-effect import of @geoman-io/leaflet-geoman-free,
// which references a global `L` at module load (absent under jsdom). It renders
// nothing visible — stub it so the import chain never loads.
vi.mock('../../components/map/GeomanController', () => ({ GeomanController: () => null }));

import { requestMock } from '../../test-utils/sharedUiMock';
import { routeGraphql } from '../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../test-utils/renderWithProviders';
import MapViewPage from '../MapViewPage';

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    { match: 'query ActiveSites', result: { activeSites: [] } },
    {
      match: 'query SentinelHubStatus',
      result: {
        sentinelHubStatus: {
          isConfigured: false,
          clientIdMasked: null,
          instanceIdMasked: null,
          lastUsed: null,
          usageCount: 0,
        },
      },
    },
  ]);
});

describe('MapViewPage', () => {
  it('fetches active sites from the backend and renders the site panel', async () => {
    renderWithProviders(<MapViewPage />);

    expect(await screen.findByText(/Siteler/)).toBeInTheDocument();
    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([q]) => (q as string).includes('query ActiveSites')),
      ).toBe(true);
    });
  });
});
