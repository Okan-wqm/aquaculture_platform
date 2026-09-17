/**
 * SCADA Operator Page — the routed entry point of the HMI operator runtime.
 *
 * Route: /sensor/scada/operator/:packageId
 *
 * T7k:
 *  - Loads the PUBLISHED artifact via PUBLISHED_SCADA_PACKAGE (the backend
 *    refuses DRAFT/ARCHIVED packages — the operator must never render an
 *    unpublished draft).
 *  - Header version stamp: rendered version + publishedAt.
 *  - Staleness watch: the package's CURRENT version is polled in parallel
 *    (cheap fields only); when it exceeds the rendered version the page
 *    shows a "STALE — package re-published, refresh required" banner.
 *  - Id-based load guard: loadFromJSON is skipped when the store already
 *    holds this package id (avoids refetch clobbering live state); a
 *    packageId CHANGE resets + reloads the store.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Loader2 } from 'lucide-react';

import { OperatorBootstrap } from '../../components/scada-operator/OperatorBootstrap';
import { OperatorShell, OperatorView } from '../../components/scada-operator';
import { useScadaPackageStore } from '../../store/scada';
import type { ScadaPackageJSON } from '../../store/scada';
import type { Screen } from '../../types/scada-package.types';
import { graphqlFetch } from '../../config/api';
import { useAuth } from '@aquaculture/shared-ui';
import { PUBLISHED_SCADA_PACKAGE } from '../../graphql/scada-package.queries';

/** The published representation returned by publishedScadaPackage(). */
interface PublishedScadaPackage {
  id: string;
  name: string;
  version: number;
  status: string;
  publishedAt: string | null;
  packageData: unknown;
}

/** Cheap parallel probe: only the fields the staleness check needs. */
const PACKAGE_VERSION_PROBE = `
  query ScadaPackageVersion($id: ID!) {
    scadaPackage(id: $id) {
      id
      version
    }
  }
`;

/** Poll the underlying package version so re-publishes become visible. */
const STALE_CHECK_INTERVAL_MS = 60_000;

function usePublishedScadaPackage(id: string | undefined) {
  const { token, tenantId } = useAuth();
  const [published, setPublished] = useState<PublishedScadaPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<number | null>(null);

  useEffect(() => {
    if (!id) {
      setPublished(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    // AUTH-READINESS GATE (mirrors useScadaPackageById): no query before the
    // tenant context resolves — the mount fetch would otherwise race auth.
    if (!token || !tenantId) {
      setPublished(null);
      setLoading(false);
      return;
    }

    const load = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await graphqlFetch<{ publishedScadaPackage: PublishedScadaPackage | null }>(
          PUBLISHED_SCADA_PACKAGE,
          { id },
        );
        if (cancelled) return;
        setPublished(result.publishedScadaPackage);
        if (!result.publishedScadaPackage) {
          setError('No published package found for this id');
        }
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setPublished(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const probeVersion = async (): Promise<void> => {
      try {
        const result = await graphqlFetch<{ scadaPackage: { version: number } | null }>(
          PACKAGE_VERSION_PROBE,
          { id },
        );
        if (!cancelled) setLatestVersion(result.scadaPackage?.version ?? null);
      } catch {
        // The probe is best-effort; a failed probe must not break the page.
        // (GET_SCADA_PACKAGE itself remains unused as a full fallback — the
        // published query is the operator's contract.)
      }
    };

    void load();
    void probeVersion();
    const interval = setInterval(probeVersion, STALE_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id, token, tenantId]);

  return { published, loading, error, latestVersion };
}

const ScadaOperatorPage: React.FC = () => {
  const { packageId } = useParams<{ packageId: string }>();
  const { published, loading, error, latestVersion } = usePublishedScadaPackage(packageId);

  const loadFromJSON = useScadaPackageStore((s) => s.loadFromJSON);
  const reset = useScadaPackageStore((s) => s.reset);
  const storePackageId = useScadaPackageStore((s) => s.packageId);
  const screens = useScadaPackageStore((s) => s.screens);
  const activeScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const setActiveScreen = useScadaPackageStore((s) => s.setActiveScreen);

  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  // Id-based load guard (T7k): hydrate only when this package is not already
  // the store's package; a packageId change (kiosk deep link) resets first so
  // the previous package can never bleed into the new one.
  useEffect(() => {
    if (!published?.packageData || !packageId) return;
    if (hydratedFor === packageId && storePackageId === packageId) return;

    if (storePackageId && storePackageId !== packageId) {
      reset();
    }
    loadFromJSON(published.packageData as ScadaPackageJSON);
    setHydratedFor(packageId);
  }, [published, packageId, storePackageId, hydratedFor, loadFromJSON, reset]);

  const activeScreen = useMemo<Screen | undefined>(
    () => screens.find((s) => s.id === activeScreenId) ?? screens[0],
    [screens, activeScreenId],
  );

  // Staleness: the underlying package moved past the rendered version.
  const isStale =
    published != null && latestVersion != null && latestVersion > published.version;

  const versionStamp = published
    ? `v${published.version}${published.publishedAt ? ` · published ${new Date(published.publishedAt).toLocaleString()}` : ''}`
    : '';

  if (loading || (published && hydratedFor !== packageId)) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-900">
        <div className="flex flex-col items-center gap-3 text-gray-300">
          <Loader2 className="w-8 h-8 animate-spin" />
          <p className="text-sm">Loading published SCADA package...</p>
        </div>
      </div>
    );
  }

  if (error || !published || !packageId) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-900">
        <div className="flex flex-col items-center gap-3 text-gray-300 max-w-md text-center">
          <AlertCircle className="w-8 h-8 text-red-400" />
          <p className="text-sm">
            {error || 'SCADA package not found'}
          </p>
          <p className="text-xs text-gray-500">
            Only PUBLISHED packages can be opened in the operator. DRAFT and
            ARCHIVED packages are not loadable here.
          </p>
          <Link
            to="/sensor/scada-packages"
            className="flex items-center gap-1.5 text-sm text-cyan-400 hover:text-cyan-300"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to SCADA Packages
          </Link>
        </div>
      </div>
    );
  }

  return (
    <OperatorBootstrap packageId={packageId} dataProviderType="live">
      <OperatorShell
        dataProviderType="live"
        activeScreenId={activeScreen?.id}
        projectName={`${published.name}${versionStamp ? ` (${versionStamp})` : ''}`}
        onNavigate={setActiveScreen}
      >
        {isStale && (
          <div
            role="alert"
            className="absolute top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-black text-xs font-semibold"
          >
            <AlertCircle className="w-4 h-4" aria-hidden="true" />
            STALE — package re-published (v{published.version} → v{latestVersion}), refresh
            required
          </div>
        )}
        {activeScreen ? (
          <OperatorView screen={activeScreen} onNavigate={setActiveScreen} />
        ) : (
          <div className="flex h-full items-center justify-center text-gray-400 text-sm">
            This package has no screens.
          </div>
        )}
      </OperatorShell>
    </OperatorBootstrap>
  );
};

export default ScadaOperatorPage;
