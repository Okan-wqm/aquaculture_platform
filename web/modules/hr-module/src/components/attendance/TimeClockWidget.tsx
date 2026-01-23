/**
 * Time Clock Widget Component
 * Allows employees to clock in/out with location tracking
 */

import React, { useState, useEffect } from 'react';
import { Clock, LogIn, LogOut, MapPin, AlertCircle } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { useClockIn, useClockOut, useTodaysAttendance } from '../../hooks';
import { ClockMethod, AttendanceStatus, ATTENDANCE_STATUS_CONFIG } from '../../types';
import { StatusBadge } from '../common/StatusBadge';

interface TimeClockWidgetProps {
  employeeId: string;
  className?: string;
  enableGps?: boolean;
}

interface GeoPosition {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export function TimeClockWidget({
  employeeId,
  className,
  enableGps = true,
}: TimeClockWidgetProps) {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [location, setLocation] = useState<GeoPosition | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isGettingLocation, setIsGettingLocation] = useState(false);

  const { data: todayRecords, isLoading } = useTodaysAttendance();
  const clockInMutation = useClockIn();
  const clockOutMutation = useClockOut();

  // Get current employee's record
  const todayRecord = todayRecords?.find((r) => r.employeeId === employeeId);
  const isClockedIn = todayRecord?.clockInTime && !todayRecord?.clockOutTime;

  // Update time every second
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Get GPS location
  const getLocation = async (): Promise<GeoPosition | null> => {
    if (!enableGps || !navigator.geolocation) return null;

    setIsGettingLocation(true);
    setGpsError(null);

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const pos = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          };
          setLocation(pos);
          setIsGettingLocation(false);
          resolve(pos);
        },
        (error) => {
          setGpsError(error.message);
          setIsGettingLocation(false);
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  };

  const handleClockIn = async () => {
    const loc = await getLocation();
    clockInMutation.mutate({
      employeeId,
      method: ClockMethod.WEB,
      location: loc || undefined,
    });
  };

  const handleClockOut = async () => {
    const loc = await getLocation();
    clockOutMutation.mutate({
      employeeId,
      method: ClockMethod.WEB,
      location: loc || undefined,
    });
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const isProcessing = clockInMutation.isPending || clockOutMutation.isPending || isGettingLocation;

  return (
    <div
      className={cn(
        'rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800',
        className
      )}
    >
      {/* Header */}
      <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-indigo-600" />
          <h3 className="font-semibold text-gray-900 dark:text-white">Time Clock</h3>
        </div>
      </div>

      {/* Current Time */}
      <div className="p-6 text-center">
        <div className="text-4xl font-bold text-gray-900 dark:text-white">
          {formatTime(currentTime)}
        </div>
        <div className="mt-1 text-sm text-gray-500">{formatDate(currentTime)}</div>
      </div>

      {/* Today's Status */}
      {todayRecord && (
        <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Today's Status</span>
            <StatusBadge
              label={ATTENDANCE_STATUS_CONFIG[todayRecord.status].label}
              variant={ATTENDANCE_STATUS_CONFIG[todayRecord.status].variant}
              size="sm"
            />
          </div>

          <div className="mt-2 grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Clock In</span>
              <p className="font-medium text-gray-900 dark:text-white">
                {todayRecord.clockInTime
                  ? new Date(todayRecord.clockInTime).toLocaleTimeString()
                  : '-'}
              </p>
            </div>
            <div>
              <span className="text-gray-500">Clock Out</span>
              <p className="font-medium text-gray-900 dark:text-white">
                {todayRecord.clockOutTime
                  ? new Date(todayRecord.clockOutTime).toLocaleTimeString()
                  : '-'}
              </p>
            </div>
          </div>

          {todayRecord.workedMinutes > 0 && (
            <div className="mt-2">
              <span className="text-sm text-gray-500">Worked Time</span>
              <p className="font-medium text-gray-900 dark:text-white">
                {Math.floor(todayRecord.workedMinutes / 60)}h {todayRecord.workedMinutes % 60}m
              </p>
            </div>
          )}
        </div>
      )}

      {/* GPS Status */}
      {enableGps && (
        <div className="border-t border-gray-200 px-4 py-2 dark:border-gray-700">
          <div className="flex items-center gap-2 text-sm">
            <MapPin className="h-4 w-4 text-gray-400" />
            {isGettingLocation ? (
              <span className="text-gray-500">Getting location...</span>
            ) : gpsError ? (
              <span className="text-red-500">{gpsError}</span>
            ) : location ? (
              <span className="text-green-600">Location captured</span>
            ) : (
              <span className="text-gray-500">GPS location will be captured</span>
            )}
          </div>
        </div>
      )}

      {/* Action Button */}
      <div className="p-4">
        {isClockedIn ? (
          <button
            onClick={handleClockOut}
            disabled={isProcessing}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 font-medium transition-colors',
              'bg-red-600 text-white hover:bg-red-700',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            {isProcessing ? (
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              <LogOut className="h-5 w-5" />
            )}
            Clock Out
          </button>
        ) : (
          <button
            onClick={handleClockIn}
            disabled={isProcessing}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 font-medium transition-colors',
              'bg-green-600 text-white hover:bg-green-700',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            {isProcessing ? (
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              <LogIn className="h-5 w-5" />
            )}
            Clock In
          </button>
        )}
      </div>

      {/* Error Display */}
      {(clockInMutation.error || clockOutMutation.error) && (
        <div className="border-t border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-900/20">
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4" />
            {clockInMutation.error?.message || clockOutMutation.error?.message}
          </div>
        </div>
      )}
    </div>
  );
}

export default TimeClockWidget;
