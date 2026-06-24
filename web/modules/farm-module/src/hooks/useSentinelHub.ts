import { useMutation } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';

const UPDATE_SENTINEL_HUB_INSTANCE_ID_MUTATION = `
  mutation UpdateSentinelHubInstanceId($instanceId: String!) {
    updateSentinelHubInstanceId(instanceId: $instanceId)
  }
`;

export function useUpdateSentinelHubInstanceId() {
  return useMutation({
    mutationFn: async (instanceId: string) => {
      const data = await graphqlClient.request<{
        updateSentinelHubInstanceId: boolean;
      }>(UPDATE_SENTINEL_HUB_INSTANCE_ID_MUTATION, { instanceId });
      return data.updateSentinelHubInstanceId;
    },
  });
}
