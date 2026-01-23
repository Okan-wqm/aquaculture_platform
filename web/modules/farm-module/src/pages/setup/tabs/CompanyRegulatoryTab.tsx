/**
 * Company & Regulatory Tab Component
 *
 * Manages tenant-specific regulatory settings:
 * - Company information (name, org number, address)
 * - Maskinporten OAuth2 credentials
 * - Default contact for regulatory reports
 * - Site → Lokalitetsnummer mappings
 * - Slaughter facility approval
 */
import React, { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { gql, request } from 'graphql-request';

// GraphQL endpoint - use relative path to go through nginx/gateway
const GRAPHQL_ENDPOINT = import.meta.env.VITE_GRAPHQL_URL || '/graphql';

// GraphQL Queries & Mutations
const GET_REGULATORY_SETTINGS = gql`
  query GetRegulatorySettings {
    regulatorySettings {
      id
      companyName
      organisationNumber
      companyAddress
      maskinportenConfigured
      maskinportenEnvironment
      maskinportenClientIdMasked
      maskinportenKeyId
      defaultContactName
      defaultContactEmail
      defaultContactPhone
      siteLocalityMappings {
        siteId
        lokalitetsnummer
        siteName
      }
      slaughterApprovalNumber
      createdAt
      updatedAt
    }
  }
`;

const GET_CONFIGURATION_STATUS = gql`
  query GetConfigurationStatus {
    regulatoryConfigurationStatus {
      hasCompanyInfo
      hasMaskinportenCredentials
      hasDefaultContact
      siteMappingsCount
      hasSlaughterApproval
      isFullyConfigured
    }
  }
`;

const UPDATE_REGULATORY_SETTINGS = gql`
  mutation UpdateRegulatorySettings($input: UpdateRegulatorySettingsInput!) {
    updateRegulatorySettings(input: $input) {
      id
      companyName
      organisationNumber
      maskinportenConfigured
      maskinportenEnvironment
      maskinportenClientIdMasked
      updatedAt
    }
  }
`;

const TEST_MASKINPORTEN_CONNECTION = gql`
  mutation TestMaskinportenConnection {
    testMaskinportenConnection {
      success
      message
      error
      scopes
    }
  }
`;

const GET_SITES = gql`
  query GetSites {
    sites {
      items {
        id
        name
        code
      }
    }
  }
`;

// Types
interface CompanyAddress {
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
}

interface SiteLocalityMapping {
  siteId: string;
  lokalitetsnummer: number;
  siteName?: string;
}

interface RegulatorySettings {
  id?: string;
  companyName?: string;
  organisationNumber?: string;
  companyAddress?: CompanyAddress;
  maskinportenConfigured: boolean;
  maskinportenEnvironment?: string;
  maskinportenClientIdMasked?: string;
  maskinportenKeyId?: string;
  defaultContactName?: string;
  defaultContactEmail?: string;
  defaultContactPhone?: string;
  siteLocalityMappings?: SiteLocalityMapping[];
  slaughterApprovalNumber?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ConfigurationStatus {
  hasCompanyInfo: boolean;
  hasMaskinportenCredentials: boolean;
  hasDefaultContact: boolean;
  siteMappingsCount: number;
  hasSlaughterApproval: boolean;
  isFullyConfigured: boolean;
}

interface Site {
  id: string;
  name: string;
  code: string;
}

// Helper to get auth token
const getAuthHeaders = (): Record<string, string> => {
  const token = localStorage.getItem('access_token');
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
};

export const CompanyRegulatoryTab: React.FC = () => {
  const queryClient = useQueryClient();

  // Form state
  const [formData, setFormData] = useState({
    companyName: '',
    organisationNumber: '',
    street: '',
    postalCode: '',
    city: '',
    country: 'Norway',
    maskinportenClientId: '',
    maskinportenPrivateKey: '',
    maskinportenKeyId: '',
    maskinportenEnvironment: 'TEST',
    defaultContactName: '',
    defaultContactEmail: '',
    defaultContactPhone: '',
    slaughterApprovalNumber: '',
  });

  const [siteMappings, setSiteMappings] = useState<{ [siteId: string]: string }>({});
  const [connectionTestResult, setConnectionTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Queries
  const { data: settingsData, isLoading: settingsLoading } = useQuery({
    queryKey: ['regulatorySettings'],
    queryFn: async () => {
      const response = await request<{ regulatorySettings: RegulatorySettings }>(
        GRAPHQL_ENDPOINT,
        GET_REGULATORY_SETTINGS,
        {},
        getAuthHeaders()
      );
      return response.regulatorySettings;
    },
  });

  const { data: statusData } = useQuery({
    queryKey: ['regulatoryConfigurationStatus'],
    queryFn: async () => {
      const response = await request<{ regulatoryConfigurationStatus: ConfigurationStatus }>(
        GRAPHQL_ENDPOINT,
        GET_CONFIGURATION_STATUS,
        {},
        getAuthHeaders()
      );
      return response.regulatoryConfigurationStatus;
    },
  });

  const { data: sitesData } = useQuery({
    queryKey: ['sites'],
    queryFn: async () => {
      const response = await request<{ sites: { items: Site[] } }>(
        GRAPHQL_ENDPOINT,
        GET_SITES,
        {},
        getAuthHeaders()
      );
      return response.sites.items;
    },
  });

  // Mutations
  const updateSettingsMutation = useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      return request(
        GRAPHQL_ENDPOINT,
        UPDATE_REGULATORY_SETTINGS,
        { input },
        getAuthHeaders()
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['regulatorySettings'] });
      queryClient.invalidateQueries({ queryKey: ['regulatoryConfigurationStatus'] });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    },
  });

  const testConnectionMutation = useMutation({
    mutationFn: async () => {
      return request<{ testMaskinportenConnection: { success: boolean; message?: string; error?: string } }>(
        GRAPHQL_ENDPOINT,
        TEST_MASKINPORTEN_CONNECTION,
        {},
        getAuthHeaders()
      );
    },
    onSuccess: (data) => {
      const result = data.testMaskinportenConnection;
      setConnectionTestResult({
        success: result.success,
        message: result.success ? (result.message || 'Connection successful!') : (result.error || 'Connection failed'),
      });
      setTimeout(() => setConnectionTestResult(null), 5000);
    },
    onError: (error) => {
      setConnectionTestResult({
        success: false,
        message: error instanceof Error ? error.message : 'Connection test failed',
      });
    },
  });

  // Load existing data into form
  useEffect(() => {
    if (settingsData) {
      setFormData({
        companyName: settingsData.companyName || '',
        organisationNumber: settingsData.organisationNumber || '',
        street: settingsData.companyAddress?.street || '',
        postalCode: settingsData.companyAddress?.postalCode || '',
        city: settingsData.companyAddress?.city || '',
        country: settingsData.companyAddress?.country || 'Norway',
        maskinportenClientId: '', // Never pre-fill sensitive data
        maskinportenPrivateKey: '', // Never pre-fill sensitive data
        maskinportenKeyId: settingsData.maskinportenKeyId || '',
        maskinportenEnvironment: settingsData.maskinportenEnvironment || 'TEST',
        defaultContactName: settingsData.defaultContactName || '',
        defaultContactEmail: settingsData.defaultContactEmail || '',
        defaultContactPhone: settingsData.defaultContactPhone || '',
        slaughterApprovalNumber: settingsData.slaughterApprovalNumber || '',
      });

      // Load site mappings
      if (settingsData.siteLocalityMappings) {
        const mappings: { [siteId: string]: string } = {};
        settingsData.siteLocalityMappings.forEach((m) => {
          mappings[m.siteId] = m.lokalitetsnummer.toString();
        });
        setSiteMappings(mappings);
      }
    }
  }, [settingsData]);

  // Handle form submission
  const handleSave = () => {
    const input: Record<string, unknown> = {};

    // Company info
    if (formData.companyName) input.companyName = formData.companyName;
    if (formData.organisationNumber) input.organisationNumber = formData.organisationNumber;

    // Address
    if (formData.street || formData.postalCode || formData.city) {
      input.companyAddress = {
        street: formData.street,
        postalCode: formData.postalCode,
        city: formData.city,
        country: formData.country,
      };
    }

    // Maskinporten credentials (only if provided - don't overwrite existing)
    if (formData.maskinportenClientId) {
      input.maskinportenClientId = formData.maskinportenClientId;
    }
    if (formData.maskinportenPrivateKey) {
      input.maskinportenPrivateKey = formData.maskinportenPrivateKey;
    }
    if (formData.maskinportenKeyId) input.maskinportenKeyId = formData.maskinportenKeyId;
    input.maskinportenEnvironment = formData.maskinportenEnvironment;

    // Default contact
    if (formData.defaultContactName) input.defaultContactName = formData.defaultContactName;
    if (formData.defaultContactEmail) input.defaultContactEmail = formData.defaultContactEmail;
    if (formData.defaultContactPhone) input.defaultContactPhone = formData.defaultContactPhone;

    // Slaughter
    if (formData.slaughterApprovalNumber) input.slaughterApprovalNumber = formData.slaughterApprovalNumber;

    // Site mappings
    const mappingsArray = Object.entries(siteMappings)
      .filter(([, value]) => value && parseInt(value) > 0)
      .map(([siteId, value]) => ({
        siteId,
        lokalitetsnummer: parseInt(value),
      }));
    if (mappingsArray.length > 0) {
      input.siteLocalityMappings = mappingsArray;
    }

    updateSettingsMutation.mutate(input);
  };

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-3 text-gray-600">Loading settings...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Configuration Status Banner */}
      {statusData && (
        <div className={`rounded-lg p-4 ${statusData.isFullyConfigured ? 'bg-green-50 border border-green-200' : 'bg-yellow-50 border border-yellow-200'}`}>
          <div className="flex items-center">
            {statusData.isFullyConfigured ? (
              <svg className="w-5 h-5 text-green-500 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-yellow-500 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            )}
            <span className={`font-medium ${statusData.isFullyConfigured ? 'text-green-800' : 'text-yellow-800'}`}>
              {statusData.isFullyConfigured ? 'Regulatory settings are fully configured' : 'Some regulatory settings are missing'}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-sm">
            <StatusBadge label="Company Info" configured={statusData.hasCompanyInfo} />
            <StatusBadge label="Maskinporten" configured={statusData.hasMaskinportenCredentials} />
            <StatusBadge label="Default Contact" configured={statusData.hasDefaultContact} />
            <StatusBadge label={`Site Mappings (${statusData.siteMappingsCount})`} configured={statusData.siteMappingsCount > 0} />
          </div>
        </div>
      )}

      {/* Success Message */}
      {saveSuccess && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-center text-green-800">
            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Settings saved successfully!
          </div>
        </div>
      )}

      {/* Company Information Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Company Information</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
            <input
              type="text"
              value={formData.companyName}
              onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Your Company AS"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Organisation Number</label>
            <input
              type="text"
              value={formData.organisationNumber}
              onChange={(e) => setFormData({ ...formData, organisationNumber: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="123456789"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Street Address</label>
            <input
              type="text"
              value={formData.street}
              onChange={(e) => setFormData({ ...formData, street: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Storgata 1"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Postal Code</label>
            <input
              type="text"
              value={formData.postalCode}
              onChange={(e) => setFormData({ ...formData, postalCode: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="0123"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
            <input
              type="text"
              value={formData.city}
              onChange={(e) => setFormData({ ...formData, city: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Oslo"
            />
          </div>
        </div>
      </div>

      {/* Maskinporten Integration Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Maskinporten Integration</h2>
          {settingsData?.maskinportenConfigured && (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
              Configured
            </span>
          )}
        </div>
        <p className="text-sm text-gray-600 mb-4">
          Configure Maskinporten OAuth2 credentials for Mattilsynet regulatory reporting API access.
        </p>

        {settingsData?.maskinportenClientIdMasked && (
          <div className="mb-4 p-3 bg-gray-50 rounded-md">
            <p className="text-sm text-gray-600">
              Current Client ID: <code className="bg-gray-200 px-1 rounded">{settingsData.maskinportenClientIdMasked}</code>
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Client ID {settingsData?.maskinportenConfigured && '(leave empty to keep existing)'}
            </label>
            <input
              type="text"
              value={formData.maskinportenClientId}
              onChange={(e) => setFormData({ ...formData, maskinportenClientId: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Key ID (kid)</label>
            <input
              type="text"
              value={formData.maskinportenKeyId}
              onChange={(e) => setFormData({ ...formData, maskinportenKeyId: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="optional-key-id"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Private Key (PEM) {settingsData?.maskinportenConfigured && '(leave empty to keep existing)'}
            </label>
            <textarea
              value={formData.maskinportenPrivateKey}
              onChange={(e) => setFormData({ ...formData, maskinportenPrivateKey: e.target.value })}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Environment</label>
            <select
              value={formData.maskinportenEnvironment}
              onChange={(e) => setFormData({ ...formData, maskinportenEnvironment: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="TEST">Test (test.maskinporten.no)</option>
              <option value="PRODUCTION">Production (maskinporten.no)</option>
              <option value="VER2">Ver2 (ver2.maskinporten.no)</option>
            </select>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => testConnectionMutation.mutate()}
              disabled={!settingsData?.maskinportenConfigured || testConnectionMutation.isPending}
              className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testConnectionMutation.isPending ? 'Testing...' : 'Test Connection'}
            </button>
          </div>
        </div>

        {/* Connection Test Result */}
        {connectionTestResult && (
          <div className={`mt-4 p-3 rounded-md ${connectionTestResult.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
            <div className="flex items-center">
              {connectionTestResult.success ? (
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              )}
              {connectionTestResult.message}
            </div>
          </div>
        )}
      </div>

      {/* Default Contact Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Default Contact for Reports</h2>
        <p className="text-sm text-gray-600 mb-4">
          This contact information will be used as the default for regulatory reports submitted to Mattilsynet.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={formData.defaultContactName}
              onChange={(e) => setFormData({ ...formData, defaultContactName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Ola Nordmann"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={formData.defaultContactEmail}
              onChange={(e) => setFormData({ ...formData, defaultContactEmail: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="ola@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
            <input
              type="tel"
              value={formData.defaultContactPhone}
              onChange={(e) => setFormData({ ...formData, defaultContactPhone: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="+47 123 45 678"
            />
          </div>
        </div>
      </div>

      {/* Site → Lokalitetsnummer Mappings Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Site Locality Mappings</h2>
        <p className="text-sm text-gray-600 mb-4">
          Map your sites to their official Mattilsynet locality numbers (lokalitetsnummer).
        </p>
        {sitesData && sitesData.length > 0 ? (
          <div className="space-y-3">
            {sitesData.map((site) => (
              <div key={site.id} className="flex items-center gap-4">
                <div className="flex-1">
                  <span className="font-medium">{site.name}</span>
                  <span className="text-gray-500 text-sm ml-2">({site.code})</span>
                </div>
                <div className="w-48">
                  <input
                    type="number"
                    value={siteMappings[site.id] || ''}
                    onChange={(e) => setSiteMappings({ ...siteMappings, [site.id]: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Lokalitetsnummer"
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 italic">No sites configured. Add sites first to map locality numbers.</p>
        )}
      </div>

      {/* Slaughter Facility Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Slaughter Facility</h2>
        <p className="text-sm text-gray-600 mb-4">
          Configure slaughter facility approval number for slaughter reports (Slakterapport).
        </p>
        <div className="max-w-md">
          <label className="block text-sm font-medium text-gray-700 mb-1">Approval Number (Godkjenningsnummer)</label>
          <input
            type="text"
            value={formData.slaughterApprovalNumber}
            onChange={(e) => setFormData({ ...formData, slaughterApprovalNumber: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="e.g., N-123"
          />
        </div>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={updateSettingsMutation.isPending}
          className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {updateSettingsMutation.isPending ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
};

// Status Badge Component
const StatusBadge: React.FC<{ label: string; configured: boolean }> = ({ label, configured }) => (
  <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${configured ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
    {configured ? (
      <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
      </svg>
    ) : (
      <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v3.586L7.707 9.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 10.586V7z" clipRule="evenodd" />
      </svg>
    )}
    {label}
  </span>
);

export default CompanyRegulatoryTab;
