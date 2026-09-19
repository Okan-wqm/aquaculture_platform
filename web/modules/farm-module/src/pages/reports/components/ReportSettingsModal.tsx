/**
 * Report Settings Modal
 *
 * Modal containing regulatory report settings:
 * - Maskinporten Integration
 * - Default Contact for Reports
 * - Site Locality Mappings
 * - Slaughter Facility
 */
import React, { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { gql } from 'graphql-request';
import {
  Modal,
  graphqlClient,
  useAuth,
  createTenantQueryKey,
  createTenantInvalidationKey,
  Spinner,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import { Check, CircleArrowDown, CircleCheck, CircleX, TriangleAlert } from 'lucide-react';

const GET_REGULATORY_SETTINGS = gql`
  query GetRegulatorySettings {
    regulatorySettings {
      id
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
      autoSubmitPolicies {
        reportType
        enabled
      }
      updatedAt
    }
  }
`;

const UPDATE_AUTO_SUBMIT_POLICY = gql`
  mutation UpdateAutoSubmitPolicy($input: UpdateAutoSubmitPolicyInput!) {
    updateAutoSubmitPolicy(input: $input) {
      reportType
      enabled
    }
  }
`;

const GET_CONFIGURATION_STATUS = gql`
  query GetConfigurationStatus {
    regulatoryConfigurationStatus {
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

interface SiteLocalityMapping {
  siteId: string;
  lokalitetsnummer: number;
  siteName?: string;
}

interface RegulatorySettings {
  id?: string;
  maskinportenConfigured: boolean;
  maskinportenEnvironment?: string;
  maskinportenClientIdMasked?: string;
  maskinportenKeyId?: string;
  defaultContactName?: string;
  defaultContactEmail?: string;
  defaultContactPhone?: string;
  siteLocalityMappings?: SiteLocalityMapping[];
  autoSubmitPolicies?: AutoSubmitPolicy[];
  updatedAt?: string;
}

interface AutoSubmitPolicy {
  reportType: string;
  enabled: boolean;
}

/** The five Mattilsynet REST report types that can be auto-submitted. */
const AUTO_SUBMIT_REPORT_TYPES: { value: string; label: string }[] = [
  { value: 'SEA_LICE', label: 'Sea Lice' },
  { value: 'CLEANER_FISH', label: 'Cleaner Fish' },
  { value: 'SMOLT', label: 'Smolt' },
  { value: 'SLAUGHTER_PLANNED', label: 'Planned Slaughter' },
  { value: 'SLAUGHTER_EXECUTED', label: 'Executed Slaughter' },
];

interface ConfigurationStatus {
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

interface ReportSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const StatusBadge: React.FC<{ label: string; configured: boolean }> = ({ label, configured }) => (
  <span
    className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${configured ? 'bg-green-100 text-green-700' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}
  >
    {configured ? (
      <Check className="w-3 h-3 mr-1" aria-hidden="true" />
    ) : (
      <CircleArrowDown className="w-3 h-3 mr-1" aria-hidden="true" />
    )}
    {label}
  </span>
);

export const ReportSettingsModal: React.FC<ReportSettingsModalProps> = ({ open, onClose }) => {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  const [formData, setFormData] = useState({
    maskinportenClientId: '',
    maskinportenPrivateKey: '',
    maskinportenKeyId: '',
    maskinportenEnvironment: 'TEST',
    defaultContactName: '',
    defaultContactEmail: '',
    defaultContactPhone: '',
  });

  const [siteMappings, setSiteMappings] = useState<{ [siteId: string]: string }>({});
  const [connectionTestResult, setConnectionTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const { data: settingsData, isLoading } = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'regulatorySettings'),
    queryFn: async () => {
      const response = await graphqlClient.request<{ regulatorySettings: RegulatorySettings }>(
        GET_REGULATORY_SETTINGS,
      );
      return response.regulatorySettings;
    },
    enabled: open,
  });

  const { data: statusData } = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'regulatoryConfigurationStatus'),
    queryFn: async () => {
      const response = await graphqlClient.request<{
        regulatoryConfigurationStatus: ConfigurationStatus;
      }>(GET_CONFIGURATION_STATUS);
      return response.regulatoryConfigurationStatus;
    },
    enabled: open,
  });

  const { data: sitesData } = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'sites'),
    queryFn: async () => {
      const response = await graphqlClient.request<{ sites: { items: Site[] } }>(GET_SITES);
      return response.sites.items;
    },
    enabled: open,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      return graphqlClient.request(UPDATE_REGULATORY_SETTINGS, { input });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'regulatorySettings'),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'regulatoryConfigurationStatus'),
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    },
  });

  const updateAutoSubmitMutation = useMutation({
    mutationFn: async (input: { reportType: string; enabled: boolean }) => {
      return graphqlClient.request(UPDATE_AUTO_SUBMIT_POLICY, { input });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'regulatorySettings'),
      });
    },
  });

  const testConnectionMutation = useMutation({
    mutationFn: async () => {
      return graphqlClient.request<{
        testMaskinportenConnection: { success: boolean; message?: string; error?: string };
      }>(TEST_MASKINPORTEN_CONNECTION);
    },
    onSuccess: (data) => {
      const result = data.testMaskinportenConnection;
      setConnectionTestResult({
        success: result.success,
        message: result.success
          ? result.message || 'Connection successful!'
          : result.error || 'Connection failed',
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

  useEffect(() => {
    if (settingsData) {
      setFormData({
        maskinportenClientId: '',
        maskinportenPrivateKey: '',
        maskinportenKeyId: settingsData.maskinportenKeyId || '',
        maskinportenEnvironment: settingsData.maskinportenEnvironment || 'TEST',
        defaultContactName: settingsData.defaultContactName || '',
        defaultContactEmail: settingsData.defaultContactEmail || '',
        defaultContactPhone: settingsData.defaultContactPhone || '',
      });

      if (settingsData.siteLocalityMappings) {
        const mappings: { [siteId: string]: string } = {};
        settingsData.siteLocalityMappings.forEach((m) => {
          mappings[m.siteId] = m.lokalitetsnummer.toString();
        });
        setSiteMappings(mappings);
      }
    }
  }, [settingsData]);

  const handleSave = () => {
    const input: Record<string, unknown> = {};

    // Maskinporten credentials (only if provided)
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

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Report Settings"
      description="Configure settings for regulatory report submission"
      size="lg"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={handleSave}
            disabled={updateSettingsMutation.isPending || isLoading}
          >
            {updateSettingsMutation.isPending ? 'Saving...' : 'Save Settings'}
          </Button>
        </>
      }
    >
      <div className="max-h-[calc(100vh-12rem)] overflow-y-auto space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="lg" />
            <span className="ml-3 text-gray-600 dark:text-gray-400">Loading settings...</span>
          </div>
        ) : (
          <>
            {/* Configuration Status Banner */}
            {statusData && (
              <div
                className={`rounded-lg p-4 ${statusData.isFullyConfigured ? 'bg-green-50 border border-green-200' : 'bg-yellow-50 border border-yellow-200'}`}
              >
                <div className="flex items-center">
                  {statusData.isFullyConfigured ? (
                    <CircleCheck className="w-5 h-5 text-green-500 mr-2" aria-hidden="true" />
                  ) : (
                    <TriangleAlert className="w-5 h-5 text-yellow-500 mr-2" aria-hidden="true" />
                  )}
                  <span
                    className={`font-medium ${statusData.isFullyConfigured ? 'text-green-800' : 'text-yellow-800'}`}
                  >
                    {statusData.isFullyConfigured
                      ? 'Report settings are fully configured'
                      : 'Some report settings need attention'}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-sm">
                  <StatusBadge
                    label="Maskinporten"
                    configured={statusData.hasMaskinportenCredentials}
                  />
                  <StatusBadge label="Default Contact" configured={statusData.hasDefaultContact} />
                  <StatusBadge
                    label={`Site Mappings (${statusData.siteMappingsCount})`}
                    configured={statusData.siteMappingsCount > 0}
                  />
                  <StatusBadge
                    label="Slaughter Approval"
                    configured={statusData.hasSlaughterApproval}
                  />
                </div>
              </div>
            )}

            {/* Success Message */}
            {saveSuccess && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center text-green-800">
                  <CircleCheck className="w-5 h-5 mr-2" aria-hidden="true" />
                  Settings saved successfully!
                </div>
              </div>
            )}

            {/* Maskinporten Integration */}
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  Maskinporten Integration
                </h3>
                {settingsData?.maskinportenConfigured && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                    Configured
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Configure Maskinporten OAuth2 credentials for Mattilsynet regulatory reporting API
                access.
              </p>

              {settingsData?.maskinportenClientIdMasked && (
                <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-md">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Current Client ID:{' '}
                    <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">
                      {settingsData.maskinportenClientIdMasked}
                    </code>
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Client ID{' '}
                    {settingsData?.maskinportenConfigured && '(leave empty to keep existing)'}
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.maskinportenClientId}
                    onChange={(e) =>
                      setFormData({ ...formData, maskinportenClientId: e.target.value })
                    }
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Key ID (kid)
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.maskinportenKeyId}
                    onChange={(e) =>
                      setFormData({ ...formData, maskinportenKeyId: e.target.value })
                    }
                    placeholder="optional-key-id"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Private Key (PEM){' '}
                    {settingsData?.maskinportenConfigured && '(leave empty to keep existing)'}
                  </label>
                  <Textarea
                    className="font-mono"
                    fullWidth
                    value={formData.maskinportenPrivateKey}
                    onChange={(e) =>
                      setFormData({ ...formData, maskinportenPrivateKey: e.target.value })
                    }
                    rows={3}
                    placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Environment
                  </label>
                  <Select
                    fullWidth
                    options={[
                      { value: 'TEST', label: 'Test (test.maskinporten.no)' },
                      { value: 'PRODUCTION', label: 'Production (maskinporten.no)' },
                      { value: 'VER2', label: 'Ver2 (ver2.maskinporten.no)' },
                    ]}
                    value={formData.maskinportenEnvironment}
                    onChange={(e) =>
                      setFormData({ ...formData, maskinportenEnvironment: e.target.value })
                    }
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => testConnectionMutation.mutate()}
                    disabled={
                      !settingsData?.maskinportenConfigured || testConnectionMutation.isPending
                    }
                    className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-hidden focus:ring-2 focus:ring-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {testConnectionMutation.isPending ? 'Testing...' : 'Test Connection'}
                  </button>
                </div>
              </div>

              {connectionTestResult && (
                <div
                  className={`mt-4 p-3 rounded-md ${connectionTestResult.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}
                >
                  <div className="flex items-center">
                    {connectionTestResult.success ? (
                      <CircleCheck className="w-5 h-5 mr-2" aria-hidden="true" />
                    ) : (
                      <CircleX className="w-5 h-5 mr-2" aria-hidden="true" />
                    )}
                    {connectionTestResult.message}
                  </div>
                </div>
              )}
            </div>

            {/* Default Contact */}
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Default Contact for Reports
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                This contact information will be used as the default for regulatory reports
                submitted to Mattilsynet.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Name
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.defaultContactName}
                    onChange={(e) =>
                      setFormData({ ...formData, defaultContactName: e.target.value })
                    }
                    placeholder="Ola Nordmann"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Email
                  </label>
                  <Input
                    fullWidth
                    type="email"
                    value={formData.defaultContactEmail}
                    onChange={(e) =>
                      setFormData({ ...formData, defaultContactEmail: e.target.value })
                    }
                    placeholder="ola@example.com"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Phone
                  </label>
                  <Input
                    fullWidth
                    type="tel"
                    value={formData.defaultContactPhone}
                    onChange={(e) =>
                      setFormData({ ...formData, defaultContactPhone: e.target.value })
                    }
                    placeholder="+47 123 45 678"
                  />
                </div>
              </div>
            </div>

            {/* Site Locality Mappings */}
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Site Locality Mappings
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Map your sites to their official Mattilsynet locality numbers (lokalitetsnummer).
              </p>
              {sitesData && sitesData.length > 0 ? (
                <div className="space-y-3">
                  {sitesData.map((site) => (
                    <div key={site.id} className="flex items-center gap-4">
                      <div className="flex-1">
                        <span className="font-medium">{site.name}</span>
                        <span className="text-gray-500 dark:text-gray-400 text-sm ml-2">
                          ({site.code})
                        </span>
                      </div>
                      <div className="w-48">
                        <Input
                          fullWidth
                          type="number"
                          value={siteMappings[site.id] || ''}
                          onChange={(e) =>
                            setSiteMappings({ ...siteMappings, [site.id]: e.target.value })
                          }
                          placeholder="Lokalitetsnummer"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 dark:text-gray-400 italic">
                  No sites configured. Add sites first to map locality numbers.
                </p>
              )}
            </div>

            {/* Slaughter Facility — managed in the facility catalog (SSoT) */}
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Slaughter Facility
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Slaughter facilities and their approval numbers (godkjenningsnummer) are managed in
                Setup → Slaughter Facilities. The default facility supplies the godkjenningsnummer
                on the executed/planned slaughter reports — no approval number is entered here.
              </p>
              <div className="mt-2">
                <span
                  className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${
                    statusData?.hasSlaughterApproval
                      ? 'bg-green-100 text-green-800'
                      : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {statusData?.hasSlaughterApproval
                    ? 'Default facility configured'
                    : 'No default facility yet'}
                </span>
              </div>
            </div>

            {/* Automated submission (RPT-003) */}
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
                Automated submission
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                When enabled, a READY draft for the report type is submitted to Mattilsynet
                automatically each period — no manual approval needed. Leave off to review and
                approve every submission yourself.
              </p>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                {AUTO_SUBMIT_REPORT_TYPES.map((rt) => {
                  const enabled =
                    settingsData?.autoSubmitPolicies?.find((p) => p.reportType === rt.value)
                      ?.enabled ?? false;
                  return (
                    <li key={rt.value} className="flex items-center justify-between py-2">
                      <span className="text-sm text-gray-800 dark:text-gray-200">{rt.label}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={`Auto-submit ${rt.label}`}
                        disabled={updateAutoSubmitMutation.isPending}
                        onClick={() =>
                          updateAutoSubmitMutation.mutate({
                            reportType: rt.value,
                            enabled: !enabled,
                          })
                        }
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                          enabled ? 'bg-blue-600' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-900 transition-transform ${
                            enabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default ReportSettingsModal;
