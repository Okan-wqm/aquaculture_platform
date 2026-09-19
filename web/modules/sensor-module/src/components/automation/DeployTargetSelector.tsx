/**
 * Deploy Target Selector - Choose between Path A/B/C deployment targets
 */

import React from 'react';
import { Input, Select } from '@aquaculture/shared-ui';
import { Cpu, Server, Settings2 } from 'lucide-react';

export enum DeployTarget {
  RUST_ENGINE = 'RUST_ENGINE',
  CODESYS_PLC = 'CODESYS_PLC',
  PLC_SETPOINT = 'PLC_SETPOINT',
}

interface PlcConfig {
  targetPlcAddress?: string;
  targetPlcPort?: number;
  targetPlcModel?: string;
  targetPlcProtocol?: string;
}

interface DeployTargetSelectorProps {
  value: DeployTarget;
  onChange: (target: DeployTarget) => void;
  plcConfig: PlcConfig;
  onPlcConfigChange: (config: PlcConfig) => void;
}

const targets = [
  {
    value: DeployTarget.RUST_ENGINE,
    label: 'Rust Engine',
    sublabel: 'Path A',
    description: 'Built-in Rust scripting engine - no PLC required',
    icon: Cpu,
    color: 'indigo',
  },
  {
    value: DeployTarget.CODESYS_PLC,
    label: 'Codesys PLC',
    sublabel: 'Path B',
    description: 'Codesys V3 based PLC - ST source code is sent and compiled on the device',
    icon: Server,
    color: 'emerald',
  },
  {
    value: DeployTarget.PLC_SETPOINT,
    label: 'PLC Setpoint',
    sublabel: 'Path C',
    description: 'Closed PLC - setpoint writing only (OPC-UA, Modbus, S7comm)',
    icon: Settings2,
    color: 'amber',
  },
] as const;

const protocolOptions = [
  { value: 'codesys_v3', label: 'Codesys V3 Gateway' },
  { value: 'opcua', label: 'OPC-UA' },
  { value: 'modbus', label: 'Modbus TCP' },
  { value: 's7comm', label: 'S7comm (Siemens)' },
];

const plcModelOptions = [
  { value: 'wago_pfc200', label: 'WAGO PFC200' },
  { value: 'wago_pfc100', label: 'WAGO PFC100' },
  { value: 'beckhoff_cx', label: 'Beckhoff CX Series' },
  { value: 'festo_cpx_e', label: 'Festo CPX-E' },
  { value: 'schneider_m241', label: 'Schneider M241' },
  { value: 'schneider_m251', label: 'Schneider M251' },
  { value: 'other', label: 'Other Codesys V3 Runtime' },
];

const colorStyles: Record<
  string,
  {
    active: string;
    inactive: string;
    icon: string;
    iconInactive: string;
    badge: string;
    badgeInactive: string;
    dot: string;
  }
> = {
  indigo: {
    active: 'border-primary-500 bg-primary-50 dark:bg-primary-900/20',
    inactive:
      'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500',
    icon: 'text-primary-600 dark:text-primary-400',
    iconInactive: 'text-gray-500 dark:text-gray-400',
    badge: 'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300',
    badgeInactive: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',
    dot: 'bg-primary-500',
  },
  emerald: {
    active: 'border-success-500 bg-success-50 dark:bg-success-900/20',
    inactive:
      'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500',
    icon: 'text-success-600 dark:text-success-400',
    iconInactive: 'text-gray-500 dark:text-gray-400',
    badge: 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300',
    badgeInactive: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',
    dot: 'bg-success-500',
  },
  amber: {
    active: 'border-warning-500 bg-warning-50 dark:bg-warning-900/20',
    inactive:
      'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500',
    icon: 'text-warning-600 dark:text-warning-400',
    iconInactive: 'text-gray-500 dark:text-gray-400',
    badge: 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
    badgeInactive: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',
    dot: 'bg-warning-500',
  },
};

const DeployTargetSelector: React.FC<DeployTargetSelectorProps> = ({
  value,
  onChange,
  plcConfig,
  onPlcConfigChange,
}) => {
  const showPlcConfig = value === DeployTarget.CODESYS_PLC || value === DeployTarget.PLC_SETPOINT;

  return (
    <div className="space-y-4">
      {/* Target Selection Cards */}
      <div
        className="grid grid-cols-1 sm:grid-cols-3 gap-3"
        role="radiogroup"
        aria-label="Deploy target selection"
      >
        {targets.map((target) => {
          const isActive = value === target.value;
          const Icon = target.icon;
          const styles = colorStyles[target.color];
          return (
            <button
              key={target.value}
              role="radio"
              aria-checked={isActive}
              onClick={() => onChange(target.value)}
              className={`relative p-4 rounded-lg border-2 text-left transition-all ${
                isActive ? styles.active : styles.inactive
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`h-5 w-5 ${isActive ? styles.icon : styles.iconInactive}`} />
                <span
                  className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                    isActive ? styles.badge : styles.badgeInactive
                  }`}
                >
                  {target.sublabel}
                </span>
              </div>
              <h4
                className={`font-medium ${isActive ? 'text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}`}
              >
                {target.label}
              </h4>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{target.description}</p>
              {isActive && (
                <div className={`absolute top-2 right-2 w-2 h-2 rounded-full ${styles.dot}`} />
              )}
            </button>
          );
        })}
      </div>

      {/* PLC Configuration */}
      {showPlcConfig && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            PLC Connection Settings
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="plc-ip-address"
                className="block text-xs text-gray-500 dark:text-gray-400 mb-1"
              >
                IP Address
              </label>
              <Input
                fullWidth
                id="plc-ip-address"
                type="text"
                value={plcConfig.targetPlcAddress || ''}
                onChange={(e) =>
                  onPlcConfigChange({ ...plcConfig, targetPlcAddress: e.target.value })
                }
                placeholder="192.168.1.100"
              />
            </div>
            <div>
              <label
                htmlFor="plc-port"
                className="block text-xs text-gray-500 dark:text-gray-400 mb-1"
              >
                Port
              </label>
              <Input
                fullWidth
                id="plc-port"
                type="number"
                value={plcConfig.targetPlcPort || ''}
                onChange={(e) =>
                  onPlcConfigChange({
                    ...plcConfig,
                    targetPlcPort: parseInt(e.target.value) || undefined,
                  })
                }
                placeholder={value === DeployTarget.CODESYS_PLC ? '1217' : '502'}
              />
            </div>
            {value === DeployTarget.CODESYS_PLC && (
              <Select
                id="plc-model"
                label="PLC Model"
                value={plcConfig.targetPlcModel || ''}
                onChange={(e) =>
                  onPlcConfigChange({ ...plcConfig, targetPlcModel: e.target.value })
                }
                placeholder="Select..."
                options={plcModelOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
              />
            )}
            <Select
              id="plc-protocol"
              label="Protocol"
              value={plcConfig.targetPlcProtocol || ''}
              onChange={(e) =>
                onPlcConfigChange({ ...plcConfig, targetPlcProtocol: e.target.value })
              }
              placeholder="Select..."
              options={(value === DeployTarget.CODESYS_PLC
                ? protocolOptions.filter((p) => p.value === 'codesys_v3')
                : protocolOptions.filter((p) => p.value !== 'codesys_v3')
              ).map((opt) => ({ value: opt.value, label: opt.label }))}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default DeployTargetSelector;
