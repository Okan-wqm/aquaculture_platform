import React, { useState, useEffect, useCallback } from 'react';
import { Save, RefreshCw } from 'lucide-react';
import { useToast } from '@aquaculture/shared-ui';
import { useMyTenant, useUpdateTenantSettings } from '../../hooks/useTenantData';
import { logError, createErrorToastOptions } from '../../utils/error-handling';

interface GeneralSettingsProps {
  canEdit: boolean;
}

/**
 * GeneralSettings -- name, contact info, address + Save button.
 */
const GeneralSettings: React.FC<GeneralSettingsProps> = ({ canEdit }) => {
  const { data: tenantData } = useMyTenant();
  const updateSettingsMutation = useUpdateTenantSettings();
  const { toast } = useToast();

  const [tenantName, setTenantName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [address, setAddress] = useState('');

  useEffect(() => {
    if (tenantData) {
      setTenantName(tenantData.name || '');
      setContactEmail(tenantData.contactEmail || '');
      setContactPhone(tenantData.contactPhone || '');
      setAddress(tenantData.address || '');
    }
  }, [tenantData]);

  const handleSave = useCallback(async () => {
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
      toast({ variant: 'success', title: 'Settings saved' });
    } catch (err) {
      logError('GeneralSettings.handleSave', err);
      toast(createErrorToastOptions(err));
    }
  }, [tenantName, contactEmail, contactPhone, address, updateSettingsMutation, tenantData, toast]);

  const saving = updateSettingsMutation.isPending;
  const inputClass =
    'w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed';

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
          <button
            onClick={handleSave}
            disabled={saving}
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
      )}
    </div>
  );
};

export default GeneralSettings;
