/**
 * Site Form Modal Component
 * Modal for creating and editing sites
 */
import React, { useState, useEffect } from 'react';

interface SiteFormData {
  name: string;
  code: string;
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
    status: string;
    country?: string;
    region?: string;
    totalArea?: number;
    siteManager?: string;
    contactEmail?: string;
  } | null;
}

const statusOptions = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'MAINTENANCE', label: 'Under Maintenance' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'CLOSED', label: 'Closed' },
];

const timezoneOptions = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/Oslo', label: 'Europe/Oslo (CET)' },
  { value: 'Europe/London', label: 'Europe/London (GMT)' },
  { value: 'America/New_York', label: 'America/New York (EST)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)' },
];

export const SiteFormModal: React.FC<SiteFormModalProps> = ({
  isOpen,
  onClose,
  onSave,
  site,
}) => {
  const [formData, setFormData] = useState<SiteFormData>({
    name: '',
    code: '',
    description: '',
    status: 'ACTIVE',
    country: '',
    region: '',
    timezone: 'UTC',
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
        description: '',
        status: site.status || 'ACTIVE',
        country: site.country || '',
        region: site.region || '',
        timezone: 'UTC',
        totalArea: site.totalArea || '',
        siteManager: site.siteManager || '',
        contactEmail: site.contactEmail || '',
        contactPhone: '',
        address: { street: '', city: '', state: '', postalCode: '' },
        location: { latitude: '', longitude: '' },
      });
    } else {
      setFormData({
        name: '',
        code: '',
        description: '',
        status: 'ACTIVE',
        country: '',
        region: '',
        timezone: 'UTC',
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
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Background overlay */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        />

        {/* Modal panel */}
        <div className="inline-block w-full max-w-2xl my-8 overflow-hidden text-left align-middle transition-all transform bg-white rounded-lg shadow-xl">
          {/* Header */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">
                {site ? 'Edit Site' : 'Create New Site'}
              </h3>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-500"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Tabs */}
            <div className="mt-4 flex space-x-4">
              {(['basic', 'location', 'contact'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md ${
                    activeTab === tab
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)} Info
                </button>
              ))}
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit}>
            <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
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
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description
                    </label>
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
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Status
                      </label>
                      <select
                        value={formData.status}
                        onChange={(e) => handleInputChange('status', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        {statusOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
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
                        onChange={(e) => handleInputChange('totalArea', e.target.value ? parseFloat(e.target.value) : '')}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="e.g., 50000"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Timezone
                    </label>
                    <select
                      value={formData.timezone}
                      onChange={(e) => handleInputChange('timezone', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      {timezoneOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* Location Tab */}
              {activeTab === 'location' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Country
                      </label>
                      <input
                        type="text"
                        value={formData.country}
                        onChange={(e) => handleInputChange('country', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="e.g., Norway"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Region
                      </label>
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
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        address: { ...prev.address, street: e.target.value }
                      }))}
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
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          address: { ...prev.address, city: e.target.value }
                        }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                      <input
                        type="text"
                        value={formData.address.state}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          address: { ...prev.address, state: e.target.value }
                        }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Postal Code</label>
                      <input
                        type="text"
                        value={formData.address.postalCode}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          address: { ...prev.address, postalCode: e.target.value }
                        }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Latitude
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={formData.location.latitude}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          location: { ...prev.location, latitude: e.target.value ? parseFloat(e.target.value) : '' }
                        }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="e.g., 60.3913"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Longitude
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={formData.location.longitude}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          location: { ...prev.location, longitude: e.target.value ? parseFloat(e.target.value) : '' }
                        }))}
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
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Site Manager
                    </label>
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
                      {errors.contactEmail && <p className="mt-1 text-sm text-red-500">{errors.contactEmail}</p>}
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
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end space-x-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {site ? 'Update Site' : 'Create Site'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default SiteFormModal;
