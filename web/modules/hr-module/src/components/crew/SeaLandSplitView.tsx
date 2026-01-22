/**
 * Sea/Land Split View Component
 * Visual representation of offshore vs onshore personnel
 */

import React from 'react';
import { Ship, Building2, Plane, Calendar, Users } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { useSeaLandSplit, useOffshoreHeadcount } from '../../hooks';
import { EmployeeAvatar } from '../common/EmployeeAvatar';

interface SeaLandSplitViewProps {
  departmentId?: string;
  className?: string;
  variant?: 'full' | 'compact' | 'summary';
}

interface CrewSectionProps {
  title: string;
  icon: React.ReactNode;
  count: number;
  employees?: { id: string; firstName: string; lastName: string; avatarUrl?: string; currentWorkArea?: string; destination?: string }[];
  color: string;
  bgColor: string;
  maxDisplay?: number;
}

function CrewSection({
  title,
  icon,
  count,
  employees,
  color,
  bgColor,
  maxDisplay = 5,
}: CrewSectionProps) {
  const displayedEmployees = employees?.slice(0, maxDisplay) || [];
  const remainingCount = (employees?.length || 0) - maxDisplay;

  return (
    <div className={cn('rounded-lg p-4', bgColor)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', color)}>
            {icon}
          </div>
          <span className="font-medium text-gray-900 dark:text-white">{title}</span>
        </div>
        <span className="text-2xl font-bold text-gray-900 dark:text-white">{count}</span>
      </div>

      {displayedEmployees.length > 0 && (
        <div className="mt-3 space-y-2">
          {displayedEmployees.map((emp) => (
            <div key={emp.id} className="flex items-center gap-2">
              <EmployeeAvatar
                firstName={emp.firstName}
                lastName={emp.lastName}
                avatarUrl={emp.avatarUrl}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                  {emp.firstName} {emp.lastName}
                </p>
                {emp.currentWorkArea && (
                  <p className="truncate text-xs text-gray-500">{emp.currentWorkArea}</p>
                )}
                {emp.destination && (
                  <p className="truncate text-xs text-gray-500">To: {emp.destination}</p>
                )}
              </div>
            </div>
          ))}
          {remainingCount > 0 && (
            <p className="text-sm text-gray-500">+{remainingCount} more</p>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryView({ data }: { data: ReturnType<typeof useSeaLandSplit>['data'] }) {
  if (!data) return null;

  const total = data.offshore.count + data.onshore.count + data.inTransit.count + data.onLeave.count;
  const offshorePercent = total > 0 ? (data.offshore.count / total) * 100 : 0;
  const onshorePercent = total > 0 ? (data.onshore.count / total) * 100 : 0;
  const transitPercent = total > 0 ? (data.inTransit.count / total) * 100 : 0;
  const leavePercent = total > 0 ? (data.onLeave.count / total) * 100 : 0;

  return (
    <div className="space-y-3">
      <div className="flex h-4 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        {offshorePercent > 0 && (
          <div
            className="bg-blue-500 transition-all"
            style={{ width: `${offshorePercent}%` }}
            title={`Offshore: ${data.offshore.count}`}
          />
        )}
        {onshorePercent > 0 && (
          <div
            className="bg-green-500 transition-all"
            style={{ width: `${onshorePercent}%` }}
            title={`Onshore: ${data.onshore.count}`}
          />
        )}
        {transitPercent > 0 && (
          <div
            className="bg-yellow-500 transition-all"
            style={{ width: `${transitPercent}%` }}
            title={`In Transit: ${data.inTransit.count}`}
          />
        )}
        {leavePercent > 0 && (
          <div
            className="bg-gray-400 transition-all"
            style={{ width: `${leavePercent}%` }}
            title={`On Leave: ${data.onLeave.count}`}
          />
        )}
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-blue-500" />
          <span className="text-gray-600 dark:text-gray-400">Offshore: {data.offshore.count}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-green-500" />
          <span className="text-gray-600 dark:text-gray-400">Onshore: {data.onshore.count}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-yellow-500" />
          <span className="text-gray-600 dark:text-gray-400">In Transit: {data.inTransit.count}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-gray-400" />
          <span className="text-gray-600 dark:text-gray-400">On Leave: {data.onLeave.count}</span>
        </div>
      </div>
    </div>
  );
}

export function SeaLandSplitView({
  departmentId,
  className,
  variant = 'full',
}: SeaLandSplitViewProps) {
  const { data, isLoading, error } = useSeaLandSplit(departmentId);
  const { data: headcount } = useOffshoreHeadcount();

  if (isLoading) {
    return (
      <div className={cn('rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800', className)}>
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-600" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={cn('rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800', className)}>
        <p className="text-center text-sm text-gray-500">Failed to load crew data</p>
      </div>
    );
  }

  const total = data.offshore.count + data.onshore.count + data.inTransit.count + data.onLeave.count;

  return (
    <div className={cn('rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800', className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-indigo-600" />
          <h3 className="font-semibold text-gray-900 dark:text-white">Crew Distribution</h3>
        </div>
        <span className="text-sm text-gray-500">{total} total personnel</span>
      </div>

      <div className="p-4">
        {variant === 'summary' ? (
          <SummaryView data={data} />
        ) : variant === 'compact' ? (
          <div className="grid grid-cols-4 gap-3">
            <div className="text-center">
              <div className="flex items-center justify-center">
                <Ship className="h-5 w-5 text-blue-500" />
              </div>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {data.offshore.count}
              </p>
              <p className="text-xs text-gray-500">Offshore</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center">
                <Building2 className="h-5 w-5 text-green-500" />
              </div>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {data.onshore.count}
              </p>
              <p className="text-xs text-gray-500">Onshore</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center">
                <Plane className="h-5 w-5 text-yellow-500" />
              </div>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {data.inTransit.count}
              </p>
              <p className="text-xs text-gray-500">In Transit</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center">
                <Calendar className="h-5 w-5 text-gray-400" />
              </div>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {data.onLeave.count}
              </p>
              <p className="text-xs text-gray-500">On Leave</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <CrewSection
              title="Offshore"
              icon={<Ship className="h-4 w-4 text-white" />}
              count={data.offshore.count}
              employees={data.offshore.employees}
              color="bg-blue-500"
              bgColor="bg-blue-50 dark:bg-blue-900/20"
            />
            <CrewSection
              title="Onshore"
              icon={<Building2 className="h-4 w-4 text-white" />}
              count={data.onshore.count}
              employees={data.onshore.employees}
              color="bg-green-500"
              bgColor="bg-green-50 dark:bg-green-900/20"
            />
            <CrewSection
              title="In Transit"
              icon={<Plane className="h-4 w-4 text-white" />}
              count={data.inTransit.count}
              employees={data.inTransit.employees}
              color="bg-yellow-500"
              bgColor="bg-yellow-50 dark:bg-yellow-900/20"
            />
            <CrewSection
              title="On Leave"
              icon={<Calendar className="h-4 w-4 text-white" />}
              count={data.onLeave.count}
              employees={data.onLeave.employees}
              color="bg-gray-400"
              bgColor="bg-gray-50 dark:bg-gray-900/20"
            />
          </div>
        )}

        {/* Offshore Work Areas Breakdown */}
        {headcount && headcount.byWorkArea.length > 0 && variant === 'full' && (
          <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
            <h4 className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-300">
              Offshore by Work Area
            </h4>
            <div className="space-y-2">
              {headcount.byWorkArea.map((area) => {
                const occupancyPercent = area.maxCapacity > 0
                  ? (area.count / area.maxCapacity) * 100
                  : 0;
                return (
                  <div key={area.workAreaId} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-600 dark:text-gray-400">
                      {area.workAreaName}
                    </span>
                    <div className="h-2 w-24 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                      <div
                        className={cn(
                          'h-full transition-all',
                          occupancyPercent > 90 ? 'bg-red-500' :
                          occupancyPercent > 70 ? 'bg-yellow-500' : 'bg-blue-500'
                        )}
                        style={{ width: `${Math.min(occupancyPercent, 100)}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {area.count}/{area.maxCapacity}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SeaLandSplitView;
