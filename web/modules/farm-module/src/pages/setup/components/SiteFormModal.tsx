/**
 * Site Form Modal Component
 * Modal for creating and editing sites
 */
import React, { useState, useEffect } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import SiteContactsSection from './SiteContactsSection';
import type { MonitoringArea, Site, SiteType } from '../../../hooks/useSites';
import { validateMonitoringAreaForSite } from './monitoringAreaUxValidation';

export interface SiteFormData {
  name: string;
  code: string;
  type: SiteType;
  lokalitetsnummer: number | '';
  organisationNumberOverride: string;
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
    altitude: number | '';
  };
  monitoringRadiusM: number | '';
  monitoringArea: MonitoringArea | null;
}

interface SiteFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: SiteFormData) => void;
  site?: Site | null;
}

const siteTypeOptions: ReadonlyArray<{ value: SiteType; label: string }> = [
  { value: 'LAND_BASED', label: 'Land-based facility' },
  { value: 'SEA_CAGE', label: 'Sea cage' },
  { value: 'POND', label: 'Pond' },
  { value: 'RACEWAY', label: 'Raceway' },
  { value: 'RECIRCULATING', label: 'Recirculating aquaculture system' },
  { value: 'HATCHERY', label: 'Hatchery' },
];

function isSiteType(value: string): value is SiteType {
  return siteTypeOptions.some((option) => option.value === value);
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
    type: 'LAND_BASED',
    lokalitetsnummer: '',
    organisationNumberOverride: '',
    description: '',
    status: 'ACTIVE',
    country: '',
    region: '',
    timezone: 'Europe/Oslo',
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
      altitude: '',
    },
    monitoringRadiusM: 2000,
    monitoringArea: null,
  });
  const [monitoringAreaJson, setMonitoringAreaJson] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<'basic' | 'location' | 'contact'>('basic');

  useEffect(() => {
    if (site) {
      setFormData({
        name: site.name || '',
        code: site.code || '',
        type: site.type,
        lokalitetsnummer: site.lokalitetsnummer ?? '',
        organisationNumberOverride: site.organisationNumberOverride || '',
        description: site.description || '',
        status: site.status || 'ACTIVE',
        country: site.country ?? site.address?.country ?? '',
        region: site.region || '',
        timezone: site.timezone || 'Europe/Oslo',
        totalArea: site.totalArea ?? '',
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
          altitude: site.location?.altitude ?? '',
        },
        monitoringRadiusM: site.monitoringRadiusM ?? 2000,
        monitoringArea: site.monitoringArea ?? null,
      });
      setMonitoringAreaJson(site.monitoringArea ? JSON.stringify(site.monitoringArea) : '');
    } else {
      setFormData({
        name: '',
        code: '',
        type: 'LAND_BASED',
        lokalitetsnummer: '',
        organisationNumberOverride: '',
        description: '',
        status: 'ACTIVE',
        country: '',
        region: '',
        timezone: 'Europe/Oslo',
        totalArea: '',
        siteManager: '',
        contactEmail: '',
        contactPhone: '',
        address: { street: '', city: '', state: '', postalCode: '' },
        location: { latitude: '', longitude: '', altitude: '' },
        monitoringRadiusM: 2000,
        monitoringArea: null,
      });
      setMonitoringAreaJson('');
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

    const { latitude, longitude, altitude } = formData.location;
    if (formData.type === 'SEA_CAGE' && latitude === '') {
      newErrors.latitude = 'Latitude is required for a sea cage';
    } else if (latitude !== '' && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
      newErrors.latitude = 'Latitude must be between -90 and 90';
    }
    if (formData.type === 'SEA_CAGE' && longitude === '') {
      newErrors.longitude = 'Longitude is required for a sea cage';
    } else if (
      longitude !== '' &&
      (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)
    ) {
      newErrors.longitude = 'Longitude must be between -180 and 180';
    }
    if ((latitude === '') !== (longitude === '')) {
      newErrors.location = 'Latitude and longitude must be provided together';
    }
    if (altitude !== '' && !Number.isFinite(altitude)) {
      newErrors.altitude = 'Altitude must be a finite number';
    }
    if (
      formData.monitoringRadiusM === '' ||
      !Number.isInteger(formData.monitoringRadiusM) ||
      formData.monitoringRadiusM < 100 ||
      formData.monitoringRadiusM > 20000
    ) {
      newErrors.monitoringRadiusM =
        'Monitoring radius must be a whole number between 100 and 20000 metres';
    }

    if (monitoringAreaJson.trim()) {
      try {
        const parsed: unknown = JSON.parse(monitoringAreaJson);
        const result = validateMonitoringAreaForSite(parsed, formData.location);
        if (!result.valid) {
          newErrors.monitoringArea = result.message;
        }
      } catch {
        newErrors.monitoringArea = 'Monitoring area must contain valid GeoJSON.';
      }
    }

    setErrors(newErrors);
    const errorKeys = Object.keys(newErrors);
    if (errorKeys.length > 0) {
      if (
        errorKeys.some((key) =>
          [
            'latitude',
            'longitude',
            'altitude',
            'location',
            'monitoringRadiusM',
            'monitoringArea',
          ].includes(key),
        )
      ) {
        setActiveTab('location');
      } else if (errorKeys.includes('contactEmail')) {
        setActiveTab('contact');
      } else {
        setActiveTab('basic');
      }
      return false;
    }
    return true;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validateForm()) {
      let monitoringArea: MonitoringArea | null = null;
      if (monitoringAreaJson.trim()) {
        const parsed: unknown = JSON.parse(monitoringAreaJson);
        const result = validateMonitoringAreaForSite(parsed, formData.location);
        if (result.valid) {
          monitoringArea = result.geometry;
        }
      }
      onSave({ ...formData, monitoringArea });
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
      <form onSubmit={handleSubmit} noValidate>
        <div className="max-h-[60vh] overflow-y-auto">
          {/* Basic Info Tab */}
          {activeTab === 'basic' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="site-name"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Site Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="site-name"
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
                  <label
                    htmlFor="site-code"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Site Code <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="site-code"
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
                  <label
                    htmlFor="site-locality"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Lokalitetsnummer
                  </label>
                  <input
                    id="site-locality"
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
                <div>
                  <label
                    htmlFor="site-organisation-override"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Organisation Number Override
                  </label>
                  <input
                    id="site-organisation-override"
                    type="text"
                    value={formData.organisationNumberOverride}
                    onChange={(e) =>
                      handleInputChange('organisationNumberOverride', e.target.value)
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="9-digit Norwegian organisation number"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="site-description"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Description
                </label>
                <textarea
                  id="site-description"
                  value={formData.description}
                  onChange={(e) => handleInputChange('description', e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Brief description of the site..."
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="site-type"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Site Type
                  </label>
                  <select
                    id="site-type"
                    value={formData.type}
                    onChange={(e) => {
                      if (isSiteType(e.target.value)) {
                        handleInputChange('type', e.target.value);
                      }
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {siteTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="site-status"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Status
                  </label>
                  <select
                    id="site-status"
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
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="site-total-area"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Total Area (m²)
                  </label>
                  <input
                    id="site-total-area"
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
                <label
                  htmlFor="site-timezone"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Timezone
                </label>
                <select
                  id="site-timezone"
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
              </div>
            </div>
          )}

          {/* Location Tab */}
          {activeTab === 'location' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="site-country"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Country
                  </label>
                  <input
                    id="site-country"
                    type="text"
                    value={formData.country}
                    onChange={(e) => handleInputChange('country', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="e.g., Norway"
                  />
                </div>
                <div>
                  <label
                    htmlFor="site-region"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Region
                  </label>
                  <input
                    id="site-region"
                    type="text"
                    value={formData.region}
                    onChange={(e) => handleInputChange('region', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="e.g., Hordaland"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="site-street"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Street Address
                </label>
                <input
                  id="site-street"
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
                  <label
                    htmlFor="site-city"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    City
                  </label>
                  <input
                    id="site-city"
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
                  <label
                    htmlFor="site-state"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    State
                  </label>
                  <input
                    id="site-state"
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
                  <label
                    htmlFor="site-postal-code"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Postal Code
                  </label>
                  <input
                    id="site-postal-code"
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="site-latitude"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Latitude
                  </label>
                  <input
                    id="site-latitude"
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
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                      errors.latitude ? 'border-red-500' : 'border-gray-300'
                    }`}
                    placeholder="e.g., 60.3913"
                  />
                  {errors.latitude && (
                    <p className="mt-1 text-sm text-red-500">{errors.latitude}</p>
                  )}
                </div>
                <div>
                  <label
                    htmlFor="site-longitude"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Longitude
                  </label>
                  <input
                    id="site-longitude"
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
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                      errors.longitude ? 'border-red-500' : 'border-gray-300'
                    }`}
                    placeholder="e.g., 5.3221"
                  />
                  {errors.longitude && (
                    <p className="mt-1 text-sm text-red-500">{errors.longitude}</p>
                  )}
                </div>
                <div>
                  <label
                    htmlFor="site-altitude"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Altitude (m)
                  </label>
                  <input
                    id="site-altitude"
                    type="number"
                    step="any"
                    value={formData.location.altitude}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        location: {
                          ...prev.location,
                          altitude: e.target.value === '' ? '' : Number(e.target.value),
                        },
                      }))
                    }
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                      errors.altitude ? 'border-red-500' : 'border-gray-300'
                    }`}
                    placeholder="Optional"
                  />
                  {errors.altitude && (
                    <p className="mt-1 text-sm text-red-500">{errors.altitude}</p>
                  )}
                </div>
              </div>
              {errors.location && <p className="text-sm text-red-500">{errors.location}</p>}

              <div>
                <label
                  htmlFor="site-monitoring-radius"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Monitoring Radius (m)
                </label>
                <input
                  id="site-monitoring-radius"
                  type="number"
                  min={100}
                  max={20000}
                  value={formData.monitoringRadiusM}
                  onChange={(e) =>
                    handleInputChange(
                      'monitoringRadiusM',
                      e.target.value === '' ? '' : Number(e.target.value),
                    )
                  }
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                    errors.monitoringRadiusM ? 'border-red-500' : 'border-gray-300'
                  }`}
                />
                {errors.monitoringRadiusM && (
                  <p className="mt-1 text-sm text-red-500">{errors.monitoringRadiusM}</p>
                )}
              </div>

              <div>
                <label
                  htmlFor="site-monitoring-area"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Monitoring Area GeoJSON
                </label>
                <textarea
                  id="site-monitoring-area"
                  rows={6}
                  value={monitoringAreaJson}
                  onChange={(e) => {
                    setMonitoringAreaJson(e.target.value);
                    if (errors.monitoringArea) {
                      setErrors((previous) => ({ ...previous, monitoringArea: '' }));
                    }
                  }}
                  className={`w-full px-3 py-2 border rounded-lg font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                    errors.monitoringArea ? 'border-red-500' : 'border-gray-300'
                  }`}
                  placeholder='{"type":"Polygon","coordinates":[[[5.3,60.3],[5.4,60.3],[5.4,60.4],[5.3,60.3]]]}'
                />
                {errors.monitoringArea ? (
                  <p className="mt-1 text-sm text-red-500">{errors.monitoringArea}</p>
                ) : (
                  <p className="mt-1 text-xs text-gray-500">
                    Optional Polygon or MultiPolygon using [longitude, latitude]. The server
                    performs the canonical validation before saving.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Contact Tab */}
          {activeTab === 'contact' && (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="site-manager"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Site Manager
                </label>
                <input
                  id="site-manager"
                  type="text"
                  value={formData.siteManager}
                  onChange={(e) => handleInputChange('siteManager', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Full name of site manager"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="site-contact-email"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Contact Email
                  </label>
                  <input
                    id="site-contact-email"
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
                  <label
                    htmlFor="site-contact-phone"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Contact Phone
                  </label>
                  <input
                    id="site-contact-phone"
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
