import React from 'react';
import {
  Users,
  CheckCircle,
  XCircle,
  Clock,
  UserPlus,
  Shield,
  MoreVertical,
  ExternalLink,
  BarChart3,
  Calendar,
  Activity,
  TrendingUp,
} from 'lucide-react';

/**
 * Module for display.
 */
export interface DisplayModule {
  id: string;
  code: string;
  name: string;
  description: string;
  status: 'active' | 'inactive' | 'pending';
  assignedUsers: number;
  manager?: {
    id: string;
    name: string;
    email: string;
  };
  lastActivity: string;
  features: string[];
  icon: string;
  route?: string;
  activatedAt: string;
}

/**
 * Module usage statistics shape.
 */
export interface ModuleUsageStatLocal {
  moduleCode: string;
  userCount: number;
  lastAccessAt: string | null;
  actionsThisMonth: number;
  actionsLastMonth: number;
}

/**
 * Status badge component.
 */
const StatusBadge: React.FC<{ status: DisplayModule['status'] }> = ({ status }) => {
  const statusConfig = {
    active: {
      bg: 'bg-green-100',
      text: 'text-green-700',
      icon: <CheckCircle className="w-3 h-3" />,
      label: 'Active',
    },
    inactive: {
      bg: 'bg-gray-100',
      text: 'text-gray-700',
      icon: <XCircle className="w-3 h-3" />,
      label: 'Inactive',
    },
    pending: {
      bg: 'bg-yellow-100',
      text: 'text-yellow-700',
      icon: <Clock className="w-3 h-3" />,
      label: 'Pending Setup',
    },
  };

  const config = statusConfig[status];

  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
};

interface ModuleCardProps {
  module: DisplayModule;
  usageStats?: ModuleUsageStatLocal;
  onAssignManager: (module: DisplayModule) => void;
  onViewDetails: (module: DisplayModule) => void;
  onOpenModule: (module: DisplayModule) => void;
  moduleRoute?: string;
}

/**
 * ModuleCard -- renders a single module as a card in the grid.
 *
 * FIX MED-08: Uses module.code as React key (called from parent) instead of
 * unstable UUID to prevent flicker when moduleIdByCode map resolves.
 */
const ModuleCard: React.FC<ModuleCardProps> = ({
  module,
  usageStats,
  onAssignManager,
  onViewDetails,
  onOpenModule,
  moduleRoute,
}) => {
  const canOpen = !!moduleRoute && module.status === 'active';

  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden hover:shadow-lg transition-shadow">
      {/* Module Header */}
      <div className="p-6 border-b border-gray-100">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-tenant-50 flex items-center justify-center text-2xl">
              {module.icon}
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">{module.name}</h3>
              <StatusBadge status={module.status} />
            </div>
          </div>
          <button className="p-1.5 rounded-lg text-gray-500 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <MoreVertical className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mt-3 line-clamp-2">
          {module.description}
        </p>
      </div>

      {/* Module Stats */}
      <div className="px-6 py-4 bg-gray-50 grid grid-cols-2 gap-4">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-gray-500" />
          <span className="text-sm text-gray-600">{module.assignedUsers} users</span>
        </div>
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-gray-500" />
          <span className="text-sm text-gray-500 truncate">{module.lastActivity}</span>
        </div>
      </div>

      {/* Usage Statistics */}
      {usageStats && (
        <div className="px-6 py-3 bg-tenant-50/50 border-t border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-3.5 h-3.5 text-tenant-500" />
            <span className="text-xs font-medium text-tenant-700 uppercase tracking-wider">
              Usage Stats
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-gray-500">Actions this month</p>
              <p className="text-sm font-semibold text-gray-900">
                {usageStats.actionsThisMonth.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">vs. last month</p>
              <div className="flex items-center gap-1">
                {usageStats.actionsThisMonth >= usageStats.actionsLastMonth ? (
                  <TrendingUp className="w-3.5 h-3.5 text-green-500" />
                ) : (
                  <TrendingUp className="w-3.5 h-3.5 text-red-500 rotate-180" />
                )}
                <p className="text-sm font-semibold text-gray-900">
                  {usageStats.actionsLastMonth > 0
                    ? `${((usageStats.actionsThisMonth / usageStats.actionsLastMonth - 1) * 100).toFixed(0)}%`
                    : 'N/A'}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manager Section */}
      <div className="p-4 border-t border-gray-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-gray-500" />
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              Module Manager
            </span>
          </div>
        </div>

        {module.manager ? (
          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white text-xs font-medium">
                {module.manager.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .substring(0, 2)
                  .toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">{module.manager.name}</p>
                <p className="text-xs text-gray-500">{module.manager.email}</p>
              </div>
            </div>
            <button
              onClick={() => onAssignManager(module)}
              className="text-xs text-tenant-600 hover:text-tenant-700 font-medium"
            >
              Change
            </button>
          </div>
        ) : (
          <button
            onClick={() => onAssignManager(module)}
            className="mt-3 w-full flex items-center justify-center gap-2 py-2 rounded-lg border-2 border-dashed border-gray-200 text-sm text-gray-500 hover:border-tenant-300 hover:text-tenant-600 transition-colors"
          >
            <UserPlus className="w-4 h-4" />
            Assign Manager
          </button>
        )}
      </div>

      {/* Features */}
      <div className="px-4 pb-4">
        <div className="flex flex-wrap gap-1">
          {module.features.slice(0, 3).map((feature, idx) => (
            <span
              key={idx}
              className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600"
            >
              {feature}
            </span>
          ))}
          {module.features.length > 3 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500">
              +{module.features.length - 3}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="px-4 pb-4 flex items-center gap-2">
        <button
          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-tenant-600 bg-tenant-50 rounded-lg hover:bg-tenant-100 transition-colors"
          onClick={() => onViewDetails(module)}
        >
          <BarChart3 className="w-4 h-4" />
          View Details
        </button>
        {canOpen ? (
          <button
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors"
            onClick={() => onOpenModule(module)}
            title={`${module.name} Dashboard'a git`}
          >
            <ExternalLink className="w-4 h-4" />
          </button>
        ) : (
          <button
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-500 bg-gray-100 rounded-lg cursor-not-allowed"
            disabled
            title={module.status !== 'active' ? 'Module is not active' : 'Dashboard not available'}
          >
            <ExternalLink className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};

export default ModuleCard;
