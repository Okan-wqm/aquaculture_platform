/**
 * useChannelDetection Hook
 *
 * AI-powered channel detection for sensor data.
 * GraphQL mutations may not exist on the backend yet — they will be wired up later.
 */

import { useState, useCallback } from 'react';
import { getAccessToken, getTenantId } from '@platform/shared-ui/utils/api-client';

// ============================================================================
// GraphQL Helper
// ============================================================================

const API_URL = 'http://localhost:3000/graphql';

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

// ============================================================================
// GraphQL Queries & Mutations
// ============================================================================

const DETECT_CHANNELS_MUTATION = `
  mutation DetectSensorChannels($sensorId: ID!, $samples: JSON!) {
    detectSensorChannels(sensorId: $sensorId, samples: $samples) {
      id
      rawSample
      aiAnalysis
      proposedChannels
      userAction
      createdAt
    }
  }
`;

const APPROVE_PROPOSAL_MUTATION = `
  mutation ApproveChannelProposal($proposalId: ID!, $modifications: JSON) {
    approveChannelProposal(proposalId: $proposalId, modifications: $modifications) {
      id
      channelKey
      displayLabel
      dataType
      unit
    }
  }
`;

const REJECT_PROPOSAL_MUTATION = `
  mutation RejectChannelProposal($proposalId: ID!) {
    rejectChannelProposal(proposalId: $proposalId)
  }
`;

const PENDING_PROPOSALS_QUERY = `
  query PendingChannelProposals($sensorId: ID!) {
    pendingChannelProposals(sensorId: $sensorId) {
      id
      rawSample
      aiAnalysis
      proposedChannels
      createdAt
    }
  }
`;

// ============================================================================
// Types
// ============================================================================

export interface ProposedChannel {
  channelKey: string;
  displayLabel: string;
  dataType: string;
  unit?: string;
  operationalMin?: number;
  operationalMax?: number;
  widgetType?: string;
  confidence: 'high' | 'medium' | 'low';
  alertThresholds?: {
    warning?: { low?: number; high?: number };
    critical?: { low?: number; high?: number };
  };
}

export interface ChannelProposal {
  id: string;
  rawSample?: unknown;
  aiAnalysis?: string;
  proposedChannels: ProposedChannel[];
  userAction?: string;
  createdAt: string;
}

export interface ApprovedChannel {
  id: string;
  channelKey: string;
  displayLabel: string;
  dataType: string;
  unit?: string;
}

// ============================================================================
// Hook
// ============================================================================

export function useChannelDetection(sensorId: string) {
  const [proposals, setProposals] = useState<ChannelProposal[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const detectChannels = useCallback(
    async (samples: unknown[]): Promise<ChannelProposal | null> => {
      if (!sensorId) return null;

      setDetecting(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          detectSensorChannels: ChannelProposal;
        }>(DETECT_CHANNELS_MUTATION, { sensorId, samples });

        const proposal = data.detectSensorChannels;
        // Parse proposedChannels if it comes back as a JSON string
        if (typeof proposal.proposedChannels === 'string') {
          proposal.proposedChannels = JSON.parse(proposal.proposedChannels as unknown as string);
        }

        setProposals((prev) => [...prev, proposal]);
        return proposal;
      } catch (err) {
        setError(err as Error);
        return null;
      } finally {
        setDetecting(false);
      }
    },
    [sensorId],
  );

  const approveProposal = useCallback(
    async (proposalId: string, modifications?: Record<string, unknown>): Promise<ApprovedChannel | null> => {
      setError(null);

      try {
        const data = await graphqlFetch<{
          approveChannelProposal: ApprovedChannel;
        }>(APPROVE_PROPOSAL_MUTATION, {
          proposalId,
          modifications: modifications || null,
        });

        // Remove the approved proposal from local state
        setProposals((prev) =>
          prev.map((p) => ({
            ...p,
            proposedChannels: p.proposedChannels.filter(
              (_ch, _i) => `${p.id}:${_i}` !== proposalId && p.id !== proposalId,
            ),
          })).filter((p) => p.proposedChannels.length > 0),
        );

        return data.approveChannelProposal;
      } catch (err) {
        setError(err as Error);
        return null;
      }
    },
    [],
  );

  const rejectProposal = useCallback(
    async (proposalId: string): Promise<boolean> => {
      setError(null);

      try {
        await graphqlFetch<{ rejectChannelProposal: boolean }>(
          REJECT_PROPOSAL_MUTATION,
          { proposalId },
        );

        // Remove the rejected proposal from local state
        setProposals((prev) =>
          prev.map((p) => ({
            ...p,
            proposedChannels: p.proposedChannels.filter(
              (_ch, _i) => `${p.id}:${_i}` !== proposalId && p.id !== proposalId,
            ),
          })).filter((p) => p.proposedChannels.length > 0),
        );

        return true;
      } catch (err) {
        setError(err as Error);
        return false;
      }
    },
    [],
  );

  const fetchPending = useCallback(async () => {
    if (!sensorId) return;

    setError(null);

    try {
      const data = await graphqlFetch<{
        pendingChannelProposals: ChannelProposal[];
      }>(PENDING_PROPOSALS_QUERY, { sensorId });

      const proposals = (data.pendingChannelProposals || []).map((p) => {
        if (typeof p.proposedChannels === 'string') {
          return { ...p, proposedChannels: JSON.parse(p.proposedChannels as unknown as string) };
        }
        return p;
      });

      setProposals(proposals);
    } catch (err) {
      setError(err as Error);
    }
  }, [sensorId]);

  return {
    proposals,
    detecting,
    error,
    detectChannels,
    approveProposal,
    rejectProposal,
    fetchPending,
  };
}
