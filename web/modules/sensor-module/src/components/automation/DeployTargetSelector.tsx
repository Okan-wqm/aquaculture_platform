/**
 * Deploy Target Selector - Choose between Yol A/B/C deployment targets
 */

import React from 'react';
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
    sublabel: 'Yol A',
    description: 'Dahili Rust betik motoru - PLC gerektirmez',
    icon: Cpu,
    color: 'indigo',
  },
  {
    value: DeployTarget.CODESYS_PLC,
    label: 'Codesys PLC',
    sublabel: 'Yol B',
    description: 'Codesys V3 tabanli PLC - ST kaynak kodu gonderilir, cihaz uzerinde derlenir',
    icon: Server,
    color: 'emerald',
  },
  {
    value: DeployTarget.PLC_SETPOINT,
    label: 'PLC Setpoint',
    sublabel: 'Yol C',
    description: 'Kapali PLC - sadece setpoint yazma (OPC-UA, Modbus, S7comm)',
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
  { value: 'other', label: 'Diger Codesys V3 Runtime' },
];

const colorStyles: Record<string, { active: string; inactive: string; icon: string; iconInactive: string; badge: string; badgeInactive: string; dot: string }> = {
  indigo: {
    active: 'border-indigo-500 bg-indigo-50',
    inactive: 'border-gray-200 hover:border-gray-300',
    icon: 'text-indigo-600',
    iconInactive: 'text-gray-400',
    badge: 'bg-indigo-100 text-indigo-700',
    badgeInactive: 'bg-gray-100 text-gray-500',
    dot: 'bg-indigo-500',
  },
  emerald: {
    active: 'border-emerald-500 bg-emerald-50',
    inactive: 'border-gray-200 hover:border-gray-300',
    icon: 'text-emerald-600',
    iconInactive: 'text-gray-400',
    badge: 'bg-emerald-100 text-emerald-700',
    badgeInactive: 'bg-gray-100 text-gray-500',
    dot: 'bg-emerald-500',
  },
  amber: {
    active: 'border-amber-500 bg-amber-50',
    inactive: 'border-gray-200 hover:border-gray-300',
    icon: 'text-amber-600',
    iconInactive: 'text-gray-400',
    badge: 'bg-amber-100 text-amber-700',
    badgeInactive: 'bg-gray-100 text-gray-500',
    dot: 'bg-amber-500',
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" role="radiogroup" aria-label="Deploy target selection">
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
                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                  isActive ? styles.badge : styles.badgeInactive
                }`}>
                  {target.sublabel}
                </span>
              </div>
              <h4 className={`font-medium ${isActive ? 'text-gray-900' : 'text-gray-700'}`}>
                {target.label}
              </h4>
              <p className="text-xs text-gray-500 mt-1">{target.description}</p>
              {isActive && (
                <div className={`absolute top-2 right-2 w-2 h-2 rounded-full ${styles.dot}`} />
              )}
            </button>
          );
        })}
      </div>

      {/* PLC Configuration */}
      {showPlcConfig && (
        <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
          <h4 className="text-sm font-medium text-gray-700 mb-3">
            PLC Baglanti Ayarlari
          </h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="plc-ip-address" className="block text-xs text-gray-500 mb-1">IP Adresi</label>
              <input
                id="plc-ip-address"
                type="text"
                value={plcConfig.targetPlcAddress || ''}
                onChange={(e) => onPlcConfigChange({ ...plcConfig, targetPlcAddress: e.target.value })}
                placeholder="192.168.1.100"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
              />
            </div>
            <div>
              <label htmlFor="plc-port" className="block text-xs text-gray-500 mb-1">Port</label>
              <input
                id="plc-port"
                type="number"
                value={plcConfig.targetPlcPort || ''}
                onChange={(e) => onPlcConfigChange({ ...plcConfig, targetPlcPort: parseInt(e.target.value) || undefined })}
                placeholder={value === DeployTarget.CODESYS_PLC ? '1217' : '502'}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
              />
            </div>
            {value === DeployTarget.CODESYS_PLC && (
              <div>
                <label htmlFor="plc-model" className="block text-xs text-gray-500 mb-1">PLC Modeli</label>
                <select
                  id="plc-model"
                  value={plcConfig.targetPlcModel || ''}
                  onChange={(e) => onPlcConfigChange({ ...plcConfig, targetPlcModel: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
                >
                  <option value="">Sec...</option>
                  {plcModelOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="plc-protocol" className="block text-xs text-gray-500 mb-1">Protokol</label>
              <select
                id="plc-protocol"
                aria-label="PLC communication protocol"
                value={plcConfig.targetPlcProtocol || ''}
                onChange={(e) => onPlcConfigChange({ ...plcConfig, targetPlcProtocol: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
              >
                <option value="">Sec...</option>
                {(value === DeployTarget.CODESYS_PLC
                  ? protocolOptions.filter((p) => p.value === 'codesys_v3')
                  : protocolOptions.filter((p) => p.value !== 'codesys_v3')
                ).map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DeployTargetSelector;
