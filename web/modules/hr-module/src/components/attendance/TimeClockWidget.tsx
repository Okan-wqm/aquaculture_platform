/**
 * Time Clock Widget Component
 * Allows employees to clock in/out with optional location tracking.
 *
 * SEC-004: GPS location is opt-in, not opt-out.
 *   - enableGps defaults to false.
 *   - The employee must explicitly consent to GPS before each session.
 *   - A consent banner is shown when enableGps is true; the employee can
 *     decline and still clock in/out without any location data being sent.
 */

import React, { useState, useEffect } from 'react';
import { Clock, LogIn, LogOut, MapPin, AlertCircle, ShieldCheck } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { useClockIn, useClockOut, useTodaysAttendance } from '../../hooks';
import { ClockMethod, AttendanceStatus, ATTENDANCE_STATUS_CONFIG } from '../../types';
import { StatusBadge } from '../common/StatusBadge';

interface TimeClockWidgetProps {
  employeeId: string;
  className?: string;
  /**
   * SEC-004: Defaults to false. Even when true, the employee must actively
   * consent before location is captured — they can always proceed without GPS.
   */
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
  enableGps = false, // SEC-004: opt-in, not opt-out
}: TimeClockWidgetProps) {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [location, setLocation] = useState<GeoPosition | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isGettingLocation, setIsGettingLocation] = useState(false);
  // SEC-004: track whether the employee has actively consented to GPS for this session
  const [gpsConsented, setGpsConsented] = useState<boolean | null>(null);

  const { data: todayRecords, isLoading } = useTodaysAttendance();
  const clockInMutation = useClockIn();
  const clockOutMutation = useClockOut();

  // Get current employee's record
  const todayRecord = todayRecords?.find((r) => r.employeeId === employeeId);
  const isClockedIn = todayRecord?.clockIn && !todayRecord?.clockOut;

  // Update time every second
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // SEC-004: Only capture location when GPS is enabled AND the employee has
  // explicitly consented for this session. If they decline, resolve null so
  // clock-in/out still proceeds without location data.
  const getLocation = async (): Promise<GeoPosition | null> => {
    if (!enableGps || gpsConsented !== true || !navigator.geolocation) return null;

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
                {todayRecord.clockIn
                  ? new Date(todayRecord.clockIn).toLocaleTimeString()
                  : '-'}
              </p>
            </div>
            <div>
              <span className="text-gray-500">Clock Out</span>
              <p className="font-medium text-gray-900 dark:text-white">
                {todayRecord.clockOut
                  ? new Date(todayRecord.clockOut).toLocaleTimeString()
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

      {/* SEC-004: GPS consent banner — shown only when the feature is enabled
           and the employee has not yet made a decision for this session. */}
      {enableGps && gpsConsented === null && (
        <div className="border-t border-blue-100 bg-blue-50 px-4 py-3 dark:border-blue-900/40 dark:bg-blue-900/20">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
            <div className="flex-1 text-sm">
              <p className="font-medium text-blue-800 dark:text-blue-200">
                Location permission request
              </p>
              <p className="mt-0.5 text-blue-700 dark:text-blue-300">
                This site would like to record your GPS coordinates when you clock
                in or out. Location data is stored securely and used only for
                attendance verification. You can decline and still clock in/out
                without sharing your location.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => setGpsConsented(true)}
                  className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Allow location
                </button>
                <button
                  onClick={() => setGpsConsented(false)}
                  className="rounded-md bg-white px-3 py-1 text-xs font-medium text-blue-700 ring-1 ring-blue-300 hover:bg-blue-50 dark:bg-transparent dark:text-blue-300 dark:ring-blue-700"
                >
                  Decline
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* GPS status (only after decision) */}
      {enableGps && gpsConsented !== null && (
        <div className="border-t border-gray-200 px-4 py-2 dark:border-gray-700">
          <div className="flex items-center gap-2 text-sm">
            <MapPin className="h-4 w-4 text-gray-400" />
            {gpsConsented === false ? (
              <span className="text-gray-400">Location sharing declined</span>
            ) : isGettingLocation ? (
              <span className="text-gray-500">Getting location...</span>
            ) : gpsError ? (
              <span className="text-red-500">{gpsError}</span>
            ) : location ? (
              <span className="text-green-600">Location captured</span>
            ) : (
              <span className="text-gray-500">Location will be captured on clock action</span>
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
