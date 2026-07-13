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
import { Upload, X, Loader2, CheckCircle, AlertCircle } from 'lucide-react';

import { graphqlFetch } from '../../config/api';
import { AUTOMATION_PROGRAMS_QUERY, DEPLOY_PROGRAM_MUTATION } from '../../graphql/automation.queries';

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
  const [deployResult, setDeployResult] = useState<{ success: boolean; error?: string } | null>(null);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Upload className="w-5 h-5 text-indigo-600" />
            Deploy Automation
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {deployResult && (
            <div
              className={`p-3 rounded-lg flex items-center gap-2 ${
                deployResult.success
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
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
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Automation Program</label>
            {loading ? (
              <div className="flex items-center gap-2 py-2 text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading programs...</span>
              </div>
            ) : (
              <select
                value={selectedProgramId}
                onChange={(e) => setSelectedProgramId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="">Select program...</option>
                {programs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.programName} ({p.programCode})
                  </option>
                ))}
              </select>
            )}
            {!loading && programs.length === 0 && (
              <p className="text-xs text-gray-500 mt-1">
                No approved programs found. Create and approve a program first.
              </p>
            )}
          </div>

          {/* Target device selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Target Device</label>
            <select
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="">Select device...</option>
              {boundDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name || d.code} ({d.code})
                </option>
              ))}
            </select>
            {boundDevices.length === 0 && (
              <p className="text-xs text-gray-500 mt-1">
                No devices bound to this process. Bind edge devices to equipment nodes first.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2 bg-gray-50 rounded-b-lg">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            {deployResult?.success ? 'Close' : 'Cancel'}
          </button>
          {!deployResult?.success && (
            <button
              onClick={handleDeploy}
              disabled={!selectedProgramId || !selectedDeviceId || deploying}
              className={`px-4 py-2 text-sm text-white rounded-lg transition-colors flex items-center gap-2 ${
                !selectedProgramId || !selectedDeviceId || deploying
                  ? 'bg-indigo-400 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
            >
              {deploying ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
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
      </div>
    </div>
  );
};

export default DeployAutomationModal;
