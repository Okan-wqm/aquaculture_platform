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
    <div className="flex items-center gap-1 px-3 py-1 bg-gray-50 border-b border-gray-200 text-xs">
      <Home className="w-3 h-3 text-gray-500" />
      {path.map((segment, index) => {
        const isLast = index === path.length - 1;

        return (
          <React.Fragment key={segment.id}>
            {index > 0 && (
              <ChevronRight className="w-3 h-3 text-gray-500" />
            )}
            {isLast ? (
              <span className="text-gray-900 font-semibold">
                {segment.name}
              </span>
            ) : (
              <span
                className="text-gray-500 hover:text-cyan-600 cursor-pointer"
                onClick={() => setActiveScreen(segment.id)}
              >
                {segment.name}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};
