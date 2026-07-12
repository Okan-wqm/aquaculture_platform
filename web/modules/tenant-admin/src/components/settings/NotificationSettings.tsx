import React, { useState, useEffect, useCallback } from 'react';
import { Save, RefreshCw, Info } from 'lucide-react';
import { useToast } from '@aquaculture/shared-ui';
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from '../../hooks/useTenantData';
import { logError, createErrorToastOptions } from '../../utils/error-handling';
import { Toggle } from './Toggle';

/**
 * NotificationSettings -- channel toggles, category toggles, quiet hours.
 *
 * FIX HIGH-08: Uses TanStack Query optimistic updates to avoid notification
 * overwrite race condition. The mutation now uses `onMutate` to optimistically
 * update the cache and `onError` to rollback, preventing stale reads from
 * overwriting concurrent saves.
 */
const NotificationSettings: React.FC = () => {
  const { data: notifData, isLoading } = useNotificationPreferences(true);
  const updateNotifPrefsMutation = useUpdateNotificationPreferences();
  const { toast } = useToast();

  const [notifPrefs, setNotifPrefs] = useState({
    emailEnabled: true,
    smsEnabled: false,
    pushEnabled: false,
    quietHoursStart: '' as string,
    quietHoursEnd: '' as string,
    quietHoursTimezone: 'Europe/Istanbul',
    alertNotifications: true,
    taskNotifications: true,
    systemNotifications: true,
  });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (notifData) {
      setNotifPrefs({
        emailEnabled: notifData.emailEnabled,
        smsEnabled: notifData.smsEnabled,
        pushEnabled: notifData.pushEnabled,
        quietHoursStart: notifData.quietHoursStart || '',
        quietHoursEnd: notifData.quietHoursEnd || '',
        quietHoursTimezone: notifData.quietHoursTimezone || 'Europe/Istanbul',
        alertNotifications: notifData.alertNotifications,
        taskNotifications: notifData.taskNotifications,
        systemNotifications: notifData.systemNotifications,
      });
      setDirty(false);
    }
  }, [notifData]);

  const updatePref = <K extends keyof typeof notifPrefs>(key: K, value: (typeof notifPrefs)[K]) => {
    setNotifPrefs((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const handleSave = useCallback(async () => {
    try {
      await updateNotifPrefsMutation.mutateAsync({
        emailEnabled: notifPrefs.emailEnabled,
        smsEnabled: notifPrefs.smsEnabled,
        pushEnabled: notifPrefs.pushEnabled,
        quietHoursStart: notifPrefs.quietHoursStart || undefined,
        quietHoursEnd: notifPrefs.quietHoursEnd || undefined,
        quietHoursTimezone: notifPrefs.quietHoursTimezone,
        alertNotifications: notifPrefs.alertNotifications,
        taskNotifications: notifPrefs.taskNotifications,
        systemNotifications: notifPrefs.systemNotifications,
      });
      setDirty(false);
      toast({ variant: 'success', title: 'Settings saved' });
    } catch (err) {
      logError('NotificationSettings.handleSave', err);
      toast(createErrorToastOptions(err));
    }
  }, [notifPrefs, updateNotifPrefsMutation, toast]);

  const saving = updateNotifPrefsMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 animate-spin text-tenant-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Channel toggles */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">Channels</h3>
        <div className="divide-y divide-gray-100">
          <Toggle
            enabled={notifPrefs.emailEnabled}
            onChange={(v) => updatePref('emailEnabled', v)}
            label="Email Notifications"
            description="Receive important updates via email"
          />
          <Toggle
            enabled={notifPrefs.smsEnabled}
            onChange={(v) => updatePref('smsEnabled', v)}
            label="SMS Notifications"
            description="Receive critical alerts via text message"
          />
          <Toggle
            enabled={notifPrefs.pushEnabled}
            onChange={(v) => updatePref('pushEnabled', v)}
            label="Push Notifications"
            description="Receive push notifications on your devices"
          />
        </div>
      </div>

      {/* Category toggles */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">Categories</h3>
        <div className="divide-y divide-gray-100">
          <Toggle
            enabled={notifPrefs.alertNotifications}
            onChange={(v) => updatePref('alertNotifications', v)}
            label="Alert Notifications"
            description="Sensor threshold breaches and critical alerts"
          />
          <Toggle
            enabled={notifPrefs.taskNotifications}
            onChange={(v) => updatePref('taskNotifications', v)}
            label="Task Notifications"
            description="Task assignments, updates, and reminders"
          />
          <Toggle
            enabled={notifPrefs.systemNotifications}
            onChange={(v) => updatePref('systemNotifications', v)}
            label="System Notifications"
            description="System updates, maintenance notices, and reports"
          />
        </div>
      </div>

      {/* Quiet hours */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">Quiet Hours</h3>
        <p className="text-xs text-gray-500 mb-3">
          Suppress non-critical notifications during specified hours. Critical alerts are always delivered.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
            <input
              type="time"
              value={notifPrefs.quietHoursStart}
              onChange={(e) => updatePref('quietHoursStart', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Time</label>
            <input
              type="time"
              value={notifPrefs.quietHoursEnd}
              onChange={(e) => updatePref('quietHoursEnd', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
            <select
              value={notifPrefs.quietHoursTimezone}
              onChange={(e) => updatePref('quietHoursTimezone', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
            >
              <option value="Europe/Istanbul">Europe/Istanbul (UTC+3)</option>
              <option value="UTC">UTC</option>
              <option value="America/New_York">America/New York (UTC-5)</option>
              <option value="America/Los_Angeles">America/Los Angeles (UTC-8)</option>
              <option value="Asia/Tokyo">Asia/Tokyo (UTC+9)</option>
              <option value="Europe/London">Europe/London (UTC+0/+1)</option>
              <option value="Europe/Berlin">Europe/Berlin (UTC+1/+2)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Dirty indicator + Save */}
      <div className="flex items-center justify-between">
        {dirty && (
          <div className="flex items-center gap-2 text-sm text-tenant-600">
            <Info className="w-4 h-4" />
            <span>You have unsaved changes</span>
          </div>
        )}
        <div className="flex items-center gap-3 ml-auto">
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Changes
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NotificationSettings;
