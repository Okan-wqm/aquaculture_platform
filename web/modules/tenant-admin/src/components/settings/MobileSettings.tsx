import React, { useState, useEffect, useCallback } from 'react';
import {
  Smartphone,
  Save,
  RefreshCw,
  AlertCircle,
  Info,
} from 'lucide-react';
import { useToast } from '@aquaculture/shared-ui';
import {
  useMobileUsersData,
  useUpdateMobileUserSettings,
} from '../../hooks/useTenantData';
import type { MobileUserSettingsData } from '../../hooks/useTenantData';
import { logError, createErrorToastOptions } from '../../utils/error-handling';
import { SmallToggle } from './Toggle';

/** Feature columns rendered in the table header. */
const FEATURE_COLUMNS = [
  { key: 'mortality' as const, label: 'Mortality' },
  { key: 'cull' as const, label: 'Cull' },
  { key: 'harvest' as const, label: 'Harvest' },
  { key: 'tankView' as const, label: 'Tank View' },
] as const;

const DEFAULT_ALLOWED_FEATURES: MobileUserSettingsData['allowedFeatures'] = {
  mortality: true,
  cull: true,
  harvest: true,
  feeding: false,
  waterQuality: false,
  tankView: true,
};

const createDefaultUserSettings = (userId: string): MobileUserSettingsData => ({
  id: '',
  userId,
  tenantId: '',
  isMobileEnabled: true,
  allowedFeatures: { ...DEFAULT_ALLOWED_FEATURES },
});

/**
 * MobileSettings -- mobile user feature toggles table with bulk actions.
 */
const MobileSettings: React.FC = () => {
  const {
    data: mobileData,
    isLoading,
    error: mobileQueryError,
  } = useMobileUsersData(true);
  const updateMobileSettingsMutation = useUpdateMobileUserSettings();
  const { toast } = useToast();

  const mobileUsers = mobileData?.users ?? [];
  const [mobileSettings, setMobileSettings] = useState<Map<string, MobileUserSettingsData>>(new Map());
  const mobileError = mobileQueryError ? (mobileQueryError as Error).message : null;
  const mobileSaving = updateMobileSettingsMutation.isPending;
  const [dirtyUserIds, setDirtyUserIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (mobileData?.settings) {
      setMobileSettings(mobileData.settings);
      setDirtyUserIds(new Set());
    }
  }, [mobileData?.settings]);

  const getUserSettings = useCallback(
    (userId: string): MobileUserSettingsData =>
      mobileSettings.get(userId) ?? createDefaultUserSettings(userId),
    [mobileSettings],
  );

  const updateUserMobileSetting = useCallback(
    (
      userId: string,
      field: 'isMobileEnabled' | keyof MobileUserSettingsData['allowedFeatures'],
      value: boolean,
    ) => {
      const current = getUserSettings(userId);
      let updated: MobileUserSettingsData;

      if (field === 'isMobileEnabled') {
        updated = { ...current, isMobileEnabled: value };
      } else {
        updated = {
          ...current,
          allowedFeatures: { ...current.allowedFeatures, [field]: value },
        };
      }

      setMobileSettings((prev) => {
        const next = new Map(prev);
        next.set(userId, updated);
        return next;
      });
      setDirtyUserIds((prev) => new Set(prev).add(userId));
    },
    [getUserSettings],
  );

  const saveMobileSettings = useCallback(async () => {
    try {
      await Promise.all(
        Array.from(dirtyUserIds).map((userId) => {
          const settings = getUserSettings(userId);
          return updateMobileSettingsMutation.mutateAsync({
            userId,
            isMobileEnabled: settings.isMobileEnabled,
            mortality: settings.allowedFeatures.mortality,
            cull: settings.allowedFeatures.cull,
            harvest: settings.allowedFeatures.harvest,
            feeding: settings.allowedFeatures.feeding,
            waterQuality: settings.allowedFeatures.waterQuality,
            tankView: settings.allowedFeatures.tankView,
          });
        }),
      );
      setDirtyUserIds(new Set());
      toast({ variant: 'success', title: 'Settings saved' });
    } catch (err) {
      logError('MobileSettings.saveMobileSettings', err);
      toast(createErrorToastOptions(err));
    }
  }, [dirtyUserIds, getUserSettings, updateMobileSettingsMutation, toast]);

  const applyToAll = useCallback((field: 'isMobileEnabled' | keyof MobileUserSettingsData['allowedFeatures'], value: boolean) => {
    for (const user of mobileUsers) {
      updateUserMobileSetting(user.id, field, value);
    }
  }, [mobileUsers, updateUserMobileSetting]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 animate-spin text-tenant-600" />
      </div>
    );
  }

  if (mobileError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-red-800">Failed to load mobile settings</p>
          <p className="text-sm text-red-600">{mobileError}</p>
        </div>
      </div>
    );
  }

  if (mobileUsers.length === 0) {
    return (
      <div className="py-12 text-center">
        <Smartphone className="w-12 h-12 text-gray-500 mx-auto" />
        <h3 className="mt-4 text-sm font-medium text-gray-900">No users found</h3>
        <p className="mt-1 text-sm text-gray-500">
          Add users to your tenant first to configure mobile access.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Bulk actions */}
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span>Apply to all:</span>
        <button
          onClick={() => applyToAll('isMobileEnabled', true)}
          className="px-2 py-1 bg-green-50 text-green-700 rounded hover:bg-green-100 transition-colors"
        >
          Enable All
        </button>
        <button
          onClick={() => applyToAll('isMobileEnabled', false)}
          className="px-2 py-1 bg-red-50 text-red-700 rounded hover:bg-red-100 transition-colors"
        >
          Disable All
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                User
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                Mobile
              </th>
              {FEATURE_COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {mobileUsers.map((user) => {
              const settings = getUserSettings(user.id);
              const name =
                `${user.firstName || ''} ${user.lastName || ''}`.trim() ||
                user.email.split('@')[0];
              const isDirty = dirtyUserIds.has(user.id);

              return (
                <tr
                  key={user.id}
                  className={`hover:bg-gray-50 transition-colors ${isDirty ? 'bg-tenant-50/30' : ''}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white text-xs font-medium">
                        {name
                          .split(' ')
                          .map((n) => n[0])
                          .join('')
                          .toUpperCase()
                          .slice(0, 2)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{name}</p>
                        <p className="text-xs text-gray-500">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <SmallToggle
                      enabled={settings.isMobileEnabled}
                      onChange={(v) => updateUserMobileSetting(user.id, 'isMobileEnabled', v)}
                    />
                  </td>
                  {FEATURE_COLUMNS.map((col) => (
                    <td key={col.key} className="px-4 py-3 text-center">
                      <SmallToggle
                        enabled={settings.allowedFeatures[col.key]}
                        onChange={(v) => updateUserMobileSetting(user.id, col.key, v)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Dirty indicator + Save */}
      <div className="flex items-center justify-between">
        {dirtyUserIds.size > 0 && (
          <div className="flex items-center gap-2 text-sm text-tenant-600">
            <Info className="w-4 h-4" />
            <span>{dirtyUserIds.size} user(s) have unsaved changes</span>
          </div>
        )}
        <button
          onClick={saveMobileSettings}
          disabled={mobileSaving || dirtyUserIds.size === 0}
          className="ml-auto inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {mobileSaving ? (
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
  );
};

export default MobileSettings;
