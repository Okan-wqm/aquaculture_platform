/**
 * SCADA Operator Page — the routed entry point of the HMI operator runtime.
 *
 * The full operator stack (OperatorBootstrap → OperatorShell → OperatorView,
 * live IDataProvider, alarm/script listeners) existed but was mounted by no
 * route. This page loads the package by id, hydrates the package store
 * (upcasting legacy docs via loadFromJSON), and mounts the runtime.
 *
 * Route: /sensor/scada/operator/:packageId
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Loader2 } from 'lucide-react';

import { OperatorBootstrap } from '../../components/scada-operator/OperatorBootstrap';
import { OperatorShell, OperatorView } from '../../components/scada-operator';
import { useScadaPackageById } from '../../hooks/useScadaPackage';
import { useScadaPackageStore } from '../../store/scada';
import type { ScadaPackageJSON } from '../../store/scada';
import type { Screen } from '../../types/scada-package.types';

const ScadaOperatorPage: React.FC = () => {
  const { packageId } = useParams<{ packageId: string }>();
  const { scadaPackage, loading, error } = useScadaPackageById(packageId);

  const loadFromJSON = useScadaPackageStore((s) => s.loadFromJSON);
  const screens = useScadaPackageStore((s) => s.screens);
  const activeScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const setActiveScreen = useScadaPackageStore((s) => s.setActiveScreen);

  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (scadaPackage?.packageData) {
      loadFromJSON(scadaPackage.packageData as ScadaPackageJSON);
      setHydrated(true);
    }
  }, [scadaPackage, loadFromJSON]);

  const activeScreen = useMemo<Screen | undefined>(
    () => screens.find((s) => s.id === activeScreenId) ?? screens[0],
    [screens, activeScreenId],
  );

  if (loading || (scadaPackage && !hydrated)) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-900">
        <div className="flex flex-col items-center gap-3 text-gray-300">
          <Loader2 className="w-8 h-8 animate-spin" />
          <p className="text-sm">Loading SCADA package...</p>
        </div>
      </div>
    );
  }

  if (error || !scadaPackage || !packageId) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-900">
        <div className="flex flex-col items-center gap-3 text-gray-300 max-w-md text-center">
          <AlertCircle className="w-8 h-8 text-red-400" />
          <p className="text-sm">{error || 'SCADA package not found'}</p>
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
        projectName={scadaPackage.name}
        onNavigate={setActiveScreen}
      >
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
