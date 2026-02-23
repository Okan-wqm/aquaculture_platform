/**
 * useChannelDetection Hook
 *
 * AI-powered channel detection for sensor data.
 * GraphQL mutations may not exist on the backend yet -- they will be wired up later.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { graphqlFetch } from '../config/api';

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
  const [loadingPending, setLoadingPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const detectChannels = useCallback(
    async (samples: unknown[]): Promise<ChannelProposal | null> => {
      if (!sensorId) return null;

      setDetecting(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          detectSensorChannels: ChannelProposal;
        }>(DETECT_CHANNELS_MUTATION, { sensorId, samples });

        if (!mountedRef.current) return null;

        const proposal = data.detectSensorChannels;
        // Parse proposedChannels if it comes back as a JSON string
        if (typeof proposal.proposedChannels === 'string') {
          proposal.proposedChannels = JSON.parse(proposal.proposedChannels as unknown as string);
        }

        setProposals((prev) => [...prev, proposal]);
        return proposal;
      } catch (err) {
        if (!mountedRef.current) return null;
        setError(err as Error);
        return null;
      } finally {
        if (mountedRef.current) {
          setDetecting(false);
        }
      }
    },
    [sensorId],
  );

  // H2: Simplified filter - just match by proposal ID directly
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

        if (!mountedRef.current) return null;

        // Remove the approved proposal from local state
        setProposals((prev) => prev.filter((p) => p.id !== proposalId));

        return data.approveChannelProposal;
      } catch (err) {
        if (!mountedRef.current) return null;
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

        if (!mountedRef.current) return false;

        // Remove the rejected proposal from local state
        setProposals((prev) => prev.filter((p) => p.id !== proposalId));

        return true;
      } catch (err) {
        if (!mountedRef.current) return false;
        setError(err as Error);
        return false;
      }
    },
    [],
  );

  // M4: loadingPending state
  const fetchPending = useCallback(async () => {
    if (!sensorId) return;

    setError(null);
    setLoadingPending(true);

    try {
      const data = await graphqlFetch<{
        pendingChannelProposals: ChannelProposal[];
      }>(PENDING_PROPOSALS_QUERY, { sensorId });

      if (!mountedRef.current) return;

      const parsedProposals = (data.pendingChannelProposals || []).map((p) => {
        if (typeof p.proposedChannels === 'string') {
          return { ...p, proposedChannels: JSON.parse(p.proposedChannels as unknown as string) };
        }
        return p;
      });

      setProposals(parsedProposals);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err as Error);
    } finally {
      if (mountedRef.current) {
        setLoadingPending(false);
      }
    }
  }, [sensorId]);

  return {
    proposals,
    detecting,
    loadingPending,
    error,
    detectChannels,
    approveProposal,
    rejectProposal,
    fetchPending,
  };
}
