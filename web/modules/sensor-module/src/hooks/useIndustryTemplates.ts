import { useState, useCallback, useEffect, useRef } from 'react';
import { graphqlFetch } from '../config/api';

// Types (M5: proper types for sensorTypes and alertPresets)
export interface SensorTypeSpec {
  typeKey: string;
  displayName: string;
  defaultChannels?: unknown[];
}

export interface AlertPresetSpec {
  presetKey: string;
  displayName: string;
  thresholds?: Record<string, unknown>;
}

export interface IndustryTemplate {
  id: string;
  templateKey: string;
  displayName: string;
  description: string;
  icon: string;
  sensorTypes: SensorTypeSpec[];
  alertPresets: AlertPresetSpec[];
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
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ industryTemplates: IndustryTemplate[] }>(
        GET_INDUSTRY_TEMPLATES_QUERY
      );
      if (!mountedRef.current) return;
      setTemplates(data.industryTemplates);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err as Error);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
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
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const apply = useCallback(async (templateKey: string): Promise<AppliedSensor[] | null> => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ applyIndustryTemplate: AppliedSensor[] }>(
        APPLY_INDUSTRY_TEMPLATE_MUTATION,
        { key: templateKey }
      );
      if (!mountedRef.current) return null;
      return data.applyIndustryTemplate;
    } catch (err) {
      if (!mountedRef.current) return null;
      setError(err as Error);
      return null;
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  return {
    apply,
    loading,
    error,
  };
}
