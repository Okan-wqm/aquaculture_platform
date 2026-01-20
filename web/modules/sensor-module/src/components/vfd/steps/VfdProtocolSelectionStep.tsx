import React from 'react';
import {
  VfdBrandInfo,
  VfdProtocol,
  VFD_PROTOCOL_NAMES,
  VFD_PROTOCOL_DESCRIPTIONS,
} from '../../../types/vfd.types';

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
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
    color: '#F59E0B',
    bgColor: '#FEF3C7',
    connectionType: 'serial',
    speed: 'low',
  },
  [VfdProtocol.MODBUS_TCP]: {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
      </svg>
    ),
    color: '#3B82F6',
    bgColor: '#DBEAFE',
    connectionType: 'ethernet',
    speed: 'medium',
  },
  [VfdProtocol.PROFIBUS_DP]: {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
      </svg>
    ),
    color: '#8B5CF6',
    bgColor: '#EDE9FE',
    connectionType: 'fieldbus',
    speed: 'high',
  },
  [VfdProtocol.PROFINET]: {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
      </svg>
    ),
    color: '#10B981',
    bgColor: '#D1FAE5',
    connectionType: 'ethernet',
    speed: 'high',
  },
  [VfdProtocol.ETHERNET_IP]: {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
      </svg>
    ),
    color: '#EC4899',
    bgColor: '#FCE7F3',
    connectionType: 'ethernet',
    speed: 'high',
  },
  [VfdProtocol.CANOPEN]: {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
      </svg>
    ),
    color: '#6366F1',
    bgColor: '#E0E7FF',
    connectionType: 'fieldbus',
    speed: 'medium',
  },
  [VfdProtocol.BACNET_IP]: {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    ),
    color: '#14B8A6',
    bgColor: '#CCFBF1',
    connectionType: 'ethernet',
    speed: 'medium',
  },
  [VfdProtocol.BACNET_MSTP]: {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    ),
    color: '#0D9488',
    bgColor: '#CCFBF1',
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
    (p) => PROTOCOL_CONFIG[p]?.connectionType === 'serial'
  );
  const ethernetProtocols = brand.supportedProtocols.filter(
    (p) => PROTOCOL_CONFIG[p]?.connectionType === 'ethernet'
  );
  const fieldbusProtocols = brand.supportedProtocols.filter(
    (p) => PROTOCOL_CONFIG[p]?.connectionType === 'fieldbus'
  );

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          İletişim Protokolü Seçin
        </h3>
        <p className="text-sm text-gray-500">
          <span className="font-medium text-gray-700">{brand.name}</span> cihazınız için
          desteklenen iletişim protokollerinden birini seçin.
        </p>
      </div>

      {/* Recommendation info */}
      <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
        <div className="flex items-start">
          <svg className="w-5 h-5 text-amber-500 mr-2 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
          <div className="text-sm text-amber-800">
            <p className="font-medium">Öneri</p>
            <p>
              Ethernet bağlantısı mevcutsa <strong>Modbus TCP</strong> veya <strong>PROFINET</strong>{' '}
              protokollerini tercih edin. Daha hızlı ve güvenilir iletişim sağlarlar.
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
              <h4 className="font-semibold text-gray-900">
                {VFD_PROTOCOL_NAMES[selectedProtocol]}
              </h4>
              <p className="text-sm text-gray-600 mt-1">
                {VFD_PROTOCOL_DESCRIPTIONS[selectedProtocol]}
              </p>
              <div className="mt-2 flex items-center gap-3 text-xs">
                <span className="flex items-center px-2 py-1 bg-white rounded border border-blue-200">
                  {CONNECTION_TYPE_LABELS[PROTOCOL_CONFIG[selectedProtocol]?.connectionType]?.icon}{' '}
                  {CONNECTION_TYPE_LABELS[PROTOCOL_CONFIG[selectedProtocol]?.connectionType]?.label}
                </span>
                <span className={`flex items-center px-2 py-1 bg-white rounded border border-blue-200 ${SPEED_LABELS[PROTOCOL_CONFIG[selectedProtocol]?.speed]?.color}`}>
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
          <h4 className="text-sm font-medium text-gray-700 flex items-center">
            {title}
            {recommended && (
              <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                Önerilen
              </span>
            )}
          </h4>
          <p className="text-xs text-gray-500">{description}</p>
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
                  : 'border-gray-200 bg-white hover:border-gray-300'
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
                  <h5 className="font-medium text-gray-900 text-sm">
                    {VFD_PROTOCOL_NAMES[protocol]}
                  </h5>
                  <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                    {VFD_PROTOCOL_DESCRIPTIONS[protocol]}
                  </p>
                </div>
              </div>

              {isSelected && (
                <div className="absolute top-2 right-2">
                  <svg className="w-5 h-5 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
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
