import React, { useMemo } from 'react';
import { ChevronRight, Home } from 'lucide-react';
import { useScadaPackageStore } from '../../store/scada';
import { getScreenPath } from '../../store/scada/sceneUtils';

export const ScreenBreadcrumb: React.FC = () => {
  const screens = useScadaPackageStore((s) => s.screens);
  const activeScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const setActiveScreen = useScadaPackageStore((s) => s.setActiveScreen);

  const path = useMemo(
    () => getScreenPath(screens, activeScreenId),
    [screens, activeScreenId],
  );

  // Don't render if root level (path length <= 1)
  if (path.length <= 1) return null;

  return (
    <nav
      aria-label="Screen breadcrumb"
      className="flex items-center gap-1 px-3 py-1 bg-gray-50 border-b border-gray-200 text-xs"
    >
      <Home className="w-3 h-3 text-gray-500" aria-hidden="true" />
      {path.map((segment, index) => {
        const isLast = index === path.length - 1;

        return (
          <React.Fragment key={segment.id}>
            {index > 0 && (
              <ChevronRight className="w-3 h-3 text-gray-500" aria-hidden="true" />
            )}
            {isLast ? (
              <span className="text-gray-900 font-semibold" aria-current="page">
                {segment.name}
              </span>
            ) : (
              <button
                type="button"
                className="text-gray-500 hover:text-cyan-600 cursor-pointer bg-transparent border-none p-0"
                onClick={() => setActiveScreen(segment.id)}
              >
                {segment.name}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
};
