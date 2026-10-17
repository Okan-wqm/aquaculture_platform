/**
 * One module's alarms the Active alarms panel lists, and their acknowledgement.
 *
 * WHAT: alertHistory twice in one request — the open alarms and the cleared
 * ones still unacknowledged — of the alarm severities (shared-ui
 * ALARM_SEVERITIES: advisories never reach the panel), reduced to the top rows (model/alarms topAlarms). The
 * acknowledge mutation is alert-engine acknowledgeAlert, which every module
 * role may run; on success the alarm queries refetch so the row, the site
 * counts and the tiles move together.
 */
import {
  ALARM_SEVERITIES,
  graphqlClient,
  useFeedbackMutation,
  useI18n,
  useTenantQuery,
} from '@aquaculture/shared-ui';
import type { AlertModule } from '@platform/shared-ui/generated/graphql-types';
import { useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import { topAlarms, type AlarmRecord, type AlarmRow } from '../model/alarms';

import { MODULE_ALARMS_QUERY } from './dashboard.operations';
import { ALARM_REFRESH_MS } from './useSiteAlarmTallies';
import { useTenantKeys } from './useTenantKeys';

export const PANEL_ALARM_LIMIT = 5;

const ACKNOWLEDGE_ALERT_MUTATION = `
  mutation DashboardAcknowledgeAlert($input: AcknowledgeAlertInput!) {
    acknowledgeAlert(input: $input) {
      id
      acknowledged
    }
  }
`;

export function useModuleAlarms(module: AlertModule): UseQueryResult<readonly AlarmRow[]> {
  return useTenantQuery(
    ['dashboard', 'moduleAlarms', module],
    async ({ signal }): Promise<readonly AlarmRow[]> => {
      const data = await graphqlClient.request<{
        open: AlarmRecord[];
        returned: AlarmRecord[];
      }>(MODULE_ALARMS_QUERY, { module, severities: ALARM_SEVERITIES }, { signal });
      return topAlarms([...data.open, ...data.returned], PANEL_ALARM_LIMIT);
    },
    { staleTime: ALARM_REFRESH_MS, refetchInterval: ALARM_REFRESH_MS },
  );
}

/**
 * Acknowledge one alarm (alert-engine acknowledgeAlert) — the dashboard's one
 * acknowledgement hook, moved here from useDashboardData with the panel it
 * serves. On success the panel's rows and the site counts refetch.
 */
export function useAcknowledgeAlert(): UseMutationResult<unknown, Error, string> {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const { invalidation } = useTenantKeys();
  return useFeedbackMutation<unknown, Error, string>({
    feedback: { success: t('dashboard.alarms.acknowledged') },
    mutationFn: async (alertId: string): Promise<unknown> =>
      graphqlClient.request(ACKNOWLEDGE_ALERT_MUTATION, { input: { alertId } }),
    onSuccess: async (): Promise<void> => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: invalidation('moduleAlarms') }),
        queryClient.invalidateQueries({ queryKey: invalidation('siteAlarmCounts') }),
      ]);
    },
  });
}
