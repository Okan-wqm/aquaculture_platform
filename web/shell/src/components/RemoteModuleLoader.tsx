/**
 * Remote Module Loader Component
 *
 * Loading screen shown while a microfrontend module is being fetched.
 * Customizable per module name.
 */

import React from 'react';
import { Spinner } from '@aquaculture/shared-ui';
import { Columns3, House, LayoutGrid, Settings } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface RemoteModuleLoaderProps {
  moduleName: string;
  message?: string;
}

// ============================================================================
// Module Icons
// ============================================================================

const moduleIcons: Record<string, React.ReactNode> = {
  Dashboard: <LayoutGrid className="w-8 h-8" aria-hidden="true" />,
  Farm: <House className="w-8 h-8" aria-hidden="true" />,
  'Process Editor': <Columns3 className="w-8 h-8" aria-hidden="true" />,
  'Admin Panel': <Settings className="w-8 h-8" aria-hidden="true" />,
};

// ============================================================================
// Loader Component
// ============================================================================

const RemoteModuleLoader: React.FC<RemoteModuleLoaderProps> = ({ moduleName, message }) => {
  const icon = moduleIcons[moduleName] || moduleIcons.Dashboard;

  return (
    <div className="min-h-[400px] flex items-center justify-center">
      <div className="text-center">
        <div className="relative mx-auto w-20 h-20 mb-6">
          <div className="absolute inset-0 rounded-full border-4 border-primary-100 dark:border-primary-800 animate-ping opacity-75" />
          <div className="relative w-full h-full bg-primary-50 dark:bg-primary-900/20 rounded-full flex items-center justify-center">
            <div className="text-primary-600 dark:text-primary-400">{icon}</div>
          </div>
        </div>

        <div className="flex items-center justify-center space-x-3">
          <Spinner size="sm" color="primary" />
          <span className="text-gray-600 dark:text-gray-400 font-medium">
            {message || `Loading ${moduleName}...`}
          </span>
        </div>

        <p className="mt-4 text-sm text-gray-400 dark:text-gray-500">
          This may take a moment on first load
        </p>
      </div>
    </div>
  );
};

export default RemoteModuleLoader;
