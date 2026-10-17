/**
 * Sea/Land Split View Component
 * Visual representation of offshore vs onshore personnel
 */

import React from 'react';
import { Ship, Building2, Plane, Calendar, Users } from 'lucide-react';
import { cn, Spinner, useI18n } from '@aquaculture/shared-ui';
import { useSeaLandSplit, useOffshoreHeadcount } from '../../hooks';
import { EmployeeAvatar } from '../common/EmployeeAvatar';
import { CREW_LOCATIONS, CREW_LOCATION_TONE, type CrewLocation } from './crewLocationTone';

interface SeaLandSplitViewProps {
  departmentId?: string;
  className?: string;
  variant?: 'full' | 'compact' | 'summary';
}

interface CrewSectionProps {
  title: string;
  icon: React.ReactNode;
  count: number;
  employees?: {
    id: string;
    firstName: string;
    lastName: string;
    avatarUrl?: string;
    currentWorkArea?: string;
    destination?: string;
  }[];
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
                  <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                    {emp.currentWorkArea}
                  </p>
                )}
                {emp.destination && (
                  <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                    To: {emp.destination}
                  </p>
                )}
              </div>
            </div>
          ))}
          {remainingCount > 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">+{remainingCount} more</p>
          )}
        </div>
      )}
    </div>
  );
}

type SplitData = NonNullable<ReturnType<typeof useSeaLandSplit>['data']>;

/** Each crew location's head count, in bar order. */
function locationCounts(data: SplitData): { location: CrewLocation; count: number }[] {
  const counts: Record<CrewLocation, number> = {
    offshore: data.offshore.count,
    onshore: data.onshore.count,
    transit: data.inTransit.count,
    leave: data.onLeave.count,
  };
  return CREW_LOCATIONS.map((location) => ({ location, count: counts[location] }));
}

/**
 * The split as one bar and its legend. The four fills differ in lightness
 * only in the Company workspace (crewLocationTone), so each segment is an
 * image named "<location>: <count>" and the bar a named group: the location
 * is never carried by colour alone.
 */
function SummaryView({ data }: { data: SplitData | undefined }): React.JSX.Element | null {
  const { t } = useI18n();
  if (!data) return null;

  const counts = locationCounts(data);
  const total = counts.reduce((sum, { count }) => sum + count, 0);
  const name = (location: CrewLocation, count: number): string =>
    t('hr.crew.split.segment', { location: t(CREW_LOCATION_TONE[location].label), count });

  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label={t('hr.crew.split.label')}
        className="flex h-4 overflow-hidden rounded-sm bg-gray-200 dark:bg-gray-700"
      >
        {counts
          .filter(({ count }) => count > 0)
          .map(({ location, count }) => (
            <div
              key={location}
              role="img"
              aria-label={name(location, count)}
              title={name(location, count)}
              className={cn(
                CREW_LOCATION_TONE[location].fill,
                'transition-all motion-reduce:transition-none',
              )}
              style={{ width: `${(count / total) * 100}%` }}
            />
          ))}
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        {counts.map(({ location, count }) => (
          <div key={location} className="flex items-center gap-2">
            <div
              aria-hidden="true"
              className={cn('h-3 w-3 rounded-full', CREW_LOCATION_TONE[location].fill)}
            />
            <span className="text-gray-600 dark:text-gray-400">{name(location, count)}</span>
          </div>
        ))}
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
      <div
        className={cn(
          'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800',
          className,
        )}
      >
        <div className="flex items-center justify-center py-8">
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        className={cn(
          'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800',
          className,
        )}
      >
        <p className="text-center text-sm text-gray-500 dark:text-gray-400">
          Failed to load crew data
        </p>
      </div>
    );
  }

  const total =
    data.offshore.count + data.onshore.count + data.inTransit.count + data.onLeave.count;

  return (
    <div
      className={cn(
        'rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          <h3 className="font-semibold text-gray-900 dark:text-white">Crew Distribution</h3>
        </div>
        <span className="text-sm text-gray-500 dark:text-gray-400">{total} total personnel</span>
      </div>

      <div className="p-4">
        {variant === 'summary' ? (
          <SummaryView data={data} />
        ) : variant === 'compact' ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="text-center">
              <div className="flex items-center justify-center">
                <Ship className={cn('h-5 w-5', CREW_LOCATION_TONE.offshore.icon)} />
              </div>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {data.offshore.count}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Offshore</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center">
                <Building2 className={cn('h-5 w-5', CREW_LOCATION_TONE.onshore.icon)} />
              </div>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {data.onshore.count}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Onshore</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center">
                <Plane className={cn('h-5 w-5', CREW_LOCATION_TONE.transit.icon)} />
              </div>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {data.inTransit.count}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">In Transit</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center">
                <Calendar className={cn('h-5 w-5', CREW_LOCATION_TONE.leave.icon)} />
              </div>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {data.onLeave.count}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">On Leave</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <CrewSection
              title="Offshore"
              icon={<Ship className={cn('h-4 w-4', CREW_LOCATION_TONE.offshore.onFill)} />}
              count={data.offshore.count}
              employees={data.offshore.employees}
              color={CREW_LOCATION_TONE.offshore.fill}
              bgColor={CREW_LOCATION_TONE.offshore.tint}
            />
            <CrewSection
              title="Onshore"
              icon={<Building2 className={cn('h-4 w-4', CREW_LOCATION_TONE.onshore.onFill)} />}
              count={data.onshore.count}
              employees={data.onshore.employees}
              color={CREW_LOCATION_TONE.onshore.fill}
              bgColor={CREW_LOCATION_TONE.onshore.tint}
            />
            <CrewSection
              title="In Transit"
              icon={<Plane className={cn('h-4 w-4', CREW_LOCATION_TONE.transit.onFill)} />}
              count={data.inTransit.count}
              employees={data.inTransit.employees}
              color={CREW_LOCATION_TONE.transit.fill}
              bgColor={CREW_LOCATION_TONE.transit.tint}
            />
            <CrewSection
              title="On Leave"
              icon={<Calendar className={cn('h-4 w-4', CREW_LOCATION_TONE.leave.onFill)} />}
              count={data.onLeave.count}
              employees={data.onLeave.employees}
              color={CREW_LOCATION_TONE.leave.fill}
              bgColor={CREW_LOCATION_TONE.leave.tint}
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
                const occupancyPercent =
                  area.maxCapacity > 0 ? (area.count / area.maxCapacity) * 100 : 0;
                return (
                  <div key={area.workAreaId} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-600 dark:text-gray-400">
                      {area.workAreaName}
                    </span>
                    <div className="h-2 w-24 overflow-hidden rounded-sm bg-gray-200 dark:bg-gray-700">
                      <div
                        className={cn(
                          'h-full transition-all',
                          occupancyPercent > 90
                            ? 'bg-error-500'
                            : occupancyPercent > 70
                              ? 'bg-warning-500'
                              : 'bg-info-500',
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
