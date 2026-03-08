import React from 'react';
import { TagBrowser } from '../TagBrowser';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Turkish labels for equipment sub-types                             */
/* ------------------------------------------------------------------ */

const SUBTYPE_LABELS: Record<string, string> = {
  centrifugalPump: 'Santrifüj Pompa',
  gearPump: 'Dişli Pompa',
  diaphragmPump: 'Diyafram Pompa',
  pistonPump: 'Piston Pompa',
  submersiblePump: 'Dalgıç Pompa',
  vacuumPump: 'Vakum Pompa',
  gateValve: 'Sürgülü Vana',
  ballValve: 'Küresel Vana',
  butterflyValve: 'Kelebek Vana',
  globeValve: 'Glob Vana',
  checkValve: 'Çekvalf',
  reliefValve: 'Emniyet Vanası',
  controlValve: 'Kontrol Vanası',
  needleValve: 'İğne Vana',
  solenoidValve: 'Solenoid Vana',
  verticalTank: 'Dikey Tank',
  horizontalTank: 'Yatay Tank',
  conicalBottomTank: 'Konik Dipli Tank',
  pressureVessel: 'Basınçlı Kap',
  silo: 'Silo',
  mixingTank: 'Karıştırma Tankı',
  shellAndTube: 'Boru Demeti',
  plateHeatExchanger: 'Plakalı Eşanjör',
  airCooler: 'Hava Soğutucu',
  condenser: 'Kondenser',
  evaporator: 'Evaporatör',
};

/* ------------------------------------------------------------------ */
/*  Rotation options                                                   */
/* ------------------------------------------------------------------ */

const ROTATION_OPTIONS = [0, 90, 180, 270] as const;

/* ------------------------------------------------------------------ */
/*  Demo state options                                                 */
/* ------------------------------------------------------------------ */

const DEMO_STATE_OPTIONS = [
  { value: '', label: 'Yok (canlı değer)' },
  { value: 'running', label: 'Çalışıyor' },
  { value: 'stopped', label: 'Durdu' },
  { value: 'open', label: 'Açık' },
  { value: 'closed', label: 'Kapalı' },
  { value: 'fault', label: 'Arıza' },
] as const;

/* ------------------------------------------------------------------ */
/*  EquipmentConfig                                                    */
/* ------------------------------------------------------------------ */

export const EquipmentConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const subType = (config.equipmentSubType as string) || '';
  const currentRotation = (config.rotation as number) || 0;

  return (
    <div className="space-y-3">
      {/* Equipment sub-type badge (read-only) */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Ekipman Tipi</label>
        <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-700 font-medium">
          {SUBTYPE_LABELS[subType] || subType || 'Belirtilmemiş'}
        </div>
      </div>

      {/* Tag binding */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={config.tag || ''}
          onChange={(tag) => onChange({ tag })}
          placeholder="Tag seçin..."
        />
      </div>

      {/* Label */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Etiket</label>
        <input
          type="text"
          value={config.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Ekipman etiketi"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Rotation selector */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Rotasyon</label>
        <div className="flex gap-1">
          {ROTATION_OPTIONS.map((deg) => (
            <button
              key={deg}
              type="button"
              onClick={() => onChange({ rotation: deg })}
              className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                currentRotation === deg
                  ? 'bg-cyan-50 border-cyan-500 text-cyan-700'
                  : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {deg}°
            </button>
          ))}
        </div>
      </div>

      {/* Demo state selector */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Demo Durum</label>
        <select
          value={config.demoState || ''}
          onChange={(e) => onChange({ demoState: e.target.value || undefined })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 bg-white"
        >
          {DEMO_STATE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-400">
          Düzenleme modunda sembolü test etmek için bir durum seçin.
        </p>
      </div>
    </div>
  );
};
