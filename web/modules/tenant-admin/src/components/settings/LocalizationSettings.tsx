import React, { useEffect, useState } from 'react';
import { AlertCircle, Check, Clock, RefreshCw, Save } from 'lucide-react';

import {
  useTenantLocalization,
  useUpdateTenantLocalization,
} from '../../hooks/useTenantLocalization';
import { logError, sanitizeErrorMessage } from '../../utils/error-handling';

/**
 * LocalizationSettings — tenant saat dilimi + dil (W5).
 *
 * Bu ekran bir görünüm tercihi değil, OPERASYONEL bir ayardır: farm
 * modülünün yemleme işleri (gün planı üretimi, sabah süpürmesi, gün özeti,
 * FCR ve stok kapsama süpürmeleri) tenant'ın YEREL gününde koşar ve gün
 * sınırını buradan alır. Daha önce ekran "yakında" banner'ıydı ve motor sabit
 * bir saat dilimine bağlıydı: Norveç'teki bir tenant İstanbul'un 06:00'ında
 * plan alıyor, kendi günü bitmeden akşam özetini görüyordu.
 */

/** Sunucu IANA doğrulaması yapar; liste yaygın operasyon zonlarının kısayolu. */
const TIMEZONE_OPTIONS = [
  'UTC',
  'Europe/Istanbul',
  'Europe/Oslo',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Athens',
  'Atlantic/Faroe',
  'Atlantic/Reykjavik',
  'America/Santiago',
  'America/Halifax',
  'Asia/Ho_Chi_Minh',
  'Asia/Jakarta',
  'Australia/Hobart',
] as const;

const LOCALE_OPTIONS = [
  { value: '', label: 'Not set' },
  { value: 'tr', label: 'Türkçe (tr)' },
  { value: 'en', label: 'English (en)' },
  { value: 'en-GB', label: 'English — UK (en-GB)' },
  { value: 'nb', label: 'Norsk bokmål (nb)' },
  { value: 'es', label: 'Español (es)' },
] as const;

interface LocalizationSettingsProps {
  canEdit?: boolean;
}

const LocalizationSettings: React.FC<LocalizationSettingsProps> = ({ canEdit = false }) => {
  const { data, isLoading } = useTenantLocalization();
  const updateMutation = useUpdateTenantLocalization();

  const [timezone, setTimezone] = useState('UTC');
  const [locale, setLocale] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setTimezone(data.timezone || 'UTC');
      setLocale(data.locale ?? '');
    }
  }, [data]);

  const handleSave = async (): Promise<void> => {
    setSaveError(null);
    try {
      await updateMutation.mutateAsync({ timezone, locale: locale || null });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      logError('LocalizationSettings.handleSave', err);
      setSaveError(sanitizeErrorMessage(err));
    }
  };

  const saving = updateMutation.isPending;
  const selectClass =
    'w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed';

  // Seçilen zonda "şu an" — operatör kaydetmeden önce doğru zonu seçtiğini görür.
  let localNow = '';
  try {
    localNow = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date());
  } catch {
    localNow = '—';
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
        <Clock className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-blue-800">
          Feeding jobs run on your tenant&apos;s <strong>local day</strong>: day-plan generation at
          06:00, the morning sweep at 05:00, stock coverage at 07:00, FCR alerts at 18:00 and the
          daily summary at 20:00 — all in the timezone selected here. Sites may override it
          individually; sites left blank inherit this value.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="tenant-timezone">
          Timezone
        </label>
        <select
          id="tenant-timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          disabled={!canEdit || isLoading}
          className={selectClass}
        >
          {/* Kayıtlı zon listede yoksa yine de görünür — sunucu her IANA
              kimliğini kabul eder, liste yalnız kısayoldur. */}
          {!TIMEZONE_OPTIONS.includes(timezone as (typeof TIMEZONE_OPTIONS)[number]) && (
            <option value={timezone}>{timezone}</option>
          )}
          {TIMEZONE_OPTIONS.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500">Local time now: {localNow}</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="tenant-locale">
          Language
        </label>
        <select
          id="tenant-locale"
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
          disabled={!canEdit || isLoading}
          className={selectClass}
        >
          {LOCALE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500">
          Used for report and date formatting. It does not change feeding schedules.
        </p>
      </div>

      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {saveError && (
            <p className="text-xs text-red-600 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {saveError}
            </p>
          )}
          <button
            onClick={() => void handleSave()}
            disabled={saving || isLoading}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
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
          </button>
        </div>
      )}
    </div>
  );
};

export default LocalizationSettings;
