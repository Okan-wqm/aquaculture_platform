import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Save, RefreshCw, AlertCircle } from 'lucide-react';
import { useToast } from '@aquaculture/shared-ui';
import {
  useTenantLocalizationPreferences,
  useUpdateTenantLocalizationPreferences,
  type UpdateTenantLocalizationPreferencesInput,
  type TenantDateFormat,
} from '../../hooks/useTenantSecuritySettings';
import { logError, createErrorToastOptions } from '../../utils/error-handling';

/**
 * LocalizationSettings — real timezone + date-format preferences (ADR-042,
 * ADMIN-MEDIUM-010). Replaces the "coming soon" stub.
 *
 * No language selector: the platform is an English-only surface by decision, so
 * a language control would be a dead input.
 */

// Wire value (GraphQL enum name) → human-readable label. The backend accepts the
// enum NAMES (DD_MM_YYYY / MM_DD_YYYY / YYYY_MM_DD); the labels are the actual
// display patterns those map to.
const DATE_FORMAT_OPTIONS: ReadonlyArray<{ value: TenantDateFormat; label: string }> = [
  { value: 'DD_MM_YYYY', label: 'DD/MM/YYYY' },
  { value: 'MM_DD_YYYY', label: 'MM/DD/YYYY' },
  { value: 'YYYY_MM_DD', label: 'YYYY-MM-DD' },
];

// Intl.supportedValuesOf is ES2022; this module's tsconfig targets ES2020, so
// the type isn't in lib. Narrow the runtime object through a type guard
// instead of a namespace augmentation or an unknown cast.
interface IntlWithTz {
  supportedValuesOf(key: 'timeZone'): string[];
}

function hasSupportedValuesOf(intl: unknown): intl is IntlWithTz {
  return (
    typeof intl === 'object' &&
    intl !== null &&
    'supportedValuesOf' in intl &&
    typeof (intl as Record<string, unknown>).supportedValuesOf === 'function'
  );
}

/**
 * The runtime's own IANA tz database (same authority the server validates
 * against). Guarded because older runtimes lack Intl.supportedValuesOf.
 */
function supportedTimezones(): string[] {
  const intl: unknown = Intl;
  return hasSupportedValuesOf(intl) ? intl.supportedValuesOf('timeZone') : ['UTC'];
}

const LocalizationSettings: React.FC = () => {
  const { data: prefs, isLoading, isError } = useTenantLocalizationPreferences();
  const updateMutation = useUpdateTenantLocalizationPreferences();
  const { toast } = useToast();

  const [timezone, setTimezone] = useState('');
  const [dateFormat, setDateFormat] = useState<TenantDateFormat | ''>('');

  useEffect(() => {
    if (prefs) {
      setTimezone(prefs.timezone ?? '');
      setDateFormat(prefs.dateFormat ?? '');
    }
  }, [prefs]);

  // Ensure the currently-stored zone is always selectable even if the runtime's
  // list omits it (e.g. a legacy alias).
  const timezoneOptions = useMemo<string[]>(() => {
    const zones = supportedTimezones();
    if (timezone && !zones.includes(timezone)) {
      return [timezone, ...zones];
    }
    return zones;
  }, [timezone]);

  const handleSave = useCallback(async () => {
    const input: UpdateTenantLocalizationPreferencesInput = {};
    if (timezone) input.timezone = timezone;
    if (dateFormat) input.dateFormat = dateFormat;
    try {
      await updateMutation.mutateAsync(input);
      toast({ variant: 'success', title: 'Localization settings saved' });
    } catch (err) {
      logError('LocalizationSettings.handleSave', err);
      toast(createErrorToastOptions(err));
    }
  }, [timezone, dateFormat, updateMutation, toast]);

  const saving = updateMutation.isPending;
  const inputClass =
    'w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed';

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading localization settings…
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-red-600 flex items-center gap-1">
        <AlertCircle className="w-4 h-4" />
        Could not load localization settings.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <label htmlFor="tenant-timezone" className="block text-sm font-medium text-gray-700 mb-1">
          Timezone
        </label>
        <select
          id="tenant-timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className={inputClass}
        >
          <option value="">Select a timezone</option>
          {timezoneOptions.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="tenant-date-format" className="block text-sm font-medium text-gray-700 mb-1">
          Date format
        </label>
        <select
          id="tenant-date-format"
          value={dateFormat}
          onChange={(e) => setDateFormat(e.target.value as TenantDateFormat | '')}
          className={inputClass}
        >
          <option value="">Select a date format</option>
          {DATE_FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-end gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Saving…
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

export default LocalizationSettings;
