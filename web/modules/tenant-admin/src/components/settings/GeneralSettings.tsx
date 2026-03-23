import React, { useState, useEffect, useCallback } from 'react';
import { Save, Check, RefreshCw, AlertCircle } from 'lucide-react';
import { useMyTenant, useUpdateTenantSettings } from '../../hooks/useTenantData';
import { logError, sanitizeErrorMessage } from '../../utils/error-handling';

interface GeneralSettingsProps {
  canEdit: boolean;
}

/**
 * GeneralSettings -- name, contact info, address + Save button.
 */
const GeneralSettings: React.FC<GeneralSettingsProps> = ({ canEdit }) => {
  const { data: tenantData } = useMyTenant();
  const updateSettingsMutation = useUpdateTenantSettings();

  const [tenantName, setTenantName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [address, setAddress] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (tenantData) {
      setTenantName(tenantData.name || '');
      setContactEmail(tenantData.contactEmail || '');
      setContactPhone(tenantData.contactPhone || '');
      setAddress(tenantData.address || '');
    }
  }, [tenantData]);

  const handleSave = useCallback(async () => {
    setSaveError(null);
    try {
      await updateSettingsMutation.mutateAsync({
        id: tenantData?.id ?? '',
        input: {
          name: tenantName,
          contactEmail,
          contactPhone,
          address,
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      logError('GeneralSettings.handleSave', err);
      setSaveError(sanitizeErrorMessage(err));
    }
  }, [tenantName, contactEmail, contactPhone, address, updateSettingsMutation, tenantData]);

  const saving = updateSettingsMutation.isPending;
  const inputClass =
    'w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed';

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Tenant Name</label>
        <input
          type="text"
          value={tenantName}
          onChange={(e) => setTenantName(e.target.value)}
          disabled={!canEdit}
          className={inputClass}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Contact Email</label>
        <input
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          disabled={!canEdit}
          className={inputClass}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Contact Phone</label>
        <input
          type="tel"
          value={contactPhone}
          onChange={(e) => setContactPhone(e.target.value)}
          disabled={!canEdit}
          className={inputClass}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
        <textarea
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          rows={3}
          disabled={!canEdit}
          className={`${inputClass} resize-none`}
        />
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
            onClick={handleSave}
            disabled={saving}
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

export default GeneralSettings;
