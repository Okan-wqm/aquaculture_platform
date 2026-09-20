/**
 * DeployAutomationModal
 *
 * Deploy an approved automation program to one of the edge devices bound to the
 * current process (the devices attached to P&ID equipment nodes). Shared by the
 * legacy ProcessEditorPage and the UnifiedEditorPage so both editors expose the
 * exact same automation-deploy path — extracted from ProcessEditorPage as part
 * of the Unified↔ProcessEditor feature-parity work (6c) that precedes retiring
 * the process page shell.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Spinner, Button, Select } from '@aquaculture/shared-ui';
import { Upload, CheckCircle, AlertCircle } from 'lucide-react';

import { graphqlFetch } from '../../config/api';
import {
  AUTOMATION_PROGRAMS_QUERY,
  DEPLOY_PROGRAM_MUTATION,
} from '../../graphql/automation.queries';

export interface DeployAutomationModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Bound devices extracted from the process's equipment nodes. */
  boundDevices: Array<{ id: string; code: string; name?: string }>;
}

export const DeployAutomationModal: React.FC<DeployAutomationModalProps> = ({
  isOpen,
  onClose,
  boundDevices,
}) => {
  const graphqlRequest = useCallback(
    (query: string, variables?: Record<string, unknown>) =>
      graphqlFetch<Record<string, unknown>>(query, variables),
    [],
  );
  const [programs, setPrograms] = useState<
    Array<{ id: string; programCode: string; programName: string; status: string }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [selectedProgramId, setSelectedProgramId] = useState<string>('');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ success: boolean; error?: string } | null>(
    null,
  );

  // Fetch the approved program list when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setDeployResult(null);
    setLoading(true);

    graphqlRequest(AUTOMATION_PROGRAMS_QUERY, { filter: { status: 'APPROVED' }, limit: 50 })
      .then((data: Record<string, unknown>) => {
        // The query returns a paginated CONNECTION ({ items, total, ... }),
        // not a bare array — reading the connection as an array left the
        // program list permanently empty (UI-005 / SENSOR-HIGH-049).
        const connection = data?.automationPrograms as
          | {
              items?: Array<{
                id: string;
                programCode: string;
                programName: string;
                status: string;
              }>;
            }
          | undefined;
        setPrograms(connection?.items ?? []);
      })
      .catch(() => {
        // Surfaced to the user as the empty-list hint below; no console (no-console).
        setPrograms([]);
      })
      .finally(() => setLoading(false));
  }, [isOpen, graphqlRequest]);

  // Preselect the first bound device.
  useEffect(() => {
    if (boundDevices.length > 0 && !selectedDeviceId) {
      setSelectedDeviceId(boundDevices[0].id);
    }
  }, [boundDevices, selectedDeviceId]);

  const handleDeploy = async (): Promise<void> => {
    if (!selectedProgramId || !selectedDeviceId) return;
    setDeploying(true);
    setDeployResult(null);

    try {
      const result = await graphqlRequest(DEPLOY_PROGRAM_MUTATION, {
        input: { programId: selectedProgramId, deviceId: selectedDeviceId },
      });
      const deployData = result?.deployProgram as { success: boolean; error?: string } | undefined;
      if (deployData?.success) {
        setDeployResult({ success: true });
      } else {
        setDeployResult({ success: false, error: deployData?.error || 'Unknown error' });
      }
    } catch (error) {
      setDeployResult({ success: false, error: (error as Error).message });
    } finally {
      setDeploying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      bodyClassName=""
      title={
        <span className="flex items-center gap-2">
          <Upload className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          Deploy Automation
        </span>
      }
    >
      {/* Content */}
      <div className="p-4 space-y-4">
        {deployResult && (
          <div
            className={`p-3 rounded-lg flex items-center gap-2 ${
              deployResult.success
                ? 'bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300 border border-success-200 dark:border-success-800'
                : 'bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-300 border border-error-200 dark:border-error-800'
            }`}
          >
            {deployResult.success ? (
              <>
                <CheckCircle className="w-5 h-5" />
                <span className="text-sm font-medium">Program deployed successfully!</span>
              </>
            ) : (
              <>
                <AlertCircle className="w-5 h-5" />
                <span className="text-sm">{deployResult.error}</span>
              </>
            )}
          </div>
        )}

        {/* Program selection */}
        <Select
          id="deploy-automation-program"
          label="Automation Program"
          value={selectedProgramId}
          onChange={(e) => setSelectedProgramId(e.target.value)}
          disabled={loading}
          placeholder={loading ? 'Loading programs...' : 'Select program...'}
          helperText={
            !loading && programs.length === 0
              ? 'No approved programs found. Create and approve a program first.'
              : undefined
          }
          options={programs.map((p) => ({
            value: p.id,
            label: `${p.programName} (${p.programCode})`,
          }))}
        />

        {/* Target device selection */}
        <Select
          id="deploy-target-device"
          label="Target Device"
          value={selectedDeviceId}
          onChange={(e) => setSelectedDeviceId(e.target.value)}
          placeholder="Select device..."
          helperText={
            boundDevices.length === 0
              ? 'No devices bound to this process. Bind edge devices to equipment nodes first.'
              : undefined
          }
          options={boundDevices.map((d) => ({
            value: d.id,
            label: `${d.name || d.code} (${d.code})`,
          }))}
        />
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2 bg-gray-50 dark:bg-gray-800 rounded-b-lg">
        <Button variant="secondary" onClick={onClose}>
          {deployResult?.success ? 'Close' : 'Cancel'}
        </Button>
        {!deployResult?.success && (
          <button
            onClick={handleDeploy}
            disabled={!selectedProgramId || !selectedDeviceId || deploying}
            className={`px-4 py-2 text-sm text-white rounded-lg transition-colors flex items-center gap-2 ${
              !selectedProgramId || !selectedDeviceId || deploying
                ? 'bg-primary-400 cursor-not-allowed'
                : 'bg-primary-600 hover:bg-primary-700'
            }`}
          >
            {deploying ? (
              <>
                <Spinner size="sm" color="inherit" />
                Deploying...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Deploy
              </>
            )}
          </button>
        )}
      </div>
    </Modal>
  );
};

export default DeployAutomationModal;
