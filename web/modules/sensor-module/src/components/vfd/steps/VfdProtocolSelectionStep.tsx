import React from 'react';
import {
  VfdBrandInfo,
  VfdProtocol,
  VFD_PROTOCOL_NAMES,
  VFD_PROTOCOL_DESCRIPTIONS,
} from '../../../types/vfd.types';
import { colors as themeColors } from '@aquaculture/shared-ui';
import {
  Building2,
  CircleCheck,
  Columns3,
  Cpu,
  Database,
  FlaskConical,
  Globe,
  Info,
  Server,
} from 'lucide-react';

interface VfdProtocolSelectionStepProps {
  brand: VfdBrandInfo;
  selectedProtocol?: VfdProtocol;
  onSelect: (protocol: VfdProtocol) => void;
}

// Protocol icons and colors
const PROTOCOL_CONFIG: Record<
  VfdProtocol,
  {
    icon: React.ReactNode;
    color: string;
    bgColor: string;
    connectionType: 'serial' | 'ethernet' | 'fieldbus';
    speed: 'low' | 'medium' | 'high';
  }
> = {
  [VfdProtocol.MODBUS_RTU]: {
    icon: <Cpu className="w-6 h-6" aria-hidden="true" />,
    color: themeColors.warning[500],
    bgColor: themeColors.warning[100],
    connectionType: 'serial',
    speed: 'low',
  },
  [VfdProtocol.MODBUS_TCP]: {
    icon: <Globe className="w-6 h-6" aria-hidden="true" />,
    color: themeColors.info[500],
    bgColor: themeColors.info[100],
    connectionType: 'ethernet',
    speed: 'medium',
  },
  [VfdProtocol.PROFIBUS_DP]: {
    icon: <FlaskConical className="w-6 h-6" aria-hidden="true" />,
    color: themeColors.primary[700],
    bgColor: themeColors.primary[50],
    connectionType: 'fieldbus',
    speed: 'high',
  },
  [VfdProtocol.PROFINET]: {
    icon: <Server className="w-6 h-6" aria-hidden="true" />,
    color: themeColors.success[500],
    bgColor: themeColors.success[100],
    connectionType: 'ethernet',
    speed: 'high',
  },
  [VfdProtocol.ETHERNET_IP]: {
    icon: <Columns3 className="w-6 h-6" aria-hidden="true" />,
    color: themeColors.accent[500],
    bgColor: themeColors.error[50],
    connectionType: 'ethernet',
    speed: 'high',
  },
  [VfdProtocol.CANOPEN]: {
    icon: <Database className="w-6 h-6" aria-hidden="true" />,
    color: themeColors.primary[500],
    bgColor: themeColors.info[100],
    connectionType: 'fieldbus',
    speed: 'medium',
  },
  [VfdProtocol.BACNET_IP]: {
    icon: <Building2 className="w-6 h-6" aria-hidden="true" />,
    color: themeColors.secondary[600],
    bgColor: themeColors.success[100],
    connectionType: 'ethernet',
    speed: 'medium',
  },
  [VfdProtocol.BACNET_MSTP]: {
    icon: <Building2 className="w-6 h-6" aria-hidden="true" />,
    color: themeColors.success[600],
    bgColor: themeColors.success[100],
    connectionType: 'serial',
    speed: 'low',
  },
};

const CONNECTION_TYPE_LABELS: Record<string, { label: string; icon: string }> = {
  serial: { label: 'Seri (RS-485)', icon: '🔌' },
  ethernet: { label: 'Ethernet', icon: '🌐' },
  fieldbus: { label: 'Fieldbus', icon: '⚡' },
};

const SPEED_LABELS: Record<string, { label: string; color: string }> = {
  low: { label: 'Düşük', color: 'text-yellow-600' },
  medium: { label: 'Orta', color: 'text-blue-600' },
  high: { label: 'Yüksek', color: 'text-green-600' },
};

export function VfdProtocolSelectionStep({
  brand,
  selectedProtocol,
  onSelect,
}: VfdProtocolSelectionStepProps) {
  // Group protocols by connection type
  const serialProtocols = brand.supportedProtocols.filter(
    (p) => PROTOCOL_CONFIG[p]?.connectionType === 'serial',
  );
  const ethernetProtocols = brand.supportedProtocols.filter(
    (p) => PROTOCOL_CONFIG[p]?.connectionType === 'ethernet',
  );
  const fieldbusProtocols = brand.supportedProtocols.filter(
    (p) => PROTOCOL_CONFIG[p]?.connectionType === 'fieldbus',
  );

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
          İletişim Protokolü Seçin
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          <span className="font-medium text-gray-700 dark:text-gray-300">{brand.name}</span>{' '}
          cihazınız için desteklenen iletişim protokollerinden birini seçin.
        </p>
      </div>

      {/* Recommendation info */}
      <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
        <div className="flex items-start">
          <Info className="w-5 h-5 text-amber-500 mr-2 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-sm text-amber-800">
            <p className="font-medium">Öneri</p>
            <p>
              Ethernet bağlantısı mevcutsa <strong>Modbus TCP</strong> veya{' '}
              <strong>PROFINET</strong> protokollerini tercih edin. Daha hızlı ve güvenilir iletişim
              sağlarlar.
            </p>
          </div>
        </div>
      </div>

      {/* Ethernet protocols */}
      {ethernetProtocols.length > 0 && (
        <ProtocolGroup
          title="Ethernet Protokolleri"
          icon="🌐"
          description="Ethernet kablosu ile bağlantı"
          protocols={ethernetProtocols}
          selectedProtocol={selectedProtocol}
          onSelect={onSelect}
          recommended
        />
      )}

      {/* Serial protocols */}
      {serialProtocols.length > 0 && (
        <ProtocolGroup
          title="Seri Protokoller"
          icon="🔌"
          description="RS-485/RS-232 ile bağlantı"
          protocols={serialProtocols}
          selectedProtocol={selectedProtocol}
          onSelect={onSelect}
        />
      )}

      {/* Fieldbus protocols */}
      {fieldbusProtocols.length > 0 && (
        <ProtocolGroup
          title="Fieldbus Protokolleri"
          icon="⚡"
          description="Endüstriyel fieldbus sistemleri"
          protocols={fieldbusProtocols}
          selectedProtocol={selectedProtocol}
          onSelect={onSelect}
        />
      )}

      {/* Selected protocol details */}
      {selectedProtocol && (
        <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex items-start">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center mr-3"
              style={{
                backgroundColor: PROTOCOL_CONFIG[selectedProtocol]?.bgColor,
                color: PROTOCOL_CONFIG[selectedProtocol]?.color,
              }}
            >
              {PROTOCOL_CONFIG[selectedProtocol]?.icon}
            </div>
            <div>
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                {VFD_PROTOCOL_NAMES[selectedProtocol]}
              </h4>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {VFD_PROTOCOL_DESCRIPTIONS[selectedProtocol]}
              </p>
              <div className="mt-2 flex items-center gap-3 text-xs">
                <span className="flex items-center px-2 py-1 bg-white dark:bg-gray-900 rounded border border-blue-200">
                  {CONNECTION_TYPE_LABELS[PROTOCOL_CONFIG[selectedProtocol]?.connectionType]?.icon}{' '}
                  {CONNECTION_TYPE_LABELS[PROTOCOL_CONFIG[selectedProtocol]?.connectionType]?.label}
                </span>
                <span
                  className={`flex items-center px-2 py-1 bg-white dark:bg-gray-900 rounded border border-blue-200 ${SPEED_LABELS[PROTOCOL_CONFIG[selectedProtocol]?.speed]?.color}`}
                >
                  Hız: {SPEED_LABELS[PROTOCOL_CONFIG[selectedProtocol]?.speed]?.label}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ProtocolGroupProps {
  title: string;
  icon: string;
  description: string;
  protocols: VfdProtocol[];
  selectedProtocol?: VfdProtocol;
  onSelect: (protocol: VfdProtocol) => void;
  recommended?: boolean;
}

function ProtocolGroup({
  title,
  icon,
  description,
  protocols,
  selectedProtocol,
  onSelect,
  recommended,
}: ProtocolGroupProps) {
  return (
    <div>
      <div className="flex items-center mb-3">
        <span className="text-lg mr-2">{icon}</span>
        <div>
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center">
            {title}
            {recommended && (
              <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                Önerilen
              </span>
            )}
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400">{description}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {protocols.map((protocol) => {
          const config = PROTOCOL_CONFIG[protocol];
          const isSelected = selectedProtocol === protocol;

          return (
            <button
              key={protocol}
              onClick={() => onSelect(protocol)}
              className={`relative p-4 rounded-lg border-2 transition-all text-left hover:shadow-md ${
                isSelected
                  ? 'border-blue-500 bg-blue-50 shadow-md'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-500'
              }`}
            >
              <div className="flex items-start">
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center mr-3 flex-shrink-0"
                  style={{ backgroundColor: config?.bgColor, color: config?.color }}
                >
                  {config?.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <h5 className="font-medium text-gray-900 dark:text-gray-100 text-sm">
                    {VFD_PROTOCOL_NAMES[protocol]}
                  </h5>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
                    {VFD_PROTOCOL_DESCRIPTIONS[protocol]}
                  </p>
                </div>
              </div>

              {isSelected && (
                <div className="absolute top-2 right-2">
                  <CircleCheck className="w-5 h-5 text-blue-500" aria-hidden="true" />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default VfdProtocolSelectionStep;
