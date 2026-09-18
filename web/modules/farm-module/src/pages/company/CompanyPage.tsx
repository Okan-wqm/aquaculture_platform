/**
 * Company Information Page
 *
 * Standalone page for managing company information (name, org number, address).
 * Accessible from the sidebar as a top-level navigation item.
 *
 * DATA SOURCE: 100% real — farm-service GraphQL (`regulatorySettings` query +
 * `updateRegulatorySettings` mutation). No mocked data on this page; the
 * input placeholders ("Your Company AS", "Oslo"…) are static hints only.
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
      <div className="flex items-center justify-center py-12" role="status">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: '#146f84' }}></div>
        <span className="ml-3" style={{ color: '#5c7783' }}>Loading company information...</span>
      </div>
    );
  }

  return (
    <div className="sd-page" style={{ maxWidth: 760, margin: '0 auto' }}>
      {/* Page header (mockup pattern: eyebrow + serif title + subtitle) */}
      <div className="sd-pagehead">
        <span className="sd-eyebrow">Overview</span>
        <h1 className="sd-page-title">Company Information</h1>
        <span className="sd-page-sub">Manage your company details and registration information</span>
      </div>

      {/* Success banner */}
      {saveSuccess && (
        <div className="sd-banner sd-banner--success" role="status">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#166f5a" strokeWidth="2.1" style={{ flexShrink: 0 }} aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          Company information saved successfully!
        </div>
      )}

      {/* Failure banner */}
      {updateSettingsMutation.isError && (
        <div className="sd-banner sd-banner--error" role="alert">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8e3a1e" strokeWidth="2.1" style={{ flexShrink: 0 }} aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M15 9l-6 6M9 9l6 6" />
          </svg>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: '#8e3a1e' }}>Failed to save. Please try again.</span>
        </div>
      )}

      {/* Company Details */}
      <div className="sd-card" style={{ padding: '19px 20px' }}>
        <h2 style={{ margin: '0 0 15px', fontSize: 15, fontWeight: 600, color: '#0a1f2b' }}>Company Details</h2>
        <div className="sd-fieldgrid">
          <label className="sd-field">
            <span>Company Name</span>
            <input
              type="text"
              className="sd-input"
              value={formData.companyName}
              onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
              placeholder="Your Company AS"
            />
          </label>
          <label className="sd-field">
            <span>Organisation Number</span>
            <input
              type="text"
              className="sd-input"
              value={formData.organisationNumber}
              onChange={(e) => setFormData({ ...formData, organisationNumber: e.target.value })}
              placeholder="123456789"
            />
          </label>
        </div>
      </div>

      {/* Company Address */}
      <div className="sd-card" style={{ padding: '19px 20px' }}>
        <h2 style={{ margin: '0 0 15px', fontSize: 15, fontWeight: 600, color: '#0a1f2b' }}>Company Address</h2>
        <div className="sd-fieldgrid sd-fieldgrid--address">
          <label className="sd-field sd-field--span2">
            <span>Street Address</span>
            <input
              type="text"
              className="sd-input"
              value={formData.street}
              onChange={(e) => setFormData({ ...formData, street: e.target.value })}
              placeholder="Storgata 1"
            />
          </label>
          <label className="sd-field">
            <span>Postal Code</span>
            <input
              type="text"
              className="sd-input"
              value={formData.postalCode}
              onChange={(e) => setFormData({ ...formData, postalCode: e.target.value })}
              placeholder="0123"
            />
          </label>
          <label className="sd-field">
            <span>City</span>
            <input
              type="text"
              className="sd-input"
              value={formData.city}
              onChange={(e) => setFormData({ ...formData, city: e.target.value })}
              placeholder="Oslo"
            />
          </label>
          <label className="sd-field">
            <span>Country</span>
            <input
              type="text"
              className="sd-input"
              value={formData.country}
              onChange={(e) => setFormData({ ...formData, country: e.target.value })}
              placeholder="Norway"
            />
          </label>
        </div>
      </div>

      {/* Footer row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={updateSettingsMutation.isPending}
          className="sd-btn-teal"
        >
          {updateSettingsMutation.isPending ? 'Saving...' : 'Save Company Information'}
        </button>
      </div>
    </div>
  );
};

export default CompanyPage;
