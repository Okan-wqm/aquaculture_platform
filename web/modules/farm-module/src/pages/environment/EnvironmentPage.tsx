import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Card, useCanMutate } from '@aquaculture/shared-ui';

import {
  EnvironmentAvailabilityStatus,
  EnvironmentLayer,
  EnvironmentQualityStatus,
  EnvironmentScene,
  EnvironmentValue,
  useEnvironmentCurrent,
  useEnvironmentForecast,
  useEnvironmentHistory,
  useEnvironmentLayerCatalog,
  useEnvironmentSceneImage,
  useEnvironmentScenes,
  useEnvironmentWindowAnchor,
} from '../../hooks/useEnvironment';
import { Site, useSiteList } from '../../hooks/useSites';

type EnvironmentView = 'current' | 'history' | 'forecast' | 'satellite';

const DAY_MS = 24 * 60 * 60 * 1_000;
const FORECAST_DAYS = 7;

const AVAILABILITY_STYLES: Record<EnvironmentAvailabilityStatus, string> = {
  PREPARING: 'bg-blue-50 text-blue-800 border-blue-200',
  READY: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  PARTIAL_FAILURE: 'bg-red-50 text-red-900 border-red-300',
  PARTIAL_COVERAGE: 'bg-amber-50 text-amber-900 border-amber-300',
  NO_DATA: 'bg-gray-100 text-gray-700 border-gray-200',
  CLOUD_OBSCURED: 'bg-slate-100 text-slate-800 border-slate-300',
  OUT_OF_COVERAGE: 'bg-amber-50 text-amber-900 border-amber-200',
  STALE: 'bg-orange-50 text-orange-900 border-orange-200',
  PROVIDER_UNAVAILABLE: 'bg-red-50 text-red-800 border-red-200',
  CONFIGURATION_ERROR: 'bg-rose-50 text-rose-900 border-rose-200',
};

const QUALITY_STYLES: Record<EnvironmentQualityStatus, string> = {
  VALID: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  PROVISIONAL: 'bg-blue-50 text-blue-800 border-blue-200',
  NO_DATA: 'bg-gray-100 text-gray-700 border-gray-200',
  CLOUD_OBSCURED: 'bg-slate-100 text-slate-800 border-slate-300',
  OUT_OF_COVERAGE: 'bg-amber-50 text-amber-900 border-amber-200',
  STALE: 'bg-orange-50 text-orange-900 border-orange-200',
  PROVIDER_UNAVAILABLE: 'bg-red-50 text-red-800 border-red-200',
  CONFIGURATION_ERROR: 'bg-rose-50 text-rose-900 border-rose-200',
};

function formatMetric(metric: string): string {
  return metric
    .toLowerCase()
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
}

function formatValue(value: number): string {
  return new Intl.NumberFormat('en-GB', {
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDistanceM(value: number): string {
  return value >= 1_000 ? `${formatValue(value / 1_000)} km` : `${formatValue(value)} m`;
}

function providerLabel(value: EnvironmentValue): string {
  if (value.source === 'CMEMS') {
    return 'Copernicus Marine model';
  }
  if (value.source === 'MET_LOCATIONFORECAST') {
    return 'MET Norway forecast';
  }
  if (value.source === 'MET_FROST') {
    return 'MET Norway station observation';
  }
  if (value.source === 'CDSE_SENTINEL_2') {
    return 'Sentinel-2 satellite';
  }
  return 'Legacy weather source';
}

function provenanceCaveat(value: EnvironmentValue): string | null {
  if (value.source === 'CMEMS') {
    return 'Model output — not an on-site sensor reading.';
  }
  if (value.source === 'MET_LOCATIONFORECAST') {
    return 'Forecast model output — not an on-site sensor reading.';
  }
  if (value.source === 'MET_FROST') {
    return 'Nearby weather-station observation — not an on-site sensor reading.';
  }
  if (value.source === 'CDSE_SENTINEL_2') {
    return 'Satellite observation — not an in-water sensor reading.';
  }
  return null;
}

function issuedAtLabel(value: EnvironmentValue): string {
  if (value.issuedAt) {
    return `${formatDateTime(value.issuedAt)} UTC`;
  }
  return value.semanticClass === 'OBSERVATION' ? 'not applicable for observations' : 'not reported';
}

function ValueProvenance({ value }: { value: EnvironmentValue }): React.ReactElement {
  const caveat = provenanceCaveat(value);
  const resolutionM = value.resolutionM;
  const gridCellDistanceM = value.gridCellDistanceM;
  const stationDistanceKm = value.stationDistanceKm;

  return (
    <div className="text-xs text-gray-500">
      <p className="font-medium text-gray-600">{providerLabel(value)}</p>
      {caveat && <p className="mt-1">{caveat}</p>}
      <dl className="mt-2 grid grid-cols-1 gap-1">
        {value.source === 'MET_FROST' && (
          <div>
            <dt className="inline font-medium">Station:</dt>{' '}
            <dd className="inline">
              {value.stationId ?? 'not reported'}
              {stationDistanceKm !== null && stationDistanceKm !== undefined
                ? ` · ${formatValue(stationDistanceKm)} km from site`
                : ' · distance not reported'}
            </dd>
          </div>
        )}
        {value.source === 'CMEMS' && (
          <div>
            <dt className="inline font-medium">Model grid:</dt>{' '}
            <dd className="inline">
              {resolutionM !== null && resolutionM !== undefined
                ? `${formatDistanceM(resolutionM)} resolution`
                : 'resolution not reported'}
              {gridCellDistanceM !== null && gridCellDistanceM !== undefined
                ? ` · cell centre ${formatDistanceM(gridCellDistanceM)} from site`
                : ' · cell-centre distance not reported'}
            </dd>
          </div>
        )}
        <div>
          <dt className="inline font-medium">Issued:</dt>{' '}
          <dd className="inline">{issuedAtLabel(value)}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Retrieved:</dt>{' '}
          <dd className="inline">{formatDateTime(value.fetchedAt)} UTC</dd>
        </div>
      </dl>
    </div>
  );
}

function availabilityMessage(status: EnvironmentAvailabilityStatus): string {
  switch (status) {
    case 'PREPARING':
      return 'The first site-specific data sync is being prepared.';
    case 'READY':
      return 'Site-specific data is ready.';
    case 'PARTIAL_FAILURE':
      return 'Some provider metric or time-window requests failed; successful data remains available.';
    case 'PARTIAL_COVERAGE':
      return 'Data is available, but one or more requested metric or time windows contain no data.';
    case 'NO_DATA':
      return 'The provider returned no data for this site and period.';
    case 'CLOUD_OBSCURED':
      return 'Available satellite scenes are obscured by cloud.';
    case 'OUT_OF_COVERAGE':
      return 'This site is outside the selected provider product coverage.';
    case 'STALE':
      return 'The last available value is older than the freshness limit.';
    case 'PROVIDER_UNAVAILABLE':
      return 'The upstream provider is currently unavailable.';
    case 'CONFIGURATION_ERROR':
      return 'The company-managed provider connection requires attention.';
    default: {
      const exhaustiveStatus: never = status;
      return exhaustiveStatus;
    }
  }
}

function StatusPill({ status }: { status: EnvironmentAvailabilityStatus }): React.ReactElement {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${AVAILABILITY_STYLES[status]}`}
      title={availabilityMessage(status)}
    >
      {status}
    </span>
  );
}

function QualityPill({ status }: { status: EnvironmentQualityStatus }): React.ReactElement {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${QUALITY_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

function LoadingState({ label }: { label: string }): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-40 items-center justify-center rounded-lg border border-gray-200 bg-white text-sm text-gray-600"
    >
      {label}
    </div>
  );
}

function ErrorState({ message }: { message: string }): React.ReactElement {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      {message}
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-white px-6 py-10 text-center">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-gray-600">{description}</p>
    </div>
  );
}

function CurrentValueCard({
  value,
  label,
}: {
  value: EnvironmentValue;
  label: string;
}): React.ReactElement {
  return (
    <Card padding="md" className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-600">{label}</p>
          <p className="mt-2 text-2xl font-bold text-gray-950">
            {formatValue(value.value)}{' '}
            <span className="text-base font-medium text-gray-600">{value.unit}</span>
          </p>
        </div>
        <QualityPill status={value.qualityStatus} />
      </div>
      <div className="mt-3">
        <ValueProvenance value={value} />
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-1 text-xs text-gray-500">
        <div>
          <dt className="inline font-medium">Valid:</dt>{' '}
          <dd className="inline">{formatDateTime(value.validAt)} UTC</dd>
        </div>
        {value.depthM !== null && value.depthM !== undefined && (
          <div>
            <dt className="inline font-medium">Model depth:</dt>{' '}
            <dd className="inline">{formatValue(value.depthM)} m</dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

function ValueTable({
  values,
  emptyTitle,
}: {
  values: EnvironmentValue[];
  emptyTitle: string;
}): React.ReactElement {
  if (values.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description="The service returned no site-specific values for the selected metric and period."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">
            <tr>
              <th className="px-4 py-3">Valid time (UTC)</th>
              <th className="px-4 py-3">Value</th>
              <th className="px-4 py-3">Source and provenance</th>
              <th className="px-4 py-3">Quality</th>
              <th className="px-4 py-3">Depth</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {values.map((value) => (
              <tr
                key={`${value.source}|${value.datasetId}|${value.metric}|${value.validAt}|${value.depthM ?? 'surface'}`}
                className="text-gray-700"
              >
                <td className="whitespace-nowrap px-4 py-3">{formatDateTime(value.validAt)}</td>
                <td className="whitespace-nowrap px-4 py-3 font-semibold text-gray-950">
                  {formatValue(value.value)} {value.unit}
                </td>
                <td className="px-4 py-3">
                  <ValueProvenance value={value} />
                </td>
                <td className="px-4 py-3">
                  <QualityPill status={value.qualityStatus} />
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  {value.depthM === null || value.depthM === undefined
                    ? 'Surface / not applicable'
                    : `${formatValue(value.depthM)} m`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LayerAvailabilityPanel({ layers }: { layers: EnvironmentLayer[] }): React.ReactElement {
  return (
    <Card
      title="Data layer availability"
      subtitle="Labels, units and scientific meaning come from the backend catalog."
      padding="none"
    >
      <ul className="max-h-[42rem] divide-y divide-gray-100 overflow-y-auto">
        {layers.map((layer) => (
          <li key={layer.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-gray-900">{layer.name}</p>
                <p className="mt-1 text-xs text-gray-600">{layer.description}</p>
              </div>
              <StatusPill status={layer.availability} />
            </div>
            <p className="mt-2 text-xs font-medium text-gray-700">{layer.scientificLabel}</p>
            <p className="mt-1 text-xs text-gray-500">
              {layer.resolutionLabel}
              {layer.unit ? ` · Unit: ${layer.unit}` : ''}
            </p>
            <p className="mt-2 text-xs text-gray-500">{availabilityMessage(layer.availability)}</p>
            <p className="mt-2 text-xs text-gray-600">
              Coverage: {layer.coverage.successful}/{layer.coverage.expected} provider scopes
              completed
              {layer.coverage.failed > 0 ? ` · ${layer.coverage.failed} failed` : ''}
              {layer.coverage.noData > 0 ? ` · ${layer.coverage.noData} no-data` : ''}
              {layer.coverage.outOfCoverage > 0
                ? ` · ${layer.coverage.outOfCoverage} outside coverage`
                : ''}
            </p>
            {layer.coverage.scopes.some((scope) => scope.outcome !== 'AVAILABLE') && (
              <details className="mt-2 text-xs text-gray-600">
                <summary className="cursor-pointer font-medium text-gray-700">
                  Coverage gaps and failures
                </summary>
                <ul className="mt-2 space-y-1 pl-4">
                  {layer.coverage.scopes
                    .filter((scope) => scope.outcome !== 'AVAILABLE')
                    .map((scope, index) => (
                      <li key={`${scope.provider}:${scope.scopeKey}:${scope.validFrom ?? index}`}>
                        {scope.outcome} · {scope.scopeKey}
                        {scope.validFrom && scope.validTo
                          ? ` · ${formatDateTime(scope.validFrom)} to ${formatDateTime(scope.validTo)} UTC`
                          : ''}
                        {scope.errorCode ? ` · ${scope.errorCode}` : ''}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function metricLabel(metric: string, layers: EnvironmentLayer[]): string {
  const catalogLayer = layers.find((layer) => layer.metric === metric);
  return catalogLayer ? catalogLayer.name : formatMetric(metric);
}

function sceneLabel(scene: EnvironmentScene): string {
  const cloud =
    scene.cloudCoverPercent === null || scene.cloudCoverPercent === undefined
      ? 'cloud not reported'
      : `${formatValue(scene.cloudCoverPercent)}% cloud`;
  return `${formatDateTime(scene.acquiredAt)} — ${cloud} — ${sceneCoverageLabel(scene)}`;
}

function sceneCoverageLabel(scene: EnvironmentScene): string {
  switch (scene.coverageStatus) {
    case 'FULL':
      return 'full site AOI (exact)';
    case 'OUT_OF_COVERAGE':
      return 'outside site AOI (exact)';
    case 'PARTIAL':
      return scene.coveragePercent === null || scene.coveragePercent === undefined
        ? 'partial site AOI (percentage unresolved)'
        : `~${formatValue(scene.coveragePercent)}% of site AOI`;
    case 'UNKNOWN':
      return 'site AOI coverage not recorded (legacy)';
    default: {
      const exhaustiveStatus: never = scene.coverageStatus;
      return exhaustiveStatus;
    }
  }
}

function isRenderableScene(scene: EnvironmentScene): boolean {
  return (
    scene.coverageStatus !== 'OUT_OF_COVERAGE' &&
    (scene.qualityStatus === 'VALID' ||
      scene.qualityStatus === 'PROVISIONAL' ||
      scene.qualityStatus === 'STALE')
  );
}

function preferredRenderableScene(scenes: EnvironmentScene[]): EnvironmentScene | undefined {
  return (
    scenes.find((scene) => scene.coverageStatus === 'FULL' && isRenderableScene(scene)) ??
    scenes.find((scene) => scene.coverageStatus === 'PARTIAL' && isRenderableScene(scene)) ??
    scenes.find((scene) => scene.coverageStatus === 'UNKNOWN' && isRenderableScene(scene))
  );
}

function isRenderableLayerAvailability(status: EnvironmentAvailabilityStatus): boolean {
  return (
    status === 'READY' ||
    status === 'PARTIAL_FAILURE' ||
    status === 'PARTIAL_COVERAGE' ||
    status === 'STALE'
  );
}

const EnvironmentPage: React.FC = () => {
  const navigate = useNavigate();
  const canCreateSite = useCanMutate('createSite');
  const { siteId: routeSiteId } = useParams<{ siteId: string }>();
  const [activeView, setActiveView] = useState<EnvironmentView>('current');
  const [historyDays, setHistoryDays] = useState<7 | 30>(30);
  const [selectedHistoryMetric, setSelectedHistoryMetric] = useState('');
  const [selectedForecastMetric, setSelectedForecastMetric] = useState('');
  const [selectedLayerId, setSelectedLayerId] = useState('');
  const [selectedSceneId, setSelectedSceneId] = useState('');
  const timeAnchor = useEnvironmentWindowAnchor();

  const sitesQuery = useSiteList({ isActive: true });
  const hasSiteListData = sitesQuery.data !== undefined;
  const eligibleSites = useMemo(
    () =>
      (sitesQuery.data?.items ?? []).filter(
        (site): site is Site & { location: NonNullable<Site['location']> } =>
          site.type === 'SEA_CAGE' &&
          site.location !== null &&
          site.location !== undefined &&
          Number.isFinite(site.location.latitude) &&
          Number.isFinite(site.location.longitude),
      ),
    [sitesQuery.data],
  );
  const selectedSite = eligibleSites.find((site) => site.id === routeSiteId) ?? null;

  useEffect(() => {
    if (!hasSiteListData || eligibleSites.length === 0) {
      return;
    }
    if (!selectedSite) {
      navigate(`/sites/environment/${encodeURIComponent(eligibleSites[0].id)}`, {
        replace: true,
      });
    }
  }, [eligibleSites, hasSiteListData, navigate, selectedSite]);

  const canQuerySite = selectedSite !== null;
  const currentQuery = useEnvironmentCurrent(selectedSite?.id ?? '', canQuerySite);
  const catalogQuery = useEnvironmentLayerCatalog(selectedSite?.id ?? '', canQuerySite);
  const layers = catalogQuery.data ?? [];
  const currentValues = currentQuery.data?.values ?? [];

  const historyMetricOptions = useMemo(() => {
    const metrics = new Set<string>();
    for (const layer of layers) {
      if (layer.metric && layer.capabilities.includes('HISTORY')) {
        metrics.add(layer.metric);
      }
    }
    return [...metrics].sort((left, right) =>
      metricLabel(left, layers).localeCompare(metricLabel(right, layers)),
    );
  }, [layers]);

  useEffect(() => {
    if (historyMetricOptions.length === 0) {
      setSelectedHistoryMetric('');
      return;
    }
    if (!historyMetricOptions.some((metric) => metric === selectedHistoryMetric)) {
      setSelectedHistoryMetric(historyMetricOptions[0]);
    }
  }, [historyMetricOptions, selectedHistoryMetric]);
  const activeHistoryMetric = historyMetricOptions.includes(selectedHistoryMetric)
    ? selectedHistoryMetric
    : '';

  const forecastMetricOptions = useMemo(() => {
    const metrics = new Set<string>();
    for (const layer of layers) {
      if (layer.metric && layer.capabilities.includes('FORECAST')) {
        metrics.add(layer.metric);
      }
    }
    return [...metrics].sort((left, right) =>
      metricLabel(left, layers).localeCompare(metricLabel(right, layers)),
    );
  }, [layers]);

  useEffect(() => {
    if (forecastMetricOptions.length === 0) {
      setSelectedForecastMetric('');
      return;
    }
    if (!forecastMetricOptions.some((metric) => metric === selectedForecastMetric)) {
      setSelectedForecastMetric(forecastMetricOptions[0]);
    }
  }, [forecastMetricOptions, selectedForecastMetric]);
  const activeForecastMetric = forecastMetricOptions.includes(selectedForecastMetric)
    ? selectedForecastMetric
    : '';

  const historyRange = useMemo(
    () => ({
      from: new Date(timeAnchor.getTime() - historyDays * DAY_MS),
      to: timeAnchor,
    }),
    [historyDays, timeAnchor],
  );
  const sceneRange = useMemo(
    () => ({
      from: new Date(timeAnchor.getTime() - 30 * DAY_MS),
      to: timeAnchor,
    }),
    [timeAnchor],
  );

  const historyQuery = useEnvironmentHistory(
    selectedSite?.id ?? '',
    activeHistoryMetric,
    historyRange.from,
    historyRange.to,
    canQuerySite && activeView === 'history',
  );
  const forecastQuery = useEnvironmentForecast(
    selectedSite?.id ?? '',
    activeForecastMetric,
    FORECAST_DAYS,
    canQuerySite && activeView === 'forecast',
  );

  const imageryLayers = useMemo(
    () => layers.filter((layer) => layer.capabilities.includes('IMAGERY')),
    [layers],
  );
  const selectedLayer = imageryLayers.find((layer) => layer.id === selectedLayerId) ?? null;

  useEffect(() => {
    if (imageryLayers.length === 0) {
      setSelectedLayerId('');
      return;
    }
    if (!selectedLayer) {
      setSelectedLayerId(imageryLayers[0].id);
    }
  }, [imageryLayers, selectedLayer]);

  const scenesQuery = useEnvironmentScenes(
    selectedSite?.id ?? '',
    sceneRange.from,
    sceneRange.to,
    canQuerySite && activeView === 'satellite' && imageryLayers.length > 0,
  );
  const scenes = scenesQuery.data ?? [];
  const selectedScene = scenes.find((scene) => scene.sceneId === selectedSceneId) ?? null;

  useEffect(() => {
    if (scenes.length === 0) {
      setSelectedSceneId('');
      return;
    }
    if (!selectedScene) {
      setSelectedSceneId((preferredRenderableScene(scenes) ?? scenes[0]).sceneId);
    }
  }, [scenes, selectedScene]);

  const sceneCanRender =
    selectedLayer !== null &&
    selectedScene !== null &&
    isRenderableLayerAvailability(selectedLayer.availability) &&
    isRenderableScene(selectedScene);
  const sceneImage = useEnvironmentSceneImage({
    siteId: selectedSite?.id ?? '',
    layerId: selectedLayer?.id ?? '',
    sceneId: selectedScene?.sceneId ?? '',
    enabled: canQuerySite && activeView === 'satellite' && sceneCanRender,
  });

  if (sitesQuery.isPending) {
    return (
      <div className="min-h-screen bg-gray-50 p-4 sm:p-6">
        <LoadingState label="Loading your authorized sea-cage sites…" />
      </div>
    );
  }

  if (sitesQuery.isError && !hasSiteListData) {
    return (
      <div className="min-h-screen bg-gray-50 p-4 sm:p-6">
        <ErrorState message="Your authorized sites could not be loaded." />
      </div>
    );
  }

  if (eligibleSites.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 p-4 sm:p-6">
        <div className="mx-auto max-w-3xl">
          {sitesQuery.isError && (
            <div className="mb-4">
              <ErrorState message="Authorized sites could not be refreshed. The last available site list remains in use." />
            </div>
          )}
          <EmptyState
            title={
              canCreateSite
                ? 'Add a sea-cage site to start monitoring'
                : 'No authorized sea-cage site is available'
            }
            description={
              canCreateSite
                ? 'Environmental monitoring requires an authorized SEA_CAGE site with coordinates. Add the site location and monitoring radius in Setup.'
                : 'Ask a tenant administrator or module manager to add a SEA_CAGE site with coordinates and assign your account to it.'
            }
          />
          {canCreateSite && (
            <div className="mt-4 text-center">
              <Link
                to="/sites/setup/sites"
                className="inline-flex min-h-10 items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                Open site setup
              </Link>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!selectedSite) {
    return (
      <div className="min-h-screen bg-gray-50 p-4 sm:p-6">
        <LoadingState label="Opening an authorized sea-cage site…" />
      </div>
    );
  }

  const currentLabels = new Map<string, string>();
  for (const layer of layers) {
    if (layer.metric) {
      currentLabels.set(layer.metric, layer.name);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="px-4 py-6 sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-blue-700">
                Site-specific
              </p>
              <h1 className="mt-1 text-2xl font-bold text-gray-950">Environmental monitoring</h1>
              <p className="mt-1 max-w-3xl text-sm text-gray-600">
                Weather, Copernicus Marine model values and exact Sentinel-2 scenes for your
                authorized sea-cage sites.
              </p>
            </div>
            <label className="block min-w-64 text-sm font-medium text-gray-700">
              Sea-cage site
              <select
                aria-label="Sea-cage site"
                value={selectedSite.id}
                onChange={(event) => {
                  navigate(`/sites/environment/${encodeURIComponent(event.target.value)}`);
                }}
                className="mt-1 block min-h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {eligibleSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name} ({site.code})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-600">
            <span>
              Coordinates: {selectedSite.location.latitude.toFixed(5)},{' '}
              {selectedSite.location.longitude.toFixed(5)}
            </span>
            <span>Monitoring radius: {selectedSite.monitoringRadiusM} m</span>
            <span>Location revision: {selectedSite.monitoringLocationRevision}</span>
          </div>
        </div>
      </header>

      <nav
        className="border-b border-gray-200 bg-white px-4 sm:px-6"
        aria-label="Environment views"
      >
        <div className="-mb-px flex gap-6 overflow-x-auto">
          {(
            [
              ['current', 'Current'],
              ['history', 'History (max 30 days)'],
              ['forecast', '7-day forecast'],
              ['satellite', 'Sentinel-2 scenes'],
            ] as const
          ).map(([view, label]) => (
            <button
              key={view}
              type="button"
              onClick={() => setActiveView(view)}
              aria-current={activeView === view ? 'page' : undefined}
              className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-semibold ${
                activeView === view
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      <main className="grid gap-6 px-4 py-6 sm:px-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section className="min-w-0">
          {(sitesQuery.isError || currentQuery.isError || catalogQuery.isError) && (
            <div className="mb-4 space-y-2">
              {sitesQuery.isError && (
                <ErrorState message="Authorized sites could not be refreshed. The last available site list remains in use." />
              )}
              {catalogQuery.isError && (
                <ErrorState message="Layer metadata could not be refreshed. Current values and the last available layer catalog remain visible." />
              )}
              {currentQuery.isError && (
                <ErrorState message="Current environmental data could not be loaded for this site." />
              )}
            </div>
          )}

          {activeView === 'current' && (
            <>
              {currentQuery.isPending && (
                <LoadingState label="Loading current environmental conditions…" />
              )}
              {!currentQuery.isPending &&
                !currentQuery.isError &&
                (currentValues.length === 0 ? (
                  <EmptyState
                    title="NO_DATA"
                    description="No current site-specific values are available yet. Layer status on this page shows whether providers are preparing, unavailable, unconfigured, or out of coverage."
                  />
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                    {currentValues.map((value) => (
                      <CurrentValueCard
                        key={`${value.source}|${value.datasetId}|${value.metric}|${value.validAt}|${value.depthM ?? 'surface'}`}
                        value={value}
                        label={currentLabels.get(value.metric) ?? formatMetric(value.metric)}
                      />
                    ))}
                  </div>
                ))}
            </>
          )}

          {activeView === 'history' && (
            <div>
              <div className="mb-4 grid gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-2">
                <label className="text-sm font-medium text-gray-700">
                  Metric
                  <select
                    aria-label="History metric"
                    value={activeHistoryMetric}
                    onChange={(event) => setSelectedHistoryMetric(event.target.value)}
                    disabled={historyMetricOptions.length === 0}
                    className="mt-1 block min-h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2"
                  >
                    {historyMetricOptions.map((metric) => (
                      <option key={metric} value={metric}>
                        {metricLabel(metric, layers)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm font-medium text-gray-700">
                  Period
                  <select
                    aria-label="History period"
                    value={historyDays}
                    onChange={(event) => setHistoryDays(event.target.value === '7' ? 7 : 30)}
                    className="mt-1 block min-h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2"
                  >
                    <option value={7}>Last 7 days</option>
                    <option value={30}>Last 30 days</option>
                  </select>
                </label>
              </div>
              {historyMetricOptions.length === 0 ? (
                <EmptyState
                  title="NO_DATA"
                  description="No catalog or current metric is available to request a history series."
                />
              ) : historyQuery.isPending ? (
                <LoadingState label="Loading environmental history…" />
              ) : historyQuery.isError ? (
                <ErrorState message="Environmental history could not be loaded." />
              ) : (
                <ValueTable values={historyQuery.data?.values ?? []} emptyTitle="NO_DATA" />
              )}
            </div>
          )}

          {activeView === 'forecast' && (
            <div>
              <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
                <label className="block max-w-md text-sm font-medium text-gray-700">
                  Metric
                  <select
                    aria-label="Forecast metric"
                    value={activeForecastMetric}
                    onChange={(event) => setSelectedForecastMetric(event.target.value)}
                    disabled={forecastMetricOptions.length === 0}
                    className="mt-1 block min-h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2"
                  >
                    {forecastMetricOptions.map((metric) => (
                      <option key={metric} value={metric}>
                        {metricLabel(metric, layers)}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="mt-2 text-xs text-gray-600">
                  Forecast horizon is capped at seven days. Copernicus Marine values are model
                  outputs, not sensor measurements.
                </p>
              </div>
              {forecastMetricOptions.length === 0 ? (
                <EmptyState
                  title="NO_DATA"
                  description="No catalog or current metric is available to request a forecast."
                />
              ) : forecastQuery.isPending ? (
                <LoadingState label="Loading the 7-day forecast…" />
              ) : forecastQuery.isError ? (
                <ErrorState message="The environmental forecast could not be loaded." />
              ) : (
                <ValueTable values={forecastQuery.data?.values ?? []} emptyTitle="NO_DATA" />
              )}
            </div>
          )}

          {activeView === 'satellite' && (
            <div>
              {catalogQuery.isPending ? (
                <LoadingState label="Loading the satellite layer catalog…" />
              ) : imageryLayers.length === 0 ? (
                <EmptyState
                  title="NO_DATA"
                  description="The backend catalog has no satellite imagery layer for this site."
                />
              ) : (
                <>
                  <div className="mb-4 grid gap-3 rounded-lg border border-gray-200 bg-white p-4 lg:grid-cols-2">
                    <label className="text-sm font-medium text-gray-700">
                      Satellite layer
                      <select
                        aria-label="Satellite layer"
                        value={selectedLayer?.id ?? ''}
                        onChange={(event) => setSelectedLayerId(event.target.value)}
                        className="mt-1 block min-h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2"
                      >
                        {imageryLayers.map((layer) => (
                          <option key={layer.id} value={layer.id}>
                            {layer.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm font-medium text-gray-700">
                      Real acquisition
                      <select
                        aria-label="Sentinel scene"
                        value={selectedScene?.sceneId ?? ''}
                        onChange={(event) => setSelectedSceneId(event.target.value)}
                        disabled={scenes.length === 0}
                        className="mt-1 block min-h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2"
                      >
                        {scenes.map((scene) => (
                          <option key={scene.id} value={scene.sceneId}>
                            {sceneLabel(scene)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {selectedLayer && (
                    <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>{selectedLayer.name}</strong>
                        <StatusPill status={selectedLayer.availability} />
                      </div>
                      <p className="mt-2">{selectedLayer.scientificLabel}</p>
                      <p className="mt-1 text-xs text-blue-900">
                        {selectedLayer.description} · {selectedLayer.resolutionLabel}
                        {selectedLayer.unit ? ` · Unit: ${selectedLayer.unit}` : ''}
                      </p>
                    </div>
                  )}

                  {selectedScene?.coverageStatus === 'UNKNOWN' && (
                    <div
                      role="status"
                      className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
                    >
                      This is a legacy catalog row: its saved site-AOI coverage method and sample
                      count were not recorded. The exact scene is revalidated before rendering, but
                      its historical coverage percentage is not auditable.
                    </div>
                  )}
                  {selectedScene?.coverageStatus === 'PARTIAL' && (
                    <div
                      role="status"
                      className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
                    >
                      This scene covers only part of the site monitoring AOI. The displayed coverage
                      percentage is a deterministic grid estimate, not a provider measurement.
                    </div>
                  )}

                  {scenesQuery.isPending ? (
                    <LoadingState label="Loading real Sentinel-2 acquisition dates…" />
                  ) : scenesQuery.isError ? (
                    <ErrorState message="Sentinel-2 scenes could not be loaded." />
                  ) : scenes.length === 0 ? (
                    <EmptyState
                      title="NO_DATA"
                      description="No real Sentinel-2 acquisition was stored for this site in the last 30 days."
                    />
                  ) : selectedScene && selectedScene.qualityStatus === 'CLOUD_OBSCURED' ? (
                    <EmptyState
                      title="CLOUD_OBSCURED"
                      description="This real acquisition is retained for provenance, but cloud prevents a usable optical view."
                    />
                  ) : selectedScene && !isRenderableScene(selectedScene) ? (
                    <EmptyState
                      title={selectedScene.qualityStatus}
                      description={`The backend marked this acquisition ${selectedScene.qualityStatus}; it cannot be rendered as a usable site image.`}
                    />
                  ) : selectedLayer &&
                    !isRenderableLayerAvailability(selectedLayer.availability) ? (
                    <EmptyState
                      title={selectedLayer.availability}
                      description={availabilityMessage(selectedLayer.availability)}
                    />
                  ) : sceneImage.isLoading ? (
                    <LoadingState label="Rendering the selected site-specific scene…" />
                  ) : sceneImage.error ? (
                    <ErrorState message={sceneImage.error} />
                  ) : sceneImage.imageUrl && selectedLayer && selectedScene ? (
                    <figure className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                      <img
                        src={sceneImage.imageUrl}
                        alt={`${selectedLayer.name}, acquired ${formatDateTime(selectedScene.acquiredAt)}`}
                        className="aspect-video w-full bg-slate-950 object-contain"
                      />
                      <figcaption className="grid gap-2 p-4 text-xs text-gray-600 sm:grid-cols-2">
                        <span>Acquired: {formatDateTime(selectedScene.acquiredAt)} UTC</span>
                        <span>
                          Cloud:{' '}
                          {selectedScene.cloudCoverPercent === null ||
                          selectedScene.cloudCoverPercent === undefined
                            ? 'not reported'
                            : `${formatValue(selectedScene.cloudCoverPercent)}%`}
                        </span>
                        <span>Site AOI coverage: {sceneCoverageLabel(selectedScene)}</span>
                        <span>Coverage method: {selectedScene.coverageMethod}</span>
                        <span>
                          Coverage samples:{' '}
                          {selectedScene.coverageSampleCount === null ||
                          selectedScene.coverageSampleCount === undefined
                            ? 'not recorded (legacy)'
                            : selectedScene.coverageSampleCount === 0
                              ? selectedScene.coverageStatus === 'PARTIAL'
                                ? '0 usable AOI grid points — percentage unresolved'
                                : 'not sampled — exact topology'
                              : `${selectedScene.coverageSampleCount} AOI grid points`}
                        </span>
                        <span>Scene: {selectedScene.sceneId}</span>
                        <span>
                          Quality: <QualityPill status={selectedScene.qualityStatus} />
                        </span>
                      </figcaption>
                    </figure>
                  ) : (
                    <EmptyState
                      title="PREPARING"
                      description="Select a ready layer and a usable real acquisition."
                    />
                  )}
                </>
              )}
            </div>
          )}
        </section>

        <aside className="min-w-0">
          {catalogQuery.isPending && layers.length === 0 ? (
            <LoadingState label="Loading layer availability…" />
          ) : catalogQuery.isError && layers.length === 0 ? (
            <ErrorState message="Layer availability could not be loaded." />
          ) : layers.length === 0 ? (
            <EmptyState
              title="PREPARING"
              description="The provider-backed layer catalog is being prepared for this site."
            />
          ) : (
            <LayerAvailabilityPanel layers={layers} />
          )}
        </aside>
      </main>
    </div>
  );
};

export default EnvironmentPage;
