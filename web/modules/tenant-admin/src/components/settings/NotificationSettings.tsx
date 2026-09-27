import React, { useState, useEffect, useCallback } from 'react';
import { Button, Input, Select } from '@aquaculture/shared-ui';
import { Save, Check, RefreshCw, AlertCircle, Info } from 'lucide-react';
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from '../../hooks/useTenantData';
import { logError, sanitizeErrorMessage } from '../../utils/error-handling';
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
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    setSaveError(null);
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
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      logError('NotificationSettings.handleSave', err);
      setSaveError(sanitizeErrorMessage(err));
    }
  }, [notifPrefs, updateNotifPrefsMutation]);

  const saving = updateNotifPrefsMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 animate-spin text-success-600 dark:text-success-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Channel toggles */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-2">
          Channels
        </h3>
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
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
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-2">
          Categories
        </h3>
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
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
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-2">
          Quiet Hours
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Suppress non-critical notifications during specified hours. Critical alerts are always
          delivered.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Start Time
            </label>
            <Input
              fullWidth
              type="time"
              value={notifPrefs.quietHoursStart}
              onChange={(e) => updatePref('quietHoursStart', e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              End Time
            </label>
            <Input
              fullWidth
              type="time"
              value={notifPrefs.quietHoursEnd}
              onChange={(e) => updatePref('quietHoursEnd', e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Timezone
            </label>
            <Select
              fullWidth
              options={[
                { value: 'Europe/Istanbul', label: 'Europe/Istanbul (UTC+3)' },
                { value: 'UTC', label: 'UTC' },
                { value: 'America/New_York', label: 'America/New York (UTC-5)' },
                { value: 'America/Los_Angeles', label: 'America/Los Angeles (UTC-8)' },
                { value: 'Asia/Tokyo', label: 'Asia/Tokyo (UTC+9)' },
                { value: 'Europe/London', label: 'Europe/London (UTC+0/+1)' },
                { value: 'Europe/Berlin', label: 'Europe/Berlin (UTC+1/+2)' },
              ]}
              value={notifPrefs.quietHoursTimezone}
              onChange={(e) => updatePref('quietHoursTimezone', e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Dirty indicator + Save */}
      <div className="flex items-center justify-between">
        {dirty && (
          <div className="flex items-center gap-2 text-sm text-success-600 dark:text-success-400">
            <Info className="w-4 h-4" />
            <span>You have unsaved changes</span>
          </div>
        )}
        <div className="flex items-center gap-3 ml-auto">
          {saveError && (
            <p className="text-xs text-error-600 dark:text-error-400 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {saveError}
            </p>
          )}
          <Button variant="primary" onClick={handleSave} disabled={saving || !dirty}>
            {saved ? (
              <>
                <Check className="w-4 h-4" />
                Saved!
              </>
            ) : saving ? (
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
          </Button>
        </div>
      </div>
    </div>
  );
};

export default NotificationSettings;
