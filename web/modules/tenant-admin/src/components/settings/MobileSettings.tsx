import React, { useState, useEffect, useCallback } from 'react';
import { Smartphone, Save, Check, RefreshCw, AlertCircle, Info } from 'lucide-react';
import { useMobileUsersData, useUpdateMobileUserSettings } from '../../hooks/useTenantData';
import type { MobileUserSettingsData } from '../../hooks/useTenantData';
import { logError } from '../../utils/error-handling';
import { SmallToggle } from './Toggle';
import { DataTable, type DataTableColumn, Button } from '@aquaculture/shared-ui';

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
  const { data: mobileData, isLoading, error: mobileQueryError } = useMobileUsersData(true);
  const updateMobileSettingsMutation = useUpdateMobileUserSettings();

  const mobileUsers = mobileData?.users ?? [];
  const [mobileSettings, setMobileSettings] = useState<Map<string, MobileUserSettingsData>>(
    new Map(),
  );
  const mobileError = mobileQueryError ? (mobileQueryError as Error).message : null;
  const mobileSaving = updateMobileSettingsMutation.isPending;
  const [dirtyUserIds, setDirtyUserIds] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);

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
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      logError('MobileSettings.saveMobileSettings', err);
    }
  }, [dirtyUserIds, getUserSettings, updateMobileSettingsMutation]);

  const applyToAll = useCallback(
    (
      field: 'isMobileEnabled' | keyof MobileUserSettingsData['allowedFeatures'],
      value: boolean,
    ) => {
      for (const user of mobileUsers) {
        updateUserMobileSetting(user.id, field, value);
      }
    },
    [mobileUsers, updateUserMobileSetting],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 animate-spin text-success-600 dark:text-success-400" />
      </div>
    );
  }

  if (mobileError) {
    return (
      <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-xl p-4 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-error-500 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-error-800 dark:text-error-200">
            Failed to load mobile settings
          </p>
          <p className="text-sm text-error-600 dark:text-error-400">{mobileError}</p>
        </div>
      </div>
    );
  }

  if (mobileUsers.length === 0) {
    return (
      <div className="py-12 text-center">
        <Smartphone className="w-12 h-12 text-gray-500 dark:text-gray-400 mx-auto" />
        <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-gray-100">
          No users found
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Add users to your tenant first to configure mobile access.
        </p>
      </div>
    );
  }

  type MobileUserRow = (typeof mobileUsers)[number];
  const featureColumns: DataTableColumn<MobileUserRow>[] = FEATURE_COLUMNS.map((col) => ({
    key: col.key,
    header: col.label,
    align: 'center',
    render: (_value, user) => (
      <SmallToggle
        enabled={getUserSettings(user.id).allowedFeatures[col.key]}
        onChange={(v) => updateUserMobileSetting(user.id, col.key, v)}
      />
    ),
  }));
  const mobileUserColumns: DataTableColumn<MobileUserRow>[] = [
    {
      key: 'user',
      header: 'User',
      render: (_value, user) => {
        const name =
          `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email.split('@')[0];
        return (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-success-500 to-success-700 flex items-center justify-center text-white text-xs font-semibold">
              {name
                .split(' ')
                .map((n) => n[0])
                .join('')
                .toUpperCase()
                .slice(0, 2)}
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{user.email}</p>
            </div>
          </div>
        );
      },
    },
    {
      key: 'mobile',
      header: 'Mobile',
      align: 'center',
      render: (_value, user) => (
        <SmallToggle
          enabled={getUserSettings(user.id).isMobileEnabled}
          onChange={(v) => updateUserMobileSetting(user.id, 'isMobileEnabled', v)}
        />
      ),
    },
    ...featureColumns,
  ];

  return (
    <div className="space-y-4">
      {/* Bulk actions */}
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span>Apply to all:</span>
        <button
          onClick={() => applyToAll('isMobileEnabled', true)}
          className="px-2 py-1 bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300 rounded hover:bg-success-100 dark:hover:bg-success-900/50 transition-colors"
        >
          Enable All
        </button>
        <button
          onClick={() => applyToAll('isMobileEnabled', false)}
          className="px-2 py-1 bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-300 rounded hover:bg-error-100 dark:hover:bg-error-900/50 transition-colors"
        >
          Disable All
        </button>
      </div>

      {/* Table */}
      <DataTable<(typeof mobileUsers)[number]>
        data={mobileUsers}
        columns={mobileUserColumns}
        keyExtractor={(user) => user.id}
        emptyMessage="No mobile users"
        searchable={false}
        sortable={false}
        stickyHeader={false}
        rowClassName={(user) =>
          dirtyUserIds.has(user.id) ? 'bg-success-50/30 dark:bg-success-900/20/30' : ''
        }
        className="shadow-none rounded-none"
      />

      {/* Dirty indicator + Save */}
      <div className="flex items-center justify-between">
        {dirtyUserIds.size > 0 && (
          <div className="flex items-center gap-2 text-sm text-success-600 dark:text-success-400">
            <Info className="w-4 h-4" />
            <span>{dirtyUserIds.size} user(s) have unsaved changes</span>
          </div>
        )}
        <Button
          variant="primary"
          onClick={saveMobileSettings}
          disabled={mobileSaving || dirtyUserIds.size === 0}
        >
          {saved ? (
            <>
              <Check className="w-4 h-4" />
              Saved!
            </>
          ) : mobileSaving ? (
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
  );
};

export default MobileSettings;
