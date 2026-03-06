import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { graphqlFetch } from '../config/api';
import { DEPLOY_SCADA_PACKAGE } from '../graphql/scada-deploy.queries';

export enum ScadaDeployStatus {
  PENDING = 'pending',
  SENT = 'sent',
  RECEIVED = 'received',
  DEPLOYING = 'deploying',
  VERIFYING = 'verifying',
  SUCCESS = 'success',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
}

export interface DeployScadaPackageResult {
  success: boolean;
  message?: string;
  packageId?: string;
  deviceId?: string;
}

/** Deploy a SCADA package to an edge device */
export function useDeployScadaPackage() {
  const [deployStatus, setDeployStatus] = useState<ScadaDeployStatus | null>(null);

  const mutation = useMutation({
    mutationFn: async ({ packageId, deviceId }: { packageId: string; deviceId: string }) => {
      setDeployStatus(ScadaDeployStatus.PENDING);
      const data = await graphqlFetch<{ deployScadaPackageToEdge: DeployScadaPackageResult }>(
        DEPLOY_SCADA_PACKAGE,
        { packageId, deviceId },
      );
      return data.deployScadaPackageToEdge;
    },
    onSuccess: (result) => {
      setDeployStatus(result.success ? ScadaDeployStatus.SENT : ScadaDeployStatus.FAILED);
    },
    onError: () => {
      setDeployStatus(ScadaDeployStatus.FAILED);
    },
  });

  const resetStatus = useCallback(() => {
    setDeployStatus(null);
  }, []);

  return {
    deploy: mutation.mutate,
    deployAsync: mutation.mutateAsync,
    deployStatus,
    resetStatus,
    isDeploying: mutation.isPending,
    error: mutation.error ? (mutation.error as Error).message : null,
    data: mutation.data,
  };
}
