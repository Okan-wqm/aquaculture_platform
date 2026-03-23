import React from 'react';
import { CheckCircle, XCircle } from 'lucide-react';
import type { DisplayModule } from './ModuleCard';

/**
 * Module Details Modal -- shows full module info in a dialog.
 */
const ModuleDetailsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  module: DisplayModule | null;
}> = ({ isOpen, onClose, module }) => {
  if (!isOpen || !module) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative min-h-screen flex items-center justify-center p-4">
        <div className="relative w-full max-w-lg bg-white rounded-xl shadow-xl">
          <div className="px-6 py-4 border-b border-gray-100">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-tenant-50 flex items-center justify-center text-2xl">
                {module.icon}
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">{module.name}</h3>
                <span className="text-sm text-gray-500">{module.code}</span>
              </div>
            </div>
          </div>
          <div className="px-6 py-4 space-y-4">
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-1">Description</h4>
              <p className="text-sm text-gray-600">{module.description}</p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-1">Status</h4>
              <div className="flex items-center gap-2">
                {module.status === 'active' ? (
                  <CheckCircle className="w-4 h-4 text-green-500" />
                ) : (
                  <XCircle className="w-4 h-4 text-gray-500" />
                )}
                <span className={`text-sm ${module.status === 'active' ? 'text-green-600' : 'text-gray-500'}`}>
                  {module.status === 'active' ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Features</h4>
              <div className="grid grid-cols-2 gap-2">
                {module.features.map((feature, idx) => (
                  <div key={idx} className="flex items-center gap-2 p-2 rounded-lg bg-gray-50">
                    <CheckCircle className="w-4 h-4 text-tenant-500" />
                    <span className="text-sm text-gray-700">{feature}</span>
                  </div>
                ))}
              </div>
              {module.features.length === 0 && (
                <p className="text-sm text-gray-500 italic">No features listed</p>
              )}
            </div>
            {module.route && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-1">Dashboard Route</h4>
                <code className="text-sm bg-gray-100 px-2 py-1 rounded text-gray-600">
                  {module.route}
                </code>
              </div>
            )}
            {module.manager && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-1">Module Manager</h4>
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white text-sm font-medium">
                    {module.manager.name.split(' ').map((n) => n[0]).join('').substring(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{module.manager.name}</p>
                    <p className="text-xs text-gray-500">{module.manager.email}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModuleDetailsModal;
