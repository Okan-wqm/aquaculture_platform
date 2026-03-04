/**
 * Deploy Process to Edge Device hook
 * TanStack React Query useMutation pattern
 */

import { useMutation } from '@tanstack/react-query';
import { graphqlFetch } from '../config/api';

const DEPLOY_PROCESS_TO_EDGE = `
  mutation DeployProcessToEdge($processId: ID!, $deviceId: ID!) {
    deployProcessToEdge(processId: $processId, deviceId: $deviceId) {
      success
      message
    }
  }
`;

export function useDeployProcessToEdge() {
  return useMutation({
    mutationFn: async ({ processId, deviceId }: { processId: string; deviceId: string }) => {
      const data = await graphqlFetch<{ deployProcessToEdge: { success: boolean; message?: string } }>(
        DEPLOY_PROCESS_TO_EDGE,
        { processId, deviceId },
      );
      return data.deployProcessToEdge;
    },
  });
}
