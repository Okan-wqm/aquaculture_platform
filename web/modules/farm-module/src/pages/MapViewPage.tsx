/**
 * Map View Page
 *
 * Sitelerin harita uzerinde gosterimi.
 * Leaflet ve react-leaflet ile interaktif harita.
 * Veritabanindan gercek site verisi cekilir.
 *
 * YENI: Copernicus seviyesinde tile-based uydu goruntuleme
 * - Site secimi gerekmeden tum haritada uydu goruntusu
 * - Site marker'lari her zaman gorunur
 * - Su kalitesi analiz katmanlari
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, Badge } from '@aquaculture/shared-ui';
import { MapContainer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { subMonths } from 'date-fns';
import 'leaflet/dist/leaflet.css';

// Sentinel Hub components - New tile-based system
import { useSentinelTiles } from '../hooks/useSentinelTiles';
import { useMapPointQuery } from '../hooks/useMapPointQuery';
import {
  SentinelTileLayer,
  TileLoadingIndicator,
  ZoomLevelIndicator,
} from '../components/map/SentinelTileLayer';
import {
  CMEMSTileLayer,
  useCMEMSTiles,
} from '../components/map/CMEMSTileLayer';
import {
  SatelliteLayerControl,
  BaseLayer,
  type MapLayerType,
} from '../components/map/SatelliteLayerControl';
import { DateRangePicker } from '../components/map/DateRangePicker';
import { PointDataPopup } from '../components/map/PointDataPopup';
import { PointDataPanel } from '../components/map/PointDataPanel';
import { SENTINEL_LAYERS, type LayerType } from '../services/sentinelHubService';
import { CMEMS_LAYERS, type CMEMSLayerType } from '../services/cmemsService';
import { type WaterQualityLayerType, getLayerDataSource } from '../services/pointQueryService';

// AOI Drawing components - Phase 2
import { useAOIDrawing, type AOI, type AOIType } from '../hooks/useAOIDrawing';
import { AOIDrawingControls } from '../components/map/AOIDrawingControls';
import { AOIAnalysisPanel } from '../components/map/AOIAnalysisPanel';
import { AOILayer } from '../components/map/AOILayer';
import { GeomanController } from '../components/map/GeomanController';

// ============================================================================
// Types
// ============================================================================

interface SiteLocation {
  latitude: number;
  longitude: number;
}

interface SiteAddress {
  city?: string;
  country?: string;
}

interface Site {
  id: string;
  name: string;
  code: string;
  type: string;
  status: string;
  location?: SiteLocation;
  address?: SiteAddress;
  isActive: boolean;
}

interface MapSite {
  id: string;
  name: string;
  code: string;
  type: string;
  status: 'active' | 'maintenance' | 'inactive';
  coordinates: { lat: number; lng: number };
  location: string;
}

// ============================================================================
// GraphQL Query
// ============================================================================

const ACTIVE_SITES_QUERY = `
  query ActiveSites {
    activeSites {
      id
      name
      code
      type
      status
      location {
        latitude
        longitude
      }
      address {
        city
        country
      }
      isActive
    }
  }
`;

// ============================================================================
// API Helper
// ============================================================================

const fetchSitesFromAPI = async (): Promise<Site[]> => {
  const token = localStorage.getItem('access_token');

  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query: ACTIVE_SITES_QUERY }),
  });

  const result = await response.json();

  if (result.errors) {
    console.error('[MapViewPage] GraphQL Error:', result.errors);
    throw new Error(result.errors[0]?.message || 'GraphQL error');
  }

  return result.data?.activeSites || [];
};

// ============================================================================
// Custom Marker Icon
// ============================================================================

const createCustomIcon = (status: string, isSelected: boolean) => {
  const colorMap: Record<string, string> = {
    active: '#22c55e',      // green-500
    maintenance: '#eab308', // yellow-500
    inactive: '#6b7280',    // gray-500
    closed: '#ef4444',      // red-500
  };
  const color = colorMap[status.toLowerCase()] || '#22c55e';
  const size = isSelected ? 40 : 32;
  const borderWidth = isSelected ? 4 : 3;

  return L.divIcon({
    className: 'custom-marker',
    html: `
      <div style="
        background-color: ${color};
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        border: ${borderWidth}px solid white;
        box-shadow: 0 2px 8px rgba(0,0,0,${isSelected ? 0.5 : 0.3});
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        ${isSelected ? 'transform: scale(1.1);' : ''}
      ">
        <svg width="${size * 0.5}" height="${size * 0.5}" viewBox="0 0 24 24" fill="white">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
        </svg>
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size],
  });
};

// ============================================================================
// Map Controller Component (for flyTo functionality)
// ============================================================================

interface MapControllerProps {
  selectedSite: MapSite | null;
  onZoomChange?: (zoom: number) => void;
  onMapClick?: (lat: number, lng: number) => void;
  pointQueryEnabled?: boolean;
}

const MapController: React.FC<MapControllerProps> = ({
  selectedSite,
  onZoomChange,
  onMapClick,
  pointQueryEnabled = false,
}) => {
  const map = useMap();

  // Track zoom changes and map clicks
  useMapEvents({
    zoomend: () => {
      onZoomChange?.(map.getZoom());
    },
    click: (e) => {
      // Only handle click if point query is enabled
      if (pointQueryEnabled && onMapClick) {
        onMapClick(e.latlng.lat, e.latlng.lng);
      }
    },
  });

  // Map yüklendiğinde boyutu düzelt (Module Federation lazy loading sorunu için)
  useEffect(() => {
    const timer = setTimeout(() => {
      map.invalidateSize();
      onZoomChange?.(map.getZoom());
    }, 100);
    return () => clearTimeout(timer);
  }, [map, onZoomChange]);

  useEffect(() => {
    if (selectedSite) {
      map.flyTo([selectedSite.coordinates.lat, selectedSite.coordinates.lng], 12, {
        duration: 1,
      });
    }
  }, [selectedSite, map]);

  return null;
};

// ============================================================================
// Site Type Labels
// ============================================================================

const siteTypeLabels: Record<string, string> = {
  land_based: 'Kara Tesisi',
  sea_cage: 'Deniz Kafesi',
  pond: 'Havuz',
  raceway: 'Kanal',
  recirculating: 'RAS',
  hatchery: 'Kuluçkahane',
};

const statusLabels: Record<string, string> = {
  active: 'Aktif',
  maintenance: 'Bakımda',
  inactive: 'Pasif',
  closed: 'Kapalı',
};

// ============================================================================
// Map View Page
// ============================================================================

const MapViewPage: React.FC = () => {
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [currentZoom, setCurrentZoom] = useState(7);

  // Sentinel Hub state - NEW: Tile-based system
  const [activeLayer, setActiveLayer] = useState<MapLayerType>('osm');
  const [selectedDate, setSelectedDate] = useState<Date>(subMonths(new Date(), 1)); // Default: 1 ay once

  // Sentinel Hub tile hook - replaces old useSentinelHub for tile-based rendering
  const sentinel = useSentinelTiles();

  // CMEMS tile hook - for oceanographic model data
  const cmems = useCMEMSTiles();

  // AOI Drawing hook - Phase 2
  const aoi = useAOIDrawing();
  const [showAOIAnalysis, setShowAOIAnalysis] = useState(false);

  // Point Query hook - Click on map to get water quality data
  const pointQuery = useMapPointQuery({
    debounceMs: 300,
    errorAutoClearMs: 5000,
  });

  // Minimum zoom level for Sentinel layers
  const SENTINEL_MIN_ZOOM = 8;

  // Handle AOI creation from GeomanController (inside MapContainer)
  const handleAOICreated = (layer: L.Layer, type: AOIType) => {
    const aoiData = aoi.createAOIFromLayer(layer, type);
    if (aoiData) {
      aoi.addAOI(aoiData);
      setShowAOIAnalysis(true);
    }
  };

  // Show analysis panel when AOI is selected
  useEffect(() => {
    if (aoi.activeAOI) {
      setShowAOIAnalysis(true);
    }
  }, [aoi.activeAOI]);

  // CSS yüklenmesi için kısa gecikme (Module Federation sorunu)
  useEffect(() => {
    const timer = setTimeout(() => {
      setMapReady(true);
    }, 200);
    return () => clearTimeout(timer);
  }, []);

  // Fetch sites on mount
  useEffect(() => {
    const loadSites = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await fetchSitesFromAPI();
        console.log('[MapViewPage] Loaded sites:', data.length);
        setSites(data);
      } catch (err) {
        console.error('[MapViewPage] Error loading sites:', err);
        setError(err instanceof Error ? err.message : 'Failed to load sites');
      } finally {
        setLoading(false);
      }
    };

    loadSites();
  }, []);

  // Check if the active layer is a Sentinel layer
  const isSentinelLayer = SENTINEL_LAYERS.some((l) => l.id === activeLayer);

  // Check if the active layer is a CMEMS layer
  const isCMEMSLayer = CMEMS_LAYERS.some((l) => l.id === activeLayer);

  // Check if zoom is sufficient for Sentinel layers
  const canShowSentinel = currentZoom >= SENTINEL_MIN_ZOOM;

  // Check if point query is enabled for current layer (not base layers)
  const isPointQueryEnabled = pointQuery.isQuerySupported(activeLayer as WaterQualityLayerType);

  // Get data source for current layer
  const currentDataSource = getLayerDataSource(activeLayer as WaterQualityLayerType);

  // Handle map click for point query
  const handleMapPointClick = (lat: number, lng: number) => {
    if (isPointQueryEnabled && !aoi.isDrawing) {
      pointQuery.handleMapClick(lat, lng, activeLayer as WaterQualityLayerType, selectedDate);
    }
  };

  // Clear point query when layer changes
  useEffect(() => {
    pointQuery.clearPoint();
  }, [activeLayer]);

  // Update sentinel layer when activeLayer changes
  useEffect(() => {
    if (isSentinelLayer) {
      sentinel.setLayer(activeLayer as LayerType);
    }
  }, [activeLayer, isSentinelLayer, sentinel.setLayer]);

  // Update sentinel date when selectedDate changes
  useEffect(() => {
    sentinel.setDate(selectedDate);
  }, [selectedDate, sentinel.setDate]);

  // Transform sites to map format (filter those with valid coordinates)
  const mapSites = useMemo<MapSite[]>(() => {
    return sites
      .filter((s) => s.location?.latitude && s.location?.longitude)
      .map((site) => ({
        id: site.id,
        name: site.name,
        code: site.code,
        type: site.type?.toLowerCase() || 'land_based',
        status: (site.status?.toLowerCase() || 'active') as MapSite['status'],
        coordinates: {
          lat: site.location!.latitude,
          lng: site.location!.longitude,
        },
        location: [site.address?.city, site.address?.country].filter(Boolean).join(', ') || 'Konum belirtilmemiş',
      }));
  }, [sites]);

  const selectedSite = mapSites.find((s) => s.id === selectedSiteId) || null;

  // Turkiye merkezi koordinatlari
  const turkeyCenter: [number, number] = [37.5, 29.0];
  const defaultZoom = 7;

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="mt-2 text-sm text-gray-500">Site verileri yükleniyor...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-900">Site verileri yüklenemedi</p>
          <p className="text-sm text-gray-500 mt-1">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700"
          >
            Tekrar Dene
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Empty state */}
      {mapSites.length === 0 && !loading && (
        <Card className="p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <h3 className="text-sm font-medium text-gray-900">Konum bilgisi olan site bulunamadı</h3>
          <p className="text-sm text-gray-500 mt-1">
            Sitelere konum bilgisi eklemek için Setup sayfasını kullanın.
          </p>
          <Link
            to="/sites/setup"
            className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700"
          >
            Setup'a Git
          </Link>
        </Card>
      )}

      {mapSites.length > 0 && mapReady && (
        <>
          {/* Harita - Tam Genislik */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 relative overflow-hidden" style={{ height: '650px' }}>
            {/* Satellite Layer Control */}
            <SatelliteLayerControl
              activeLayer={activeLayer}
              onLayerChange={setActiveLayer}
              isConfigured={sentinel.isConfigured}
              isLoading={sentinel.isLoading}
            />

            {/* AOI Drawing Controls - Phase 2 (UI only, outside MapContainer) */}
            <AOIDrawingControls
              aois={aoi.aois}
              activeAOI={aoi.activeAOI}
              drawingMode={aoi.drawingMode}
              isDrawing={aoi.isDrawing}
              onDrawingModeChange={aoi.setDrawingMode}
              onSelectAOI={aoi.selectAOI}
              onDeleteAOI={aoi.deleteAOI}
              onRenameAOI={aoi.renameAOI}
              onClearAll={aoi.clearAllAOIs}
              isConfigured={sentinel.isConfigured}
            />

            {/* Date Range Picker - Show for Sentinel or CMEMS layers */}
            {(isSentinelLayer && sentinel.isConfigured) || isCMEMSLayer ? (
              <DateRangePicker
                selectedDate={selectedDate}
                availableDates={[]} // TODO: Fetch available dates for viewport
                onDateChange={setSelectedDate}
                isLoading={isSentinelLayer ? sentinel.isLoading : cmems.isLoading}
              />
            ) : null}

            {/* Satellite Loading Overlay - Simple loading indicator for WMTS */}
            {isSentinelLayer && sentinel.isConfigured && sentinel.hasWmtsSupport && sentinel.token && canShowSentinel && sentinel.isLoading && (
              <div className="absolute bottom-4 left-4 z-[500] bg-white/90 rounded-lg shadow px-3 py-2 flex items-center gap-2 pointer-events-none">
                <svg className="w-4 h-4 animate-spin text-primary-600" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                <span className="text-xs text-gray-600">Uydu goruntusu yukleniyor...</span>
              </div>
            )}

            {/* Zoom Level Indicator - Show when zoomed out too much for Sentinel */}
            {isSentinelLayer && sentinel.isConfigured && (
              <ZoomLevelIndicator currentZoom={currentZoom} minZoom={SENTINEL_MIN_ZOOM} />
            )}

            {/* Sentinel Hub Error Message */}
            {sentinel.error && (
              <div className="absolute bottom-4 right-4 z-[1000] max-w-xs">
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm text-red-700">{sentinel.error}</p>
                </div>
              </div>
            )}

            {/* Configure Sentinel Hub Message */}
            {isSentinelLayer && !sentinel.isConfigured && (
              <div className="absolute bottom-4 left-4 z-[1000] max-w-sm">
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                  <p className="text-sm text-yellow-800 mb-2">
                    Uydu goruntuleri icin Sentinel Hub yapilandirilmali.
                  </p>
                  <Link
                    to="/sites/settings/sentinel-hub"
                    className="text-sm text-yellow-700 font-medium hover:underline"
                  >
                    Ayarlara Git →
                  </Link>
                </div>
              </div>
            )}

            {/* WMTS Not Configured Message */}
            {isSentinelLayer && sentinel.isConfigured && !sentinel.hasWmtsSupport && (
              <div className="absolute bottom-4 left-4 z-[1000] max-w-sm">
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                  <p className="text-sm text-yellow-800 mb-2">
                    Hizli uydu goruntuleri icin WMTS Instance ID gerekli.
                    Sentinel Hub Dashboard'da Configuration Instance olusturun.
                  </p>
                  <Link
                    to="/sites/settings/sentinel-hub"
                    className="text-sm text-yellow-700 font-medium hover:underline"
                  >
                    Ayarlara Git →
                  </Link>
                </div>
              </div>
            )}


            <MapContainer
              center={turkeyCenter}
              zoom={defaultZoom}
              style={{ height: '100%', width: '100%' }}
              scrollWheelZoom={true}
            >
              {/* Base Layer (OSM or Esri Satellite) */}
              <BaseLayer layer={activeLayer} />

              {/* Sentinel Hub Tile Layer - WMTS for fast loading */}
              {isSentinelLayer && sentinel.isConfigured && sentinel.hasWmtsSupport && sentinel.instanceId && sentinel.token && canShowSentinel && (
                <SentinelTileLayer
                  instanceId={sentinel.instanceId}
                  layer={sentinel.layer}
                  date={sentinel.date}
                  token={sentinel.token}
                  opacity={sentinel.opacity}
                  minZoom={SENTINEL_MIN_ZOOM}
                  maxZoom={16}
                  onLoadingChange={sentinel.onLoadingChange}
                  onError={sentinel.onError}
                />
              )}

              {/* CMEMS Tile Layer - Oceanographic model data */}
              {isCMEMSLayer && (
                <CMEMSTileLayer
                  layer={activeLayer as CMEMSLayerType}
                  date={selectedDate}
                  opacity={0.7}
                  minZoom={5}
                  maxZoom={12}
                  onLoadingChange={cmems.handleLoadingChange}
                  onError={cmems.handleError}
                  onDataAvailability={cmems.handleDataAvailability}
                />
              )}

              {/* AOI Layer - Phase 2 */}
              <AOILayer
                aois={aoi.aois}
                activeAOI={aoi.activeAOI}
                onSelectAOI={aoi.selectAOI}
              />

              {/* Geoman Controller - Phase 2 (inside MapContainer for Leaflet context) */}
              <GeomanController
                drawingMode={aoi.drawingMode}
                onAOICreated={handleAOICreated}
              />

              <MapController
                selectedSite={selectedSite}
                onZoomChange={setCurrentZoom}
                onMapClick={handleMapPointClick}
                pointQueryEnabled={isPointQueryEnabled && !aoi.isDrawing}
              />

              {/* Point Data Popup */}
              {pointQuery.clickedPoint && (
                <PointDataPopup
                  position={[pointQuery.clickedPoint.lat, pointQuery.clickedPoint.lng]}
                  data={pointQuery.pointData}
                  isLoading={pointQuery.isLoading}
                  onClose={pointQuery.clearPoint}
                  onRefresh={pointQuery.refreshPoint}
                />
              )}

              {mapSites.map((site) => (
                <Marker
                  key={site.id}
                  position={[site.coordinates.lat, site.coordinates.lng]}
                  icon={createCustomIcon(site.status, selectedSiteId === site.id)}
                  eventHandlers={{
                    click: () => setSelectedSiteId(site.id),
                  }}
                >
                  <Popup>
                    <div className="min-w-[180px]">
                      <h4 className="font-semibold text-gray-900 mb-1">{site.name}</h4>
                      <p className="text-xs text-gray-400 mb-1">{site.code}</p>
                      <p className="text-sm text-gray-600 mb-2">{site.location}</p>
                      <div className="flex items-center gap-2 mb-3">
                        <span
                          className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${
                            site.status === 'active'
                              ? 'bg-green-100 text-green-800'
                              : site.status === 'maintenance'
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {statusLabels[site.status] || site.status}
                        </span>
                        <span className="text-xs text-gray-400">
                          {siteTypeLabels[site.type] || site.type}
                        </span>
                      </div>
                      <Link
                        to={`/sites/${site.id}`}
                        className="inline-flex items-center text-sm text-primary-600 hover:text-primary-700"
                      >
                        Detayları Gör
                        <svg className="w-4 h-4 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </Link>
                    </div>
                  </Popup>
                </Marker>
              ))}
            </MapContainer>

            {/* AOI Analysis Panel - Phase 2 */}
            {showAOIAnalysis && aoi.activeAOI && isSentinelLayer && sentinel.token && (
              <AOIAnalysisPanel
                aoi={aoi.activeAOI}
                layer={activeLayer as LayerType}
                date={selectedDate}
                token={sentinel.token}
                onClose={() => {
                  setShowAOIAnalysis(false);
                  aoi.selectAOI(null);
                }}
                onDateChange={setSelectedDate}
              />
            )}

            {/* Point Data Panel - Shows detailed info at bottom */}
            {(pointQuery.clickedPoint || pointQuery.isLoading) && (
              <PointDataPanel
                data={pointQuery.pointData}
                isLoading={pointQuery.isLoading}
                onClose={pointQuery.clearPoint}
                onRefresh={pointQuery.refreshPoint}
                isVisible={true}
              />
            )}

            {/* Point Query Info Message */}
            {isPointQueryEnabled && !pointQuery.clickedPoint && !aoi.isDrawing && (
              <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-[400] bg-white/90 rounded-lg shadow px-4 py-2 pointer-events-none">
                <p className="text-xs text-gray-600 flex items-center gap-2">
                  <svg className="w-4 h-4 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                  </svg>
                  <span>
                    Haritaya tıklayarak {currentDataSource === 'CMEMS' ? 'model' : 'uydu'} verisini sorgulayın
                  </span>
                </p>
              </div>
            )}
          </div>

          {/* Site Listesi - Alt Kisim */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            {/* Baslik ve Gorunum Secenekleri */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-4">
                <h3 className="text-lg font-semibold text-gray-900">Siteler ({mapSites.length})</h3>
                {/* Legend */}
                <div className="hidden sm:flex items-center gap-3 text-sm text-gray-500">
                  <div className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-green-500"></span>
                    <span>Aktif</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-yellow-500"></span>
                    <span>Bakımda</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-gray-500"></span>
                    <span>Pasif</span>
                  </div>
                </div>
              </div>

              {/* Gorunum Toggle */}
              <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setViewMode('card')}
                  className={`p-1.5 rounded ${viewMode === 'card' ? 'bg-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                  title="Kart Görünümü"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                  </svg>
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                  title="Liste Görünümü"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Kart Gorunumu */}
            {viewMode === 'card' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {mapSites.map((site) => (
                  <div
                    key={site.id}
                    className={`p-4 rounded-lg border cursor-pointer transition-all ${
                      selectedSiteId === site.id
                        ? 'border-primary-500 bg-primary-50 ring-1 ring-primary-500'
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                    onClick={() => setSelectedSiteId(site.id)}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="min-w-0 flex-1">
                        <h4 className="font-medium text-gray-900 truncate">{site.name}</h4>
                        <p className="text-xs text-gray-400">{site.code}</p>
                      </div>
                      <span
                        className={`ml-2 w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                          site.status === 'active' ? 'bg-green-500' :
                          site.status === 'maintenance' ? 'bg-yellow-500' : 'bg-gray-500'
                        }`}
                      />
                    </div>
                    <p className="text-sm text-gray-500 mb-1">{site.location}</p>
                    <p className="text-xs text-gray-400 mb-3">
                      {site.coordinates.lat.toFixed(4)}, {site.coordinates.lng.toFixed(4)}
                    </p>
                    <Link
                      to={`/sites/${site.id}`}
                      className="text-sm text-primary-600 hover:text-primary-700"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Detaylar →
                    </Link>
                  </div>
                ))}
              </div>
            )}

            {/* Liste Gorunumu */}
            {viewMode === 'list' && (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Site</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Konum</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Koordinat</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Durum</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tip</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {mapSites.map((site) => (
                      <tr
                        key={site.id}
                        className={`cursor-pointer transition-colors ${
                          selectedSiteId === site.id ? 'bg-primary-50' : 'hover:bg-gray-50'
                        }`}
                        onClick={() => setSelectedSiteId(site.id)}
                      >
                        <td className="px-4 py-3">
                          <div>
                            <div className="font-medium text-gray-900">{site.name}</div>
                            <div className="text-xs text-gray-400">{site.code}</div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">{site.location}</td>
                        <td className="px-4 py-3 text-xs text-gray-400">
                          {site.coordinates.lat.toFixed(4)}, {site.coordinates.lng.toFixed(4)}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={
                              site.status === 'active' ? 'success' :
                              site.status === 'maintenance' ? 'warning' : 'default'
                            }
                          >
                            {statusLabels[site.status] || site.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {siteTypeLabels[site.type] || site.type}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Link
                            to={`/sites/${site.id}`}
                            className="text-sm text-primary-600 hover:text-primary-700"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Detaylar
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default MapViewPage;
