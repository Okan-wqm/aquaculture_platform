/**
 * Company Information Page
 *
 * Standalone page for managing company information (name, org number, address).
 * Accessible from the sidebar as a top-level navigation item.
 */
import React, { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { gql } from 'graphql-request';
import {
  graphqlClient,
  useAuth,
  createTenantQueryKey,
  createTenantInvalidationKey,
  Spinner,
  PageHeader,
  Button,
  Input,
} from '@aquaculture/shared-ui';
import { CircleCheck, CircleX } from 'lucide-react';

const GET_REGULATORY_SETTINGS = gql`
  query GetRegulatorySettings {
    regulatorySettings {
      id
      companyName
      organisationNumber
      companyAddress {
        street
        postalCode
        city
        country
      }
      updatedAt
    }
  }
`;

const UPDATE_REGULATORY_SETTINGS = gql`
  mutation UpdateRegulatorySettings($input: UpdateRegulatorySettingsInput!) {
    updateRegulatorySettings(input: $input) {
      id
      companyName
      organisationNumber
      updatedAt
    }
  }
`;

interface CompanyAddress {
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
}

interface RegulatorySettings {
  id?: string;
  companyName?: string;
  organisationNumber?: string;
  companyAddress?: CompanyAddress;
  updatedAt?: string;
}

export const CompanyPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  const [formData, setFormData] = useState({
    companyName: '',
    organisationNumber: '',
    street: '',
    postalCode: '',
    city: '',
    country: 'Norway',
  });

  const [saveSuccess, setSaveSuccess] = useState(false);

  const { data: settingsData, isLoading } = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'regulatorySettings'),
    queryFn: async () => {
      const response = await graphqlClient.request<{ regulatorySettings: RegulatorySettings }>(
        GET_REGULATORY_SETTINGS,
      );
      return response.regulatorySettings;
    },
    enabled: !!tenantId,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      return graphqlClient.request(UPDATE_REGULATORY_SETTINGS, { input });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'regulatorySettings'),
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    },
  });

  useEffect(() => {
    if (settingsData) {
      setFormData({
        companyName: settingsData.companyName || '',
        organisationNumber: settingsData.organisationNumber || '',
        street: settingsData.companyAddress?.street || '',
        postalCode: settingsData.companyAddress?.postalCode || '',
        city: settingsData.companyAddress?.city || '',
        country: settingsData.companyAddress?.country || 'Norway',
      });
    }
  }, [settingsData]);

  const handleSave = () => {
    const input: Record<string, unknown> = {};

    if (formData.companyName) input.companyName = formData.companyName;
    if (formData.organisationNumber) input.organisationNumber = formData.organisationNumber;

    if (formData.street || formData.postalCode || formData.city) {
      input.companyAddress = {
        street: formData.street,
        postalCode: formData.postalCode,
        city: formData.city,
        country: formData.country,
      };
    }

    updateSettingsMutation.mutate(input);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
        <span className="ml-3 text-gray-600 dark:text-gray-400">
          Loading company information...
        </span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800">
      {/* Page Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6 py-6">
          <PageHeader
            title="Company Information"
            description="Manage your company details and registration information"
          />
        </div>
      </div>

      <div className="px-4 sm:px-6 py-6">
        <div className="max-w-3xl space-y-6">
          {/* Success Message */}
          {saveSuccess && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex items-center text-green-800">
                <CircleCheck className="w-5 h-5 mr-2" aria-hidden="true" />
                Company information saved successfully!
              </div>
            </div>
          )}

          {/* Error Message */}
          {updateSettingsMutation.isError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center text-red-800">
                <CircleX className="w-5 h-5 mr-2" aria-hidden="true" />
                Failed to save. Please try again.
              </div>
            </div>
          )}

          {/* Company Information Form */}
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Company Details
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Company Name
                </label>
                <Input
                  fullWidth
                  type="text"
                  value={formData.companyName}
                  onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
                  placeholder="Your Company AS"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Organisation Number
                </label>
                <Input
                  fullWidth
                  type="text"
                  value={formData.organisationNumber}
                  onChange={(e) => setFormData({ ...formData, organisationNumber: e.target.value })}
                  placeholder="123456789"
                />
              </div>
            </div>
          </div>

          {/* Address */}
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Company Address
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Street Address
                </label>
                <Input
                  fullWidth
                  type="text"
                  value={formData.street}
                  onChange={(e) => setFormData({ ...formData, street: e.target.value })}
                  placeholder="Storgata 1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Postal Code
                </label>
                <Input
                  fullWidth
                  type="text"
                  value={formData.postalCode}
                  onChange={(e) => setFormData({ ...formData, postalCode: e.target.value })}
                  placeholder="0123"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  City
                </label>
                <Input
                  fullWidth
                  type="text"
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  placeholder="Oslo"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Country
                </label>
                <Input
                  fullWidth
                  type="text"
                  value={formData.country}
                  onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                  placeholder="Norway"
                />
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <Button
              variant="primary"
              type="button"
              onClick={handleSave}
              disabled={updateSettingsMutation.isPending}
            >
              {updateSettingsMutation.isPending ? 'Saving...' : 'Save Company Information'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CompanyPage;
