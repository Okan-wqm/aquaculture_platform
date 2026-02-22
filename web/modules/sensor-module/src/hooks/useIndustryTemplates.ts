import { useState, useCallback, useEffect } from 'react';
import { getAccessToken, getTenantId } from '@platform/shared-ui/utils/api-client';

// API base URL
const API_URL = 'http://localhost:3000/graphql';

// Simple GraphQL fetch helper (same pattern as useSensorRegistration)
async function graphqlFetch<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = getAccessToken();
  const tenantId = getTenantId();

  const response = await fetch(API_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// Types
export interface IndustryTemplate {
  id: string;
  templateKey: string;
  displayName: string;
  description: string;
  icon: string;
  sensorTypes: string[];
  alertPresets: string[];
}

export interface AppliedSensor {
  id: string;
  typeKey: string;
  displayName: string;
  category: string;
}

// GraphQL Queries
const GET_INDUSTRY_TEMPLATES_QUERY = `
  query GetIndustryTemplates {
    industryTemplates {
      id
      templateKey
      displayName
      description
      icon
      sensorTypes
      alertPresets
    }
  }
`;

// GraphQL Mutations
const APPLY_INDUSTRY_TEMPLATE_MUTATION = `
  mutation ApplyIndustryTemplate($key: String!) {
    applyIndustryTemplate(templateKey: $key) {
      id
      typeKey
      displayName
      category
    }
  }
`;

// Hook to fetch industry templates
export function useIndustryTemplates() {
  const [templates, setTemplates] = useState<IndustryTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ industryTemplates: IndustryTemplate[] }>(
        GET_INDUSTRY_TEMPLATES_QUERY
      );
      setTemplates(data.industryTemplates);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return {
    templates,
    loading,
    error,
    refetch,
  };
}

// Hook to apply an industry template
export function useApplyTemplate() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const apply = useCallback(async (templateKey: string): Promise<AppliedSensor[] | null> => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ applyIndustryTemplate: AppliedSensor[] }>(
        APPLY_INDUSTRY_TEMPLATE_MUTATION,
        { key: templateKey }
      );
      return data.applyIndustryTemplate;
    } catch (err) {
      setError(err as Error);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    apply,
    loading,
    error,
  };
}
