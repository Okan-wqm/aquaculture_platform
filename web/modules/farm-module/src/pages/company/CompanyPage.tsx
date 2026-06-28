/**
 * Company Information Page
 *
 * Standalone page for managing company information (name, org number, address).
 * Accessible from the sidebar as a top-level navigation item.
 */
import React, { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { gql } from 'graphql-request';
import { graphqlClient, useAuth, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

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
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'regulatorySettings') });
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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-3 text-gray-600">Loading company information...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Page Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Company Information</h1>
              <p className="mt-1 text-sm text-gray-500">
                Manage your company details and registration information
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 py-6">
        <div className="max-w-3xl space-y-6">
          {/* Success Message */}
          {saveSuccess && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex items-center text-green-800">
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Company information saved successfully!
              </div>
            </div>
          )}

          {/* Error Message */}
          {updateSettingsMutation.isError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center text-red-800">
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                Failed to save. Please try again.
              </div>
            </div>
          )}

          {/* Company Information Form */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Company Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
                <input
                  type="text"
                  value={formData.companyName}
                  onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  placeholder="Your Company AS"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Organisation Number</label>
                <input
                  type="text"
                  value={formData.organisationNumber}
                  onChange={(e) => setFormData({ ...formData, organisationNumber: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  placeholder="123456789"
                />
              </div>
            </div>
          </div>

          {/* Address */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Company Address</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Street Address</label>
                <input
                  type="text"
                  value={formData.street}
                  onChange={(e) => setFormData({ ...formData, street: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  placeholder="Storgata 1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Postal Code</label>
                <input
                  type="text"
                  value={formData.postalCode}
                  onChange={(e) => setFormData({ ...formData, postalCode: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  placeholder="0123"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                <input
                  type="text"
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  placeholder="Oslo"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
                <input
                  type="text"
                  value={formData.country}
                  onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  placeholder="Norway"
                />
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={updateSettingsMutation.isPending}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {updateSettingsMutation.isPending ? 'Saving...' : 'Save Company Information'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CompanyPage;
