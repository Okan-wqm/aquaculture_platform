/**
 * Site Form Modal Component
 * Modal for creating and editing sites
 */
import React, { useState, useEffect } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import SiteContactsSection from './SiteContactsSection';

export interface SiteFormData {
  name: string;
  code: string;
  lokalitetsnummer: number | '';
  description: string;
  status: string;
  country: string;
  region: string;
  timezone: string;
  totalArea: number | '';
  siteManager: string;
  contactEmail: string;
  contactPhone: string;
  address: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
  };
  location: {
    latitude: number | '';
    longitude: number | '';
  };
}

interface SiteFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Partial<SiteFormData>) => void;
  site?: {
    id: string;
    name: string;
    code: string;
    lokalitetsnummer?: number;
    status: string;
    description?: string;
    country?: string;
    region?: string;
    timezone?: string;
    totalArea?: number;
    siteManager?: string;
    contactEmail?: string;
    contactPhone?: string;
    address?: {
      street?: string;
      city?: string;
      state?: string;
      postalCode?: string;
    };
    location?: {
      latitude?: number;
      longitude?: number;
    };
  } | null;
}

const statusOptions = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'MAINTENANCE', label: 'Under Maintenance' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'CLOSED', label: 'Closed' },
];

/**
 * Boş değer = "tenant ayarını devral" (W5). `sites.timezone` artık nullable:
 * NULL, tenant lokalizasyonundan (tenant/settings → Localization) devralmak
 * demektir. Eskiden kolon `NOT NULL DEFAULT 'UTC'` olduğu için "UTC seçildi"
 * ile "hiç seçilmedi" ayırt edilemiyor, tenant zonunu ayarladığında siteler
 * UTC'de kalıyordu.
 */
const timezoneOptions = [
  { value: '', label: 'Inherit from tenant' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/Oslo', label: 'Europe/Oslo (CET)' },
  { value: 'Europe/Istanbul', label: 'Europe/Istanbul (TRT)' },
  { value: 'Europe/London', label: 'Europe/London (GMT)' },
  { value: 'America/New_York', label: 'America/New York (EST)' },
  { value: 'Asia/Istanbul', label: 'Asia/Istanbul (TRT)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)' },
];

export const SiteFormModal: React.FC<SiteFormModalProps> = ({ isOpen, onClose, onSave, site }) => {
  const [formData, setFormData] = useState<SiteFormData>({
    name: '',
    code: '',
    lokalitetsnummer: '',
    description: '',
    status: 'ACTIVE',
    country: '',
    region: '',
    timezone: '',
    totalArea: '',
    siteManager: '',
    contactEmail: '',
    contactPhone: '',
    address: {
      street: '',
      city: '',
      state: '',
      postalCode: '',
    },
    location: {
      latitude: '',
      longitude: '',
    },
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<'basic' | 'location' | 'contact'>('basic');

  useEffect(() => {
    if (site) {
      setFormData({
        name: site.name || '',
        code: site.code || '',
        lokalitetsnummer: site.lokalitetsnummer ?? '',
        description: site.description || '',
        status: site.status || 'ACTIVE',
        country: site.country || '',
        region: site.region || '',
        timezone: site.timezone ?? '',
        totalArea: site.totalArea || '',
        siteManager: site.siteManager || '',
        contactEmail: site.contactEmail || '',
        contactPhone: site.contactPhone || '',
        address: {
          street: site.address?.street || '',
          city: site.address?.city || '',
          state: site.address?.state || '',
          postalCode: site.address?.postalCode || '',
        },
        location: {
          latitude: site.location?.latitude ?? '',
          longitude: site.location?.longitude ?? '',
        },
      });
    } else {
      setFormData({
        name: '',
        code: '',
        lokalitetsnummer: '',
        description: '',
        status: 'ACTIVE',
        country: '',
        region: '',
        timezone: '',
        totalArea: '',
        siteManager: '',
        contactEmail: '',
        contactPhone: '',
        address: { street: '', city: '', state: '', postalCode: '' },
        location: { latitude: '', longitude: '' },
      });
    }
    setErrors({});
    setActiveTab('basic');
  }, [site, isOpen]);

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.name.trim()) {
      newErrors.name = 'Site name is required';
    }
    if (!formData.code.trim()) {
      newErrors.code = 'Site code is required';
    } else if (formData.code.length < 2) {
      newErrors.code = 'Code must be at least 2 characters';
    }
    if (
      formData.lokalitetsnummer !== '' &&
      (formData.lokalitetsnummer < 10000 || formData.lokalitetsnummer > 99999)
    ) {
      newErrors.lokalitetsnummer = 'Lokalitetsnummer is a 5-digit number (10000–99999)';
    }
    if (formData.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.contactEmail)) {
      newErrors.contactEmail = 'Invalid email address';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validateForm()) {
      onSave(formData);
    }
  };

  const handleInputChange = (field: string, value: string | number) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={site ? 'Edit Site' : 'Create New Site'}
      size="lg"
    >
      {/* Tabs */}
      <div className="mb-4 flex space-x-4">
        {(['basic', 'location', 'contact'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-sm font-medium rounded-md ${
              activeTab === tab ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)} Info
          </button>
        ))}
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit}>
        <div className="max-h-[60vh] overflow-y-auto">
          {/* Basic Info Tab */}
          {activeTab === 'basic' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Site Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => handleInputChange('name', e.target.value)}
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                      errors.name ? 'border-red-500' : 'border-gray-300'
                    }`}
                    placeholder="e.g., Main Production Site"
                  />
                  {errors.name && <p className="mt-1 text-sm text-red-500">{errors.name}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Site Code <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.code}
                    onChange={(e) => handleInputChange('code', e.target.value.toUpperCase())}
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                      errors.code ? 'border-red-500' : 'border-gray-300'
                    }`}
                    placeholder="e.g., MPS-001"
                  />
                  {errors.code && <p className="mt-1 text-sm text-red-500">{errors.code}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Lokalitetsnummer
                  </label>
                  <input
                    type="number"
                    min={10000}
                    max={99999}
                    value={formData.lokalitetsnummer}
                    onChange={(e) =>
                      handleInputChange(
                        'lokalitetsnummer',
                        e.target.value === '' ? '' : Number(e.target.value),
                      )
                    }
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                      errors.lokalitetsnummer ? 'border-red-500' : 'border-gray-300'
                    }`}
                    placeholder="e.g., 12345"
                  />
                  {errors.lokalitetsnummer ? (
                    <p className="mt-1 text-sm text-red-500">{errors.lokalitetsnummer}</p>
                  ) : (
                    <p className="mt-1 text-xs text-gray-500">
                      Akvakulturregisteret locality number (5 digits) — Norwegian regulatory reports
                      fail closed without it.
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => handleInputChange('description', e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Brief description of the site..."
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => handleInputChange('status', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {statusOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Total Area (m²)
                  </label>
                  <input
                    type="number"
                    value={formData.totalArea}
                    onChange={(e) =>
                      handleInputChange(
                        'totalArea',
                        e.target.value ? parseFloat(e.target.value) : '',
                      )
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="e.g., 50000"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
                <select
                  value={formData.timezone}
                  onChange={(e) => handleInputChange('timezone', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {timezoneOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  Feeding jobs (day-plan generation, morning sweep, daily summary) run on
                  this site&apos;s local day. Leave it inherited unless the site is in a
                  different timezone than the tenant.
                </p>
              </div>
            </div>
          )}

          {/* Location Tab */}
          {activeTab === 'location' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
                  <input
                    type="text"
                    value={formData.country}
                    onChange={(e) => handleInputChange('country', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="e.g., Norway"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Region</label>
                  <input
                    type="text"
                    value={formData.region}
                    onChange={(e) => handleInputChange('region', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="e.g., Hordaland"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Street Address
                </label>
                <input
                  type="text"
                  value={formData.address.street}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      address: { ...prev.address, street: e.target.value },
                    }))
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Street address..."
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                  <input
                    type="text"
                    value={formData.address.city}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        address: { ...prev.address, city: e.target.value },
                      }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                  <input
                    type="text"
                    value={formData.address.state}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        address: { ...prev.address, state: e.target.value },
                      }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Postal Code
                  </label>
                  <input
                    type="text"
                    value={formData.address.postalCode}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        address: { ...prev.address, postalCode: e.target.value },
                      }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Latitude</label>
                  <input
                    type="number"
                    step="any"
                    value={formData.location.latitude}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        location: {
                          ...prev.location,
                          latitude: e.target.value ? parseFloat(e.target.value) : '',
                        },
                      }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="e.g., 60.3913"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Longitude</label>
                  <input
                    type="number"
                    step="any"
                    value={formData.location.longitude}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        location: {
                          ...prev.location,
                          longitude: e.target.value ? parseFloat(e.target.value) : '',
                        },
                      }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="e.g., 5.3221"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Contact Tab */}
          {activeTab === 'contact' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Site Manager</label>
                <input
                  type="text"
                  value={formData.siteManager}
                  onChange={(e) => handleInputChange('siteManager', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Full name of site manager"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Contact Email
                  </label>
                  <input
                    type="email"
                    value={formData.contactEmail}
                    onChange={(e) => handleInputChange('contactEmail', e.target.value)}
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                      errors.contactEmail ? 'border-red-500' : 'border-gray-300'
                    }`}
                    placeholder="email@example.com"
                  />
                  {errors.contactEmail && (
                    <p className="mt-1 text-sm text-red-500">{errors.contactEmail}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Contact Phone
                  </label>
                  <input
                    type="tel"
                    value={formData.contactPhone}
                    onChange={(e) => handleInputChange('contactPhone', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="+47 XXX XX XXX"
                  />
                </div>
              </div>

              {/*
                    Structured contact people (Scope A 4.4.3 — wires the
                    upsertSiteContacts mutation backend shipped in
                    PR #149). Distinct from the site-level contactEmail
                    /contactPhone above: those are a single fallback
                    contact captured on the site row itself; this
                    section maintains the multi-row site_contacts
                    table with name+role+email+phone+isPrimary per
                    person.

                    Hidden in CREATE mode (no siteId yet) — operator
                    saves the site first, reopens, then edits
                    contacts. The section component renders its own
                    explanatory placeholder in that mode.
                  */}
              <SiteContactsSection siteId={site?.id} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-gray-200 flex justify-end space-x-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
          >
            {site ? 'Update Site' : 'Create Site'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default SiteFormModal;
