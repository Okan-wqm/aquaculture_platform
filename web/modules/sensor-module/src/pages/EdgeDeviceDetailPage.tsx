/**
 * Edge Device Detail Page
 *
 * Edge controller detay ve konfigürasyon sayfası.
 * Device bilgileri, sistem metrikleri, I/O konfigürasyonu (CRUD + push).
 *
 * I/O konfigürasyon tasarımı IEC 61131 tag-naming ve
 * Modbus/GPIO protokol konvansiyonlarını takip eder.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  Server,
  Wifi,
  WifiOff,
  Clock,
  Cpu,
  HardDrive,
  Thermometer,
  Settings,
  Activity,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Shield,
  Tag,
  MapPin,
  MemoryStick,
  Trash2,
  Play,
  Pause,
  Power,
  Plus,
  Pencil,
  X,
  Upload,
  Search,
  Copy,
  Download,
  Radio,
} from 'lucide-react';
import {
  useEdgeDevice,
  useApproveEdgeDevice,
  useSetDeviceMaintenanceMode,
  useDecommissionEdgeDevice,
  usePingEdgeDevice,
  useAddDeviceIoConfig,
  useUpdateDeviceIoConfig,
  useRemoveDeviceIoConfig,
  usePushIoConfig,
  getDeviceStatusText,
  getDeviceModelText,
  getDeviceStatusColor,
  getHealthStatus,
  formatLastSeen,
  getIoTypeText,
  DeviceLifecycleState,
  IoType,
  IoDataType,
  useScanHardware,
  useBulkAddIoConfig,
  useDeviceInstallCommands,
  useSetDigitalOutput,
  useAvailableFirmwareVersions,
  useUpdateEdgeDeviceFirmware,
  type EdgeDevice,
  type DeviceIoConfig,
  type AddIoConfigInput,
  type UpdateIoConfigInput,
  type HardwareScanResult,
} from '../hooks/useEdgeDevices';
import { AutoDetectResultsPanel } from '../components/fleet/AutoDetectResultsPanel';
import { useEdgeIoSocket, type IoTagValue } from '../hooks/useEdgeIoSocket';
import LoRaDevicesPanel from '../components/lora/LoRaDevicesPanel';
import LoRaStatsCard from '../components/lora/LoRaStatsCard';
import { useLoRaDevices } from '../hooks/useLoRaDevices';

// ============================================================================
// Helper Components (shared across tabs)
// ============================================================================

const StatusBadge: React.FC<{ state: DeviceLifecycleState }> = ({ state }) => {
  const color = getDeviceStatusColor(state);
  const colorMap: Record<string, string> = {
    green: 'bg-green-100 text-green-800',
    gray: 'bg-gray-100 text-gray-800',
    yellow: 'bg-yellow-100 text-yellow-800',
    red: 'bg-red-100 text-red-800',
    blue: 'bg-blue-100 text-blue-800',
  };
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${colorMap[color] || colorMap.gray}`}>
      {getDeviceStatusText(state)}
    </span>
  );
};

const MetricBar: React.FC<{ label: string; value?: number; unit?: string; icon: React.ReactNode }> = ({
  label, value, unit = '%', icon,
}) => {
  if (value == null) return null;
  const pct = Math.min(value, 100);
  const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="flex items-center gap-1.5 text-sm text-gray-600">{icon}{label}</span>
        <span className="text-sm font-medium text-gray-900">{value.toFixed(1)}{unit}</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

const InfoRow: React.FC<{ label: string; value?: string | number | null; icon?: React.ReactNode }> = ({
  label, value, icon,
}) => (
  <div className="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0">
    <span className="text-sm text-gray-500">{label}</span>
    <span className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
      {icon}{value ?? 'Belirtilmemiş'}
    </span>
  </div>
);

// ============================================================================
// I/O Config Form — Types, Defaults, Transformers
// ============================================================================

/**
 * Communication protocol between the edge controller and field I/O.
 * - modbus: RS-485/TCP industrial communication (slave ID, register, function code)
 * - gpio: Direct pin-level digital I/O (RPi, RevPi)
 * - manual: Software-fed values for testing/simulation
 */
type ProtocolMode = 'modbus' | 'gpio' | 'manual';

// ============================================================================
// Modbus Function Code Registry — Modbus Application Protocol V1.1b3
// ============================================================================

/**
 * Complete Modbus function code registry following the Modbus Application Protocol
 * Specification V1.1b3. Function codes are categorized by operation type:
 *
 * READ operations (FC1-4): Query data from the Modbus slave device.
 *   - FC1/FC2 read discrete (boolean) values — coils and discrete inputs
 *   - FC3/FC4 read 16-bit register values — holding and input registers
 *
 * WRITE operations (FC5/6/15/16): Send data to the Modbus slave device.
 *   - FC5/FC15 write discrete (boolean) values — single/multiple coils
 *   - FC6/FC16 write 16-bit register values — single/multiple registers
 *
 * The function code must match the IO type:
 *   DI (Digital Input)  -> FC1 (Read Coils) or FC2 (Read Discrete Inputs)
 *   AI (Analog Input)   -> FC3 (Read Holding Registers) or FC4 (Read Input Registers)
 *   DO (Digital Output)  -> FC5 (Write Single Coil) or FC15 (Write Multiple Coils)
 *   AO (Analog Output)  -> FC6 (Write Single Register) or FC16 (Write Multiple Registers)
 */
interface ModbusFunctionCode {
  value: number;
  label: string;
  /** 'read' for input types (DI/AI), 'write' for output types (DO/AO) */
  operation: 'read' | 'write';
  /** Which IO types this function code is compatible with */
  compatibleIoTypes: IoType[];
}

const MODBUS_FUNCTION_CODES: ModbusFunctionCode[] = [
  // READ functions — for DI and AI
  { value: 1,  label: 'FC1 - Read Coils',               operation: 'read',  compatibleIoTypes: [IoType.DI] },
  { value: 2,  label: 'FC2 - Read Discrete Inputs',      operation: 'read',  compatibleIoTypes: [IoType.DI] },
  { value: 3,  label: 'FC3 - Read Holding Registers',    operation: 'read',  compatibleIoTypes: [IoType.AI] },
  { value: 4,  label: 'FC4 - Read Input Registers',      operation: 'read',  compatibleIoTypes: [IoType.AI] },
  // WRITE functions — for DO and AO
  { value: 5,  label: 'FC5 - Write Single Coil',         operation: 'write', compatibleIoTypes: [IoType.DO] },
  { value: 6,  label: 'FC6 - Write Single Register',     operation: 'write', compatibleIoTypes: [IoType.AO] },
  { value: 15, label: 'FC15 - Write Multiple Coils',     operation: 'write', compatibleIoTypes: [IoType.DO] },
  { value: 16, label: 'FC16 - Write Multiple Registers', operation: 'write', compatibleIoTypes: [IoType.AO] },
];

/**
 * Filter available Modbus function codes based on the selected IO type.
 * This prevents the user from selecting an incompatible combination
 * (e.g., a read function for an output type) that the backend will reject.
 */
function getFilteredFunctionCodes(ioType: IoType): ModbusFunctionCode[] {
  return MODBUS_FUNCTION_CODES.filter(fc => fc.compatibleIoTypes.includes(ioType));
}

/**
 * Return the default Modbus function code for a given IO type.
 * When the IO type changes, the form auto-selects this default:
 *   DI -> FC1 (Read Coils)
 *   AI -> FC3 (Read Holding Registers)
 *   DO -> FC5 (Write Single Coil)
 *   AO -> FC6 (Write Single Register)
 */
function getDefaultFunctionCode(ioType: IoType): number {
  const defaults: Record<IoType, number> = {
    [IoType.DI]: 1,
    [IoType.AI]: 3,
    [IoType.DO]: 5,
    [IoType.AO]: 6,
  };
  return defaults[ioType] ?? 3;
}

/**
 * Check whether the current function code is compatible with the selected IO type.
 * Used to display a warning for legacy configurations that may have been saved
 * with an incorrect pairing (e.g., FC3 on a DO point).
 */
function isFunctionCodeCompatible(functionCode: number, ioType: IoType): boolean {
  return MODBUS_FUNCTION_CODES.some(
    fc => fc.value === functionCode && fc.compatibleIoTypes.includes(ioType),
  );
}

/**
 * Form state — tüm alanlar string olarak tutulur, böylece
 * kullanıcı "boş bırakma" (undefined/null) ile "0 girme" arasında ayrım yapabilir.
 * Submit sırasında optNum() ile güvenli number dönüşümü yapılır.
 */
interface IoFormState {
  tagName: string;
  description: string;
  ioType: IoType;
  dataType: IoDataType;
  protocolMode: ProtocolMode;
  moduleAddress: string;
  channel: string;
  modbusSlaveId: string;
  modbusRegister: string;
  modbusFunction: string;
  gpioPin: string;
  gpioMode: string;
  invertValue: boolean;
  rawMin: string;
  rawMax: string;
  engMin: string;
  engMax: string;
  engUnit: string;
  alarmHH: string;
  alarmH: string;
  alarmL: string;
  alarmLL: string;
  deadband: string;
  isActive: boolean;
}

/** Analog input için endüstriyel standart varsayılanlar (12-bit ADC, 0-100 mühendislik aralığı) */
const DEFAULT_FORM_STATE: IoFormState = {
  tagName: '',
  description: '',
  ioType: IoType.AI,
  dataType: IoDataType.FLOAT32,
  protocolMode: 'modbus',
  moduleAddress: '0',
  channel: '0',
  modbusSlaveId: '1',
  modbusRegister: '0',
  modbusFunction: '3', // FC3 - Read Holding Registers (default for AI, the most common IO type)
  gpioPin: '',
  gpioMode: 'input',
  invertValue: false,
  rawMin: '0',
  rawMax: '4095',  // 12-bit ADC
  engMin: '0',
  engMax: '100',
  engUnit: '',
  alarmHH: '',
  alarmH: '',
  alarmL: '',
  alarmLL: '',
  deadband: '',
  isActive: true,
};

/**
 * Mevcut bir DeviceIoConfig kaydını form state'e dönüştürür.
 * Protokol modu, cihazdan dönen alanlara bakılarak tespit edilir:
 * modbusSlaveId/Register varsa -> modbus, gpioPin varsa -> gpio, yoksa -> manual
 */
function configToFormState(cfg: DeviceIoConfig): IoFormState {
  const protocolMode: ProtocolMode =
    cfg.modbusSlaveId != null || cfg.modbusRegister != null
      ? 'modbus'
      : cfg.gpioPin != null
        ? 'gpio'
        : 'manual';

  return {
    tagName: cfg.tagName,
    description: cfg.description || '',
    ioType: cfg.ioType,
    dataType: cfg.dataType,
    protocolMode,
    moduleAddress: String(cfg.moduleAddress),
    channel: String(cfg.channel),
    modbusSlaveId: cfg.modbusSlaveId != null ? String(cfg.modbusSlaveId) : '1',
    modbusRegister: cfg.modbusRegister != null ? String(cfg.modbusRegister) : '0',
    modbusFunction: cfg.modbusFunction != null ? String(cfg.modbusFunction) : '3',
    gpioPin: cfg.gpioPin != null ? String(cfg.gpioPin) : '',
    gpioMode: cfg.gpioMode || 'input',
    invertValue: cfg.invertValue || false,
    rawMin: cfg.rawMin != null ? String(cfg.rawMin) : '',
    rawMax: cfg.rawMax != null ? String(cfg.rawMax) : '',
    engMin: cfg.engMin != null ? String(cfg.engMin) : '',
    engMax: cfg.engMax != null ? String(cfg.engMax) : '',
    engUnit: cfg.engUnit || '',
    alarmHH: cfg.alarmHH != null ? String(cfg.alarmHH) : '',
    alarmH: cfg.alarmH != null ? String(cfg.alarmH) : '',
    alarmL: cfg.alarmL != null ? String(cfg.alarmL) : '',
    alarmLL: cfg.alarmLL != null ? String(cfg.alarmLL) : '',
    deadband: cfg.deadband != null ? String(cfg.deadband) : '',
    isActive: cfg.isActive,
  };
}

/** String -> number dönüşümü, boş string ise undefined döner (opsiyonel alanlar için) */
function optNum(val: string): number | undefined {
  const trimmed = val.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return isNaN(n) ? undefined : n;
}

/**
 * IEC 61131 uyumlu tag name doğrulama.
 * Sadece büyük harf, rakam ve alt çizgi; harfle başlamalı.
 * Örn: TANK_LEVEL_01, DO_PUMP_MAIN
 */
const TAG_NAME_REGEX = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Alarm eşikleri sıralama doğrulaması.
 * Endüstriyel standart: LL < L < H < HH (varsa).
 * Yanlış sıralama sahada yanlış alarm üretimine neden olur.
 */
function validateAlarmOrder(f: IoFormState): string | null {
  const hh = optNum(f.alarmHH);
  const h = optNum(f.alarmH);
  const l = optNum(f.alarmL);
  const ll = optNum(f.alarmLL);

  // Sadece girilen değerler arasında karşılaştırma yap
  if (hh != null && h != null && hh <= h) return 'Alarm HH, H\'den büyük olmalıdır';
  if (h != null && l != null && h <= l) return 'Alarm H, L\'den büyük olmalıdır';
  if (l != null && ll != null && l <= ll) return 'Alarm L, LL\'den büyük olmalıdır';
  return null;
}

/** Form state -> GraphQL AddIoConfigInput, sadece aktif protokol alanlarını dahil eder */
function formToAddInput(f: IoFormState): AddIoConfigInput {
  const input: AddIoConfigInput = {
    tagName: f.tagName.trim(),
    description: f.description.trim() || undefined,
    ioType: f.ioType,
    dataType: f.dataType,
    moduleAddress: Number(f.moduleAddress),
    channel: Number(f.channel),
    alarmHH: optNum(f.alarmHH),
    alarmH: optNum(f.alarmH),
    alarmL: optNum(f.alarmL),
    alarmLL: optNum(f.alarmLL),
    deadband: optNum(f.deadband),
  };

  // Sadece seçili protokolün alanlarını gönder — backend'e gereksiz veri göndermemek için
  if (f.protocolMode === 'modbus') {
    input.modbusSlaveId = optNum(f.modbusSlaveId);
    input.modbusRegister = optNum(f.modbusRegister);
    input.modbusFunction = optNum(f.modbusFunction);
  } else if (f.protocolMode === 'gpio') {
    input.gpioPin = optNum(f.gpioPin);
    input.gpioMode = f.gpioMode || undefined;
    input.invertValue = f.invertValue;
  }

  // Analog ölçeklendirme sadece AI/AO kanallarında anlamlı
  if (f.ioType === IoType.AI || f.ioType === IoType.AO) {
    input.rawMin = optNum(f.rawMin);
    input.rawMax = optNum(f.rawMax);
    input.engMin = optNum(f.engMin);
    input.engMax = optNum(f.engMax);
    input.engUnit = f.engUnit.trim() || undefined;
  }

  return input;
}

/**
 * Form state -> GraphQL UpdateIoConfigInput.
 * tagName, ioType, dataType, moduleAddress, channel gibi immutable alanları
 * kasıtlı olarak dahil etmez — bunlar oluşturulduktan sonra değiştirilemez.
 */
function formToUpdateInput(f: IoFormState): UpdateIoConfigInput {
  return {
    description: f.description.trim() || undefined,
    rawMin: optNum(f.rawMin),
    rawMax: optNum(f.rawMax),
    engMin: optNum(f.engMin),
    engMax: optNum(f.engMax),
    engUnit: f.engUnit.trim() || undefined,
    invertValue: f.invertValue,
    alarmHH: optNum(f.alarmHH),
    alarmH: optNum(f.alarmH),
    alarmL: optNum(f.alarmL),
    alarmLL: optNum(f.alarmLL),
    deadband: optNum(f.deadband),
    isActive: f.isActive,
  };
}

// ============================================================================
// I/O Config Form Modal
// ============================================================================

interface IoConfigFormModalProps {
  isOpen: boolean;
  editConfig?: DeviceIoConfig;
  onClose: () => void;
  onSubmitAdd: (input: AddIoConfigInput) => void;
  onSubmitUpdate: (id: string, input: UpdateIoConfigInput) => void;
  isSubmitting: boolean;
  /** Mutation hatası — kullanıcıya modal içinde gösterilir */
  submitError?: string | null;
}

const IoConfigFormModal: React.FC<IoConfigFormModalProps> = ({
  isOpen,
  editConfig,
  onClose,
  onSubmitAdd,
  onSubmitUpdate,
  isSubmitting,
  submitError,
}) => {
  const [form, setForm] = useState<IoFormState>(DEFAULT_FORM_STATE);
  const [validationError, setValidationError] = useState<string | null>(null);
  const isEdit = !!editConfig;

  // Form state'i modal açıldığında sıfırla veya edit config'den doldur
  useEffect(() => {
    if (isOpen) {
      setForm(editConfig ? configToFormState(editConfig) : DEFAULT_FORM_STATE);
      setValidationError(null);
    }
  }, [editConfig, isOpen]);

  // Escape tuşu ile kapatma — modal accessibility best practice
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  // Compute the filtered Modbus function codes based on current IO type,
  // plus the current selection if it is incompatible (backward compat for legacy configs).
  // Declared before the `!isOpen` early return so the hook call order stays
  // stable across renders (react-hooks/rules-of-hooks).
  const filteredFunctionCodes = useMemo(() => {
    const compatible = getFilteredFunctionCodes(form.ioType);
    const currentFc = Number(form.modbusFunction);
    const currentIsCompatible = compatible.some(fc => fc.value === currentFc);
    if (!currentIsCompatible) {
      // Include the current (incompatible) code so the dropdown does not silently lose it.
      const legacy = MODBUS_FUNCTION_CODES.find(fc => fc.value === currentFc);
      if (legacy) {
        return [...compatible, { ...legacy, label: `${legacy.label} (incompatible)` }];
      }
    }
    return compatible;
  }, [form.ioType, form.modbusFunction]);

  if (!isOpen) return null;

  const set = <K extends keyof IoFormState>(key: K, val: IoFormState[K]) =>
    setForm((prev) => {
      const next = { ...prev, [key]: val };
      // When the IO type changes, auto-select the correct default Modbus function code.
      // This prevents the user from accidentally submitting an incompatible combination
      // (e.g., FC3/Read on a DO/AO output) that the backend will reject with BAD_REQUEST.
      if (key === 'ioType' && typeof val === 'string') {
        const newIoType = val as IoType;
        const currentFc = Number(prev.modbusFunction);
        if (!isFunctionCodeCompatible(currentFc, newIoType)) {
          next.modbusFunction = String(getDefaultFunctionCode(newIoType));
        }
      }
      return next;
    });

  const isAnalog = form.ioType === IoType.AI || form.ioType === IoType.AO;

  const currentFcIncompatible = !isFunctionCodeCompatible(
    Number(form.modbusFunction),
    form.ioType,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    // Tag name IEC 61131 formatı doğrulama (sadece yeni kayıtta)
    if (!isEdit && !TAG_NAME_REGEX.test(form.tagName.trim())) {
      setValidationError(
        'Tag adı IEC 61131 formatında olmalıdır: büyük harf ile başlamalı, sadece A-Z, 0-9, _ içermeli (örn: TANK_LEVEL_01)'
      );
      return;
    }

    // Validate Modbus function code compatibility with IO type.
    // The backend enforces this check and will reject incompatible pairs with BAD_REQUEST,
    // but we catch it here to give the user immediate feedback in the form.
    if (!isEdit && form.protocolMode === 'modbus') {
      const fc = Number(form.modbusFunction);
      if (!isFunctionCodeCompatible(fc, form.ioType)) {
        const expectedOp = (form.ioType === IoType.DO || form.ioType === IoType.AO) ? 'write' : 'read';
        setValidationError(
          `FC${fc} is incompatible with ${form.ioType}. ${form.ioType} requires a ${expectedOp} function code. ` +
          `Please select a compatible function code from the dropdown.`
        );
        return;
      }
    }

    // Alarm order validation — incorrect ordering is dangerous in field operation
    const alarmErr = validateAlarmOrder(form);
    if (alarmErr) {
      setValidationError(alarmErr);
      return;
    }

    if (isEdit && editConfig) {
      onSubmitUpdate(editConfig.id, formToUpdateInput(form));
    } else {
      onSubmitAdd(formToAddInput(form));
    }
  };

  /** Backdrop'a tıklama ile modal kapatma */
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const inputCls = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 outline-hidden disabled:bg-gray-50 disabled:text-gray-500';
  const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? 'I/O Kanal Düzenle' : 'Yeni I/O Kanal Ekle'}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            {isEdit ? 'I/O Kanal Düzenle' : 'Yeni I/O Kanal Ekle'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded-lg"
            aria-label="Kapat"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Validation / mutation error banner */}
          {(validationError || submitError) && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
              <span className="text-sm text-red-800">{validationError || submitError}</span>
            </div>
          )}

          {/* Basic Fields */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Tag Adi *</label>
              <input
                className={inputCls}
                value={form.tagName}
                onChange={(e) => set('tagName', e.target.value.toUpperCase())}
                required
                disabled={isEdit}
                placeholder="TANK_LEVEL_01"
                pattern="[A-Z][A-Z0-9_]{1,63}"
                title="Büyük harf ile başlamalı, A-Z, 0-9, _ (maks 64 karakter)"
              />
            </div>
            <div>
              <label className={labelCls}>Açıklama</label>
              <input
                className={inputCls}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="Tank seviye sensoru"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>I/O Tipi *</label>
              <select
                className={inputCls}
                value={form.ioType}
                onChange={(e) => set('ioType', e.target.value as IoType)}
                disabled={isEdit}
              >
                <option value={IoType.DI}>Digital Input (DI)</option>
                <option value={IoType.DO}>Digital Output (DO)</option>
                <option value={IoType.AI}>Analog Input (AI)</option>
                <option value={IoType.AO}>Analog Output (AO)</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Veri Tipi *</label>
              <select
                className={inputCls}
                value={form.dataType}
                onChange={(e) => set('dataType', e.target.value as IoDataType)}
                disabled={isEdit}
              >
                {Object.values(IoDataType).map((dt) => (
                  <option key={dt} value={dt}>{dt}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Module Address / Channel — immutable after creation (hardware binding) */}
          {!isEdit && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Modul Adresi *</label>
                <input
                  type="number"
                  className={inputCls}
                  value={form.moduleAddress}
                  onChange={(e) => set('moduleAddress', e.target.value)}
                  required
                  min={0}
                />
              </div>
              <div>
                <label className={labelCls}>Kanal *</label>
                <input
                  type="number"
                  className={inputCls}
                  value={form.channel}
                  onChange={(e) => set('channel', e.target.value)}
                  required
                  min={0}
                />
              </div>
            </div>
          )}

          {/* Protocol Selection — immutable after creation (hardware binding) */}
          {!isEdit && (
            <div>
              <label className={labelCls}>Protokol</label>
              <div className="flex gap-3 mt-1">
                {(['modbus', 'gpio', 'manual'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => set('protocolMode', p)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      form.protocolMode === p
                        ? 'bg-cyan-50 border-cyan-300 text-cyan-700'
                        : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {p === 'modbus' ? 'Modbus' : p === 'gpio' ? 'GPIO' : 'Manuel'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Modbus RTU/TCP fields — Slave ID: 1-247 (Modbus spec), FC1-16 filtered by IO type */}
          {!isEdit && form.protocolMode === 'modbus' && (
            <div className="p-4 bg-blue-50 rounded-lg space-y-3">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className={labelCls}>Slave ID</label>
                  <input
                    type="number"
                    className={inputCls}
                    value={form.modbusSlaveId}
                    onChange={(e) => set('modbusSlaveId', e.target.value)}
                    min={1}
                    max={247}
                  />
                </div>
                <div>
                  <label className={labelCls}>Register</label>
                  <input
                    type="number"
                    className={inputCls}
                    value={form.modbusRegister}
                    onChange={(e) => set('modbusRegister', e.target.value)}
                    min={0}
                    max={65535}
                  />
                </div>
                <div>
                  <label className={labelCls}>Function Code</label>
                  <select
                    className={`${inputCls} ${currentFcIncompatible ? 'border-amber-400 bg-amber-50' : ''}`}
                    value={form.modbusFunction}
                    onChange={(e) => set('modbusFunction', e.target.value)}
                  >
                    {filteredFunctionCodes.map((fc) => (
                      <option key={fc.value} value={String(fc.value)}>{fc.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              {/* Warning banner for legacy configs with incompatible function code */}
              {currentFcIncompatible && (
                <div className="flex items-start gap-2 p-2 rounded-md bg-amber-50 border border-amber-200">
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  <span className="text-xs text-amber-800">
                    FC{form.modbusFunction} is a {Number(form.modbusFunction) <= 4 ? 'read' : 'write'} function
                    and is incompatible with {form.ioType} ({form.ioType === IoType.DO || form.ioType === IoType.AO ? 'output requires write' : 'input requires read'}).
                    Select a compatible function code or the backend will reject this configuration.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* GPIO fields — doğrudan pin erişimi (RPi/RevPi) */}
          {!isEdit && form.protocolMode === 'gpio' && (
            <div className="grid grid-cols-3 gap-4 p-4 bg-green-50 rounded-lg">
              <div>
                <label className={labelCls}>GPIO Pin</label>
                <input
                  type="number"
                  className={inputCls}
                  value={form.gpioPin}
                  onChange={(e) => set('gpioPin', e.target.value)}
                  min={0}
                />
              </div>
              <div>
                <label className={labelCls}>GPIO Modu</label>
                <select
                  className={inputCls}
                  value={form.gpioMode}
                  onChange={(e) => set('gpioMode', e.target.value)}
                >
                  <option value="input">Input</option>
                  <option value="output">Output</option>
                </select>
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.invertValue}
                    onChange={(e) => set('invertValue', e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
                  />
                  Invert Value
                </label>
              </div>
            </div>
          )}

          {/* Analog Scaling — Raw ADC -> Engineering Unit dönüşümü (linear interpolation) */}
          {isAnalog && (
            <div className="p-4 bg-purple-50 rounded-lg space-y-3">
              <p className="text-xs font-medium text-purple-700 uppercase">Analog Olceklendirme</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Raw Min</label>
                  <input type="number" step="any" className={inputCls} value={form.rawMin} onChange={(e) => set('rawMin', e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Raw Max</label>
                  <input type="number" step="any" className={inputCls} value={form.rawMax} onChange={(e) => set('rawMax', e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Eng Min</label>
                  <input type="number" step="any" className={inputCls} value={form.engMin} onChange={(e) => set('engMin', e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Eng Max</label>
                  <input type="number" step="any" className={inputCls} value={form.engMax} onChange={(e) => set('engMax', e.target.value)} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Muhendislik Birimi</label>
                <input className={inputCls} value={form.engUnit} onChange={(e) => set('engUnit', e.target.value)} placeholder="pH, mg/L, °C ..." />
              </div>
            </div>
          )}

          {/* Alarm Thresholds — ISA-18.2 alarm yönetimi standardı sıralaması: LL < L < H < HH */}
          <div className="p-4 bg-orange-50 rounded-lg space-y-3">
            <p className="text-xs font-medium text-orange-700 uppercase">Alarm Esikleri (ISA-18.2)</p>
            <div className="grid grid-cols-5 gap-3">
              <div>
                <label className={labelCls}>HH</label>
                <input type="number" step="any" className={inputCls} value={form.alarmHH} onChange={(e) => set('alarmHH', e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>H</label>
                <input type="number" step="any" className={inputCls} value={form.alarmH} onChange={(e) => set('alarmH', e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>L</label>
                <input type="number" step="any" className={inputCls} value={form.alarmL} onChange={(e) => set('alarmL', e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>LL</label>
                <input type="number" step="any" className={inputCls} value={form.alarmLL} onChange={(e) => set('alarmLL', e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Deadband</label>
                <input type="number" step="any" className={inputCls} value={form.deadband} onChange={(e) => set('deadband', e.target.value)} min={0} />
              </div>
            </div>
          </div>

          {/* Active Toggle */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => set('isActive', e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
            />
            <span className="text-sm font-medium text-gray-700">Aktif</span>
          </label>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              İptal
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !form.tagName.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEdit ? 'Güncelle' : 'Ekle'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// Delete Confirmation Dialog
// ============================================================================

interface DeleteConfirmDialogProps {
  isOpen: boolean;
  tagName: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting: boolean;
}

const DeleteConfirmDialog: React.FC<DeleteConfirmDialogProps> = ({
  isOpen,
  tagName,
  onConfirm,
  onCancel,
  isDeleting,
}) => {
  // Escape tuşu desteği
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleBackdropClick}
      role="alertdialog"
      aria-modal="true"
      aria-label="I/O Kanal Silme Onayi"
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-red-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900">I/O Kanal Sil</h3>
            <p className="text-sm text-gray-500">Bu islem geri alinamaz.</p>
          </div>
        </div>
        <p className="text-sm text-gray-700 mb-6">
          <strong>{tagName}</strong> kanalini silmek istediginizden emin misiniz?
          Bu kanal ile iliskili otomasyon programlari etkilenebilir.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            İptal
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
          >
            {isDeleting && <Loader2 className="w-4 h-4 animate-spin" />}
            Sil
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Live I/O Helper Components
// ============================================================================

function getAlarmStatus(
  value: number | boolean | undefined,
  config: { alarmHH?: number | null; alarmH?: number | null; alarmL?: number | null; alarmLL?: number | null },
): { status: 'HH' | 'H' | 'OK' | 'L' | 'LL' | '--'; color: string } {
  if (value === undefined || value === null || typeof value === 'boolean') {
    return { status: '--', color: 'gray' };
  }
  const v = Number(value);
  if (config.alarmHH != null && v >= Number(config.alarmHH)) return { status: 'HH', color: 'red' };
  if (config.alarmH != null && v >= Number(config.alarmH)) return { status: 'H', color: 'orange' };
  if (config.alarmLL != null && v <= Number(config.alarmLL)) return { status: 'LL', color: 'red' };
  if (config.alarmL != null && v <= Number(config.alarmL)) return { status: 'L', color: 'orange' };
  return { status: 'OK', color: 'green' };
}

const QualityDot: React.FC<{ quality?: string }> = ({ quality }) => {
  const colorMap: Record<string, string> = {
    good: '#22c55e',
    uncertain: '#eab308',
    bad: '#ef4444',
    comm_failure: '#ef4444',
    not_initialized: '#9ca3af',
  };
  const color = quality ? colorMap[quality] ?? '#9ca3af' : '#9ca3af';
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: color,
        marginRight: 6,
      }}
    />
  );
};

const alarmColorMap: Record<string, string> = {
  red: 'bg-red-100 text-red-700',
  orange: 'bg-orange-100 text-orange-700',
  green: 'bg-green-100 text-green-700',
  gray: 'bg-gray-100 text-gray-500',
};

// ============================================================================
// I/O Config Section — CRUD table + push to device
// ============================================================================

interface IoConfigSectionProps {
  device: EdgeDevice;
  refetch: () => void;
}

/**
 * I/O konfigürasyon yönetim bölümü.
 * Tüm CRUD işlemleri (add/edit/delete) ve "Push to Device" burada yönetilir.
 * Her mutation kendi loading/error state'ini tanstack-query ile tutar.
 */
const IoConfigSection: React.FC<IoConfigSectionProps> = ({ device, refetch }) => {
  const configs = device.ioConfig || [];
  const deviceId = device.id;

  // Live I/O data via WebSocket
  const { tags: liveValues, isConnected: liveConnected } = useEdgeIoSocket(device.deviceCode);
  const setDoMutation = useSetDigitalOutput();

  const [formOpen, setFormOpen] = useState(false);
  const [editConfig, setEditConfig] = useState<DeviceIoConfig | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<DeviceIoConfig | null>(null);

  // v2.3: Auto-detection state
  const [scanResult, setScanResult] = useState<HardwareScanResult | null>(null);
  const scanHardware = useScanHardware();
  const bulkAddIo = useBulkAddIoConfig();

  const addMutation = useAddDeviceIoConfig();
  const updateMutation = useUpdateDeviceIoConfig();
  const removeMutation = useRemoveDeviceIoConfig();
  const pushMutation = usePushIoConfig();

  const openAdd = useCallback(() => {
    setEditConfig(undefined);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((cfg: DeviceIoConfig) => {
    setEditConfig(cfg);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditConfig(undefined);
  }, []);

  const handleAdd = useCallback((input: AddIoConfigInput) => {
    addMutation.mutate(
      { deviceId, input },
      {
        onSuccess: () => {
          closeForm();
          refetch();
        },
      },
    );
  }, [addMutation, deviceId, closeForm, refetch]);

  const handleUpdate = useCallback((id: string, input: UpdateIoConfigInput) => {
    updateMutation.mutate(
      { id, deviceId, input },
      {
        onSuccess: () => {
          closeForm();
          refetch();
        },
      },
    );
  }, [updateMutation, deviceId, closeForm, refetch]);

  const handleDelete = useCallback(() => {
    if (!deleteTarget) return;
    removeMutation.mutate(
      { id: deleteTarget.id, deviceId },
      {
        onSuccess: () => {
          setDeleteTarget(null);
          refetch();
        },
      },
    );
  }, [deleteTarget, removeMutation, deviceId, refetch]);

  const handlePush = useCallback(() => {
    pushMutation.mutate(deviceId);
  }, [pushMutation, deviceId]);

  // v2.3: Auto-detect hardware I/O channels
  const handleAutoDetect = useCallback(async () => {
    setScanResult(null);
    scanHardware.reset(); // Clear stale error state from previous attempts
    try {
      const result = await scanHardware.mutateAsync(deviceId);
      setScanResult(result);
    } catch {
      // Error state handled by scanHardware.error
    }
     
  }, [deviceId]);

  // v2.3: Import selected channels from auto-detect results
  const handleAutoDetectImport = useCallback(
    async (inputs: AddIoConfigInput[]) => {
      const result = await bulkAddIo.mutateAsync({ deviceId, inputs });
      refetch(); // Refresh device data to show new I/O configs
      return result;
    },
     
    [deviceId, refetch],
  );

  // v2.3: Existing tag names for duplicate detection
  const existingTagNames = useMemo(
    () => new Set(configs.map((c) => c.tagName)),
    [configs],
  );

  /** Mutation hata mesajını güvenli şekilde string'e çevir */
  const getMutationError = (): string | null => {
    const err = addMutation.error || updateMutation.error;
    if (!err) return null;
    return err instanceof Error ? err.message : 'Beklenmeyen bir hata olustu';
  };

  // ---- Empty state: henüz I/O konfigürasyonu yokken instructional CTA göster ----
  if (configs.length === 0 && !formOpen) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="text-center py-12">
          <div className="w-16 h-16 rounded-full bg-cyan-50 flex items-center justify-center mx-auto mb-4">
            <Settings className="w-8 h-8 text-cyan-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Henuz I/O konfigurasyonu yok</h3>
          <p className="text-sm text-gray-500 mb-6 max-w-sm mx-auto">
            Edge cihaza analog/digital giris-cikis kanallari ekleyerek
            saha verilerini toplamaya baslayabilirsiniz.
          </p>
          <div className="flex items-center gap-3 justify-center">
            <button
              onClick={handleAutoDetect}
              disabled={scanHardware.isPending || !device.isOnline}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition-colors disabled:opacity-50"
              title={!device.isOnline ? 'Cihaz offline — auto-detect icin online olmali' : 'Donanimi tara'}
            >
              {scanHardware.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
              Auto-Detect I/O
            </button>
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Manuel Ekle
            </button>
          </div>

          {/* Auto-detect error feedback */}
          {scanHardware.isError && (
            <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2 max-w-md mx-auto">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              <span className="text-sm text-red-800">
                {scanHardware.error instanceof Error ? scanHardware.error.message : 'Donanim taramasi başarısız oldu'}
              </span>
            </div>
          )}

          {/* Auto-detect results panel */}
          {scanResult && scanResult.success && (
            <div className="mt-4">
              <AutoDetectResultsPanel
                scanResult={scanResult}
                existingTagNames={existingTagNames}
                onImport={handleAutoDetectImport}
                isImporting={bulkAddIo.isPending}
                onClose={() => setScanResult(null)}
              />
            </div>
          )}

          {/* Scan failed feedback */}
          {scanResult && !scanResult.success && (
            <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2 max-w-md mx-auto">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              <span className="text-sm text-red-800">
                {scanResult.error || 'Donanim taramasi başarısız oldu'}
              </span>
            </div>
          )}
        </div>
        <IoConfigFormModal
          isOpen={formOpen}
          onClose={closeForm}
          onSubmitAdd={handleAdd}
          onSubmitUpdate={handleUpdate}
          isSubmitting={addMutation.isPending}
          submitError={getMutationError()}
        />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      {/* Header with action buttons */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">I/O Konfigurasyonu</h3>
          <span className="text-sm text-gray-500">{configs.length} kanal</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Push to Device — mevcut konfigürasyonu fiziksel cihaza MQTT üzerinden gönderir */}
          <button
            onClick={handlePush}
            disabled={pushMutation.isPending || configs.length === 0}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded-lg hover:bg-orange-100 transition-colors disabled:opacity-50"
          >
            {pushMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            Cihaza Gonder
          </button>
          {/* v2.3: Auto-Detect I/O — scans device hardware for available channels */}
          <button
            onClick={handleAutoDetect}
            disabled={scanHardware.isPending || !device.isOnline}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition-colors disabled:opacity-50"
            title={!device.isOnline ? 'Cihaz offline' : 'Donanimi tara ve I/O kanallarini kes\u0327fet'}
          >
            {scanHardware.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            Auto-Detect
          </button>
          <button
            onClick={openAdd}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Kanal Ekle
          </button>
        </div>
      </div>

      {/* v2.3: Auto-detect results panel */}
      {scanResult && scanResult.success && (
        <div className="mb-4">
          <AutoDetectResultsPanel
            scanResult={scanResult}
            existingTagNames={existingTagNames}
            onImport={handleAutoDetectImport}
            isImporting={bulkAddIo.isPending}
            onClose={() => setScanResult(null)}
          />
        </div>
      )}

      {/* Scan failed feedback */}
      {scanResult && !scanResult.success && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
          <span className="text-sm text-red-800">
            {scanResult.error || 'Donanim taramasi başarısız oldu'}
          </span>
        </div>
      )}

      {/* Push result feedback */}
      {pushMutation.isSuccess && pushMutation.data && (
        <div className="mb-4 p-3 rounded-lg bg-green-50 border border-green-200 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />
          <span className="text-sm text-green-800">
            {'Konfigurasyon cihaza başarıyla gönderildi.'}
          </span>
        </div>
      )}
      {pushMutation.isError && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
          <span className="text-sm text-red-800">
            {pushMutation.error instanceof Error
              ? pushMutation.error.message
              : 'Konfigurasyon gonderimi başarısız oldu.'}
          </span>
        </div>
      )}

      {/* Live connection indicator */}
      <div className="flex items-center gap-2 mb-3">
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: liveConnected ? '#22c55e' : '#9ca3af',
          }}
        />
        <span className={`text-xs font-medium ${liveConnected ? 'text-green-700' : 'text-gray-500'}`}>
          {liveConnected ? 'Canli' : 'Baglanti yok'}
        </span>
      </div>

      {/* I/O channel table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tag</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tip</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Modul/Kanal</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Canli Deger</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Alarm</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Durum</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Islem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {configs.map((io) => {
              const live = liveValues?.[io.tagName] as IoTagValue | undefined;
              const isDigital = io.ioType === IoType.DI || io.ioType === IoType.DO;
              const alarm = getAlarmStatus(
                live?.value as number | boolean | undefined,
                io,
              );

              return (
                <tr key={io.id} className="hover:bg-gray-50 group">
                  <td className="px-3 py-2 font-medium text-gray-900">{io.tagName}</td>
                  <td className="px-3 py-2 text-gray-600">{getIoTypeText(io.ioType)}</td>
                  <td className="px-3 py-2 text-gray-600">{io.moduleAddress}:{io.channel}</td>
                  {/* Canli Deger */}
                  <td className="px-3 py-2">
                    {live ? (
                      <span className="flex items-center gap-1">
                        <QualityDot quality={live.quality} />
                        {isDigital ? (
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            (live.value === true || live.value === 1)
                              ? 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-700'
                          }`}>
                            {(live.value === true || live.value === 1) ? 'ON' : 'OFF'}
                          </span>
                        ) : (
                          <span className="font-mono text-gray-900">
                            {typeof live.value === 'number' ? live.value.toFixed(2) : String(live.value)}
                            {io.engUnit ? ` ${io.engUnit}` : ''}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-500">--</span>
                    )}
                  </td>
                  {/* Alarm */}
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${alarmColorMap[alarm.color] || alarmColorMap.gray}`}>
                      {alarm.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      io.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {io.isActive ? 'Aktif' : 'Pasif'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* DO toggle */}
                      {io.ioType === IoType.DO && (
                        <button
                          onClick={() => {
                            const currentVal = live?.value === true || live?.value === 1;
                            setDoMutation.mutate({
                              deviceId,
                              ioConfigId: io.id,
                              value: !currentVal,
                            });
                          }}
                          disabled={setDoMutation.isPending}
                          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                            (live?.value === true || live?.value === 1)
                              ? 'bg-green-600 text-white hover:bg-green-700'
                              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                          } disabled:opacity-50`}
                          title={`${io.tagName} ${(live?.value === true || live?.value === 1) ? 'OFF' : 'ON'} yap`}
                        >
                          {(live?.value === true || live?.value === 1) ? 'ON' : 'OFF'}
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(io)}
                        className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-cyan-600 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Düzenle"
                        aria-label={`${io.tagName} kanalini duzenle`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(io)}
                        className="p-1.5 hover:bg-red-50 rounded-lg text-gray-500 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Sil"
                        aria-label={`${io.tagName} kanalini sil`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Form & delete modals */}
      <IoConfigFormModal
        isOpen={formOpen}
        editConfig={editConfig}
        onClose={closeForm}
        onSubmitAdd={handleAdd}
        onSubmitUpdate={handleUpdate}
        isSubmitting={addMutation.isPending || updateMutation.isPending}
        submitError={getMutationError()}
      />
      <DeleteConfirmDialog
        isOpen={!!deleteTarget}
        tagName={deleteTarget?.tagName || ''}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        isDeleting={removeMutation.isPending}
      />
    </div>
  );
};

// ============================================================================
// Install Commands Section — Device Settings Tab
// ============================================================================

interface InstallCommandsSectionProps {
  deviceId: string;
}

const InstallCommandsSection: React.FC<InstallCommandsSectionProps> = ({ deviceId }) => {
  const { data: commands, isLoading } = useDeviceInstallCommands(deviceId);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = useCallback(async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
          <span className="text-sm text-gray-500">Kurulum komutlari yükleniyor...</span>
        </div>
      </div>
    );
  }

  if (!commands) return null;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Download className="w-5 h-5 text-gray-600" />
        <h3 className="text-lg font-semibold text-gray-900">Kurulum Komutlari</h3>
      </div>

      <div className="space-y-4">
        {/* Install Command */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Kurulum Komutu (Install)
          </label>
          <div className="relative group">
            <pre className="bg-gray-900 text-green-400 rounded-lg p-4 pr-12 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all">
              {commands.installCommand}
            </pre>
            <button
              onClick={() => handleCopy(commands.installCommand, 'install')}
              className="absolute top-3 right-3 p-1.5 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-500 hover:text-white transition-colors"
              title="Kopyala"
            >
              {copiedField === 'install' ? (
                <CheckCircle className="w-4 h-4 text-green-400" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* Uninstall Command */}
        <div>
          <label className="block text-sm font-medium text-red-700 mb-1.5">
            Kaldirma Komutu (Uninstall)
          </label>
          <div className="relative group">
            <pre className="bg-gray-900 text-red-400 rounded-lg p-4 pr-12 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all border border-red-900/30">
              {commands.uninstallCommand}
            </pre>
            <button
              onClick={() => handleCopy(commands.uninstallCommand, 'uninstall')}
              className="absolute top-3 right-3 p-1.5 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-500 hover:text-white transition-colors"
              title="Kopyala"
            >
              {copiedField === 'uninstall' ? (
                <CheckCircle className="w-4 h-4 text-green-400" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-red-600">
            Bu komut cihazdan Suderra Edge Agent'i tamamen kaldirir (binary, config, data, servis).
          </p>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Firmware Management Card
// ============================================================================

interface FirmwareManagementCardProps {
  device: EdgeDevice;
  refetch: () => void;
}

const FirmwareManagementCard: React.FC<FirmwareManagementCardProps> = ({ device, refetch }) => {
  const { data: versions = [], isLoading: versionsLoading } = useAvailableFirmwareVersions();
  const updateMutation = useUpdateEdgeDeviceFirmware();
  const [selectedVersion, setSelectedVersion] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  const currentVersion = device.firmwareVersion || '';
  const isUpdating = device.targetFirmwareVersion && device.targetFirmwareVersion !== currentVersion;

  const isDowngrade = useMemo(() => {
    if (!selectedVersion || !currentVersion) return false;
    const sel = selectedVersion.replace(/^v/, '');
    const cur = currentVersion.replace(/^v/, '');
    return sel.localeCompare(cur, undefined, { numeric: true }) < 0;
  }, [selectedVersion, currentVersion]);

  const handleUpdate = useCallback(() => {
    if (!selectedVersion) return;
    updateMutation.mutate(
      { id: device.id, targetVersion: selectedVersion },
      {
        onSuccess: () => {
          setShowConfirm(false);
          setSelectedVersion('');
          refetch();
        },
      },
    );
  }, [selectedVersion, device.id, updateMutation, refetch]);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Firmware Yonetimi</h3>

      {/* Current version */}
      <div className="flex items-center justify-between py-2.5 border-b border-gray-50">
        <span className="text-sm text-gray-500">Mevcut Surum</span>
        <span className="text-sm font-medium text-gray-900">
          {currentVersion || 'Bilinmiyor'}
        </span>
      </div>

      {/* Updating indicator */}
      {isUpdating && (
        <div className="flex items-center gap-2 py-2.5 border-b border-gray-50">
          <Loader2 className="w-4 h-4 animate-spin text-cyan-600" />
          <span className="text-sm text-cyan-700">
            Güncelleniyor: {device.targetFirmwareVersion}
          </span>
        </div>
      )}

      {/* Version selector */}
      <div className="mt-4">
        <label className="block text-xs font-medium text-gray-600 mb-1">Hedef Surum</label>
        <select
          value={selectedVersion}
          onChange={(e) => setSelectedVersion(e.target.value)}
          disabled={versionsLoading}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 outline-hidden disabled:bg-gray-50 disabled:text-gray-500"
        >
          <option value="">Surum secin...</option>
          {versions.map((v) => {
            const isCurrent = v.tag === currentVersion;
            const isLower = currentVersion && v.tag.replace(/^v/, '').localeCompare(currentVersion.replace(/^v/, ''), undefined, { numeric: true }) < 0;
            return (
              <option key={v.tag} value={v.tag}>
                {v.tag}
                {isCurrent ? ' (Yuklu)' : ''}
                {!isCurrent && isLower ? ' (Downgrade)' : ''}
                {v.prerelease ? ' [pre-release]' : ''}
              </option>
            );
          })}
        </select>
      </div>

      {/* Downgrade warning */}
      {selectedVersion && isDowngrade && (
        <div className="mt-2 p-2 rounded-lg bg-orange-50 border border-orange-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-600 shrink-0" />
          <span className="text-xs text-orange-800">Downgrade: Daha eski bir surum secildi</span>
        </div>
      )}

      {/* Update button */}
      <div className="mt-4">
        <button
          onClick={() => setShowConfirm(true)}
          disabled={!selectedVersion || selectedVersion === currentVersion || updateMutation.isPending}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 disabled:opacity-50 transition-colors"
        >
          {updateMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Güncelle
        </button>
      </div>

      {/* Confirmation modal */}
      {showConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) setShowConfirm(false); }}
          role="alertdialog"
          aria-modal="true"
          aria-label="Firmware Güncelleme Onayi"
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${isDowngrade ? 'bg-orange-100' : 'bg-cyan-100'}`}>
                <Upload className={`w-5 h-5 ${isDowngrade ? 'text-orange-600' : 'text-cyan-600'}`} />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Firmware Güncelleme</h3>
                <p className="text-sm text-gray-500">Bu islem cihaz yeniden baslatilmasina neden olabilir.</p>
              </div>
            </div>
            <p className="text-sm text-gray-700 mb-6">
              <strong>{currentVersion || 'Bilinmiyor'}</strong> &rarr; <strong>{selectedVersion}</strong>
              {isDowngrade && <span className="text-orange-600 font-medium"> (downgrade)</span>}
              {' '}kurulacak. Devam edilsin mi?
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                İptal
              </button>
              <button
                onClick={handleUpdate}
                disabled={updateMutation.isPending}
                className={`px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 flex items-center gap-2 ${
                  isDowngrade ? 'bg-orange-600 hover:bg-orange-700' : 'bg-cyan-600 hover:bg-cyan-700'
                }`}
              >
                {updateMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Devam
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mutation error */}
      {updateMutation.isError && (
        <div className="mt-3 p-2 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
          <span className="text-xs text-red-800">
            {updateMutation.error instanceof Error ? updateMutation.error.message : 'Güncelleme başarısız oldu'}
          </span>
        </div>
      )}

      {/* Mutation success */}
      {updateMutation.isSuccess && (
        <div className="mt-3 p-2 rounded-lg bg-green-50 border border-green-200 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />
          <span className="text-xs text-green-800">Firmware guncelleme komutu gonderildi</span>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// LoRa Section — Stats + Device Panel
// ============================================================================

interface LoRaSectionProps {
  device: EdgeDevice;
}

/**
 * LoRa tab icerik bileseni.
 * LoRaStatsCard ile ozet istatistikler + LoRaDevicesPanel ile cihaz yonetimi.
 */
const LoRaSection: React.FC<LoRaSectionProps> = ({ device }) => {
  const { data: loraDevices = [] } = useLoRaDevices(device.id);

  return (
    <div className="space-y-6">
      <LoRaStatsCard devices={loraDevices} />
      <LoRaDevicesPanel edgeDeviceId={device.id} />
    </div>
  );
};

// ============================================================================
// Edge Device Detail Page
// ============================================================================

const EdgeDeviceDetailPage: React.FC = () => {
  const { deviceId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isConfigRoute = location.pathname.endsWith('/config');
  const [activeTab, setActiveTab] = useState<'overview' | 'io' | 'config' | 'lora'>(isConfigRoute ? 'config' : 'overview');

  const { data: device, isLoading, error, refetch } = useEdgeDevice(deviceId || '');
  const approveMutation = useApproveEdgeDevice();
  const maintenanceMutation = useSetDeviceMaintenanceMode();
  const decommissionMutation = useDecommissionEdgeDevice();
  const pingMutation = usePingEdgeDevice();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 text-cyan-600 animate-spin" />
      </div>
    );
  }

  if (error || !device) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600" />
          <div>
            <p className="text-red-800 font-medium">Edge cihaz yuklenemedi</p>
            <p className="text-red-600 text-sm">{error instanceof Error ? error.message : 'Cihaz bulunamadı'}</p>
          </div>
          <Link to="/sensor/devices" className="ml-auto text-red-600 hover:text-red-800">
            Geri Don
          </Link>
        </div>
      </div>
    );
  }

  const health = getHealthStatus(device);
  const healthColor = health === 'critical' ? 'text-red-600' : health === 'warning' ? 'text-yellow-600' : 'text-green-600';

  const handleApprove = () => {
    if (window.confirm('Bu cihazi onaylamak istediginizden emin misiniz?')) {
      approveMutation.mutate(device.id, { onSuccess: () => refetch() });
    }
  };

  const handleMaintenanceToggle = () => {
    const entering = device.lifecycleState !== DeviceLifecycleState.MAINTENANCE;
    maintenanceMutation.mutate(
      { id: device.id, enabled: entering },
      { onSuccess: () => refetch() },
    );
  };

  const handleDecommission = () => {
    if (window.confirm('Bu cihazi devre disi birakmak istediginizden emin misiniz? Bu islem geri alinamaz.')) {
      decommissionMutation.mutate(
        { id: device.id, reason: 'User initiated decommission' },
        { onSuccess: () => navigate('/sensor/devices') },
      );
    }
  };

  const handlePing = () => {
    pingMutation.mutate(device.id);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/sensor/devices" className="p-2 hover:bg-gray-100 rounded-lg transition-colors" aria-label="Cihaz listesine don">
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{device.deviceName}</h1>
              <StatusBadge state={device.lifecycleState} />
              {device.isOnline ? (
                <span className="flex items-center gap-1 text-xs text-green-600"><Wifi className="w-3.5 h-3.5" />Cevrimici</span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-gray-500"><WifiOff className="w-3.5 h-3.5" />Cevrimdisi</span>
              )}
            </div>
            <p className="text-gray-500 text-sm mt-0.5">
              {device.deviceCode} · {getDeviceModelText(device.deviceModel)}
              {device.serialNumber && ` · S/N: ${device.serialNumber}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handlePing}
            disabled={pingMutation.isPending}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
          >
            <Activity className={`w-4 h-4 ${pingMutation.isPending ? 'animate-pulse' : ''}`} />
            Ping
          </button>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Yenile
          </button>
          {device.lifecycleState === DeviceLifecycleState.PENDING_APPROVAL && (
            <button
              onClick={handleApprove}
              disabled={approveMutation.isPending}
              className="flex items-center gap-2 px-3 py-2 text-sm text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50"
            >
              <CheckCircle className="w-4 h-4" />
              Onayla
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200" role="tablist">
        {(['overview', 'io', 'config'] as const).map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'text-cyan-600 border-cyan-600'
                : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab === 'overview' && <><Activity className="w-4 h-4" />Genel Bakis</>}
            {tab === 'io' && <><Settings className="w-4 h-4" />I/O Konfigurasyonu</>}
            {tab === 'config' && <><Cpu className="w-4 h-4" />Cihaz Ayarlari</>}
          </button>
        ))}
        {/* LoRa tab — sadece lorawan capability aktifse gosterilir */}
        {(() => {
          const loraCapability = (device.capabilities as Record<string, unknown>)?.lorawan;
          const isLoRaEnabled = typeof loraCapability === 'object' && loraCapability !== null
            ? (loraCapability as Record<string, unknown>).enabled === true
            : loraCapability === true;
          return isLoRaEnabled;
        })() && (
          <button
            role="tab"
            aria-selected={activeTab === 'lora'}
            onClick={() => setActiveTab('lora')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'lora'
                ? 'text-cyan-600 border-cyan-600'
                : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <Radio className="w-4 h-4" />
            LoRa Cihazlar
          </button>
        )}
      </div>

      {/* OVERVIEW TAB */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Device Info */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex flex-col items-center text-center mb-6">
              <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                <Server className="w-8 h-8 text-gray-600" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900">{device.deviceName}</h2>
              <p className="text-sm text-gray-500">{getDeviceModelText(device.deviceModel)}</p>
              <div className={`mt-2 flex items-center gap-1 text-sm font-medium ${healthColor}`}>
                {health === 'good' && <><CheckCircle className="w-4 h-4" />Saglikli</>}
                {health === 'warning' && <><AlertTriangle className="w-4 h-4" />Uyari</>}
                {health === 'critical' && <><AlertTriangle className="w-4 h-4" />Kritik</>}
              </div>
            </div>

            <div className="space-y-0">
              <InfoRow label="Cihaz Kodu" value={device.deviceCode} icon={<Tag className="w-3.5 h-3.5 text-gray-500" />} />
              <InfoRow label="IP Adresi" value={device.ipAddress} />
              <InfoRow label="Firmware" value={device.firmwareVersion || 'Bilinmiyor'} />
              <InfoRow label="Bolge" value={device.siteId} icon={<MapPin className="w-3.5 h-3.5 text-gray-500" />} />
              <InfoRow label="Tarama Hizi" value={device.scanRateMs ? `${device.scanRateMs}ms` : null} />
              <InfoRow label="Son Gorulme" value={formatLastSeen(device.lastSeenAt)} icon={<Clock className="w-3.5 h-3.5 text-gray-500" />} />
              <InfoRow label="Kayit Tarihi" value={new Date(device.createdAt).toLocaleDateString('tr-TR')} />
            </div>
          </div>

          {/* System Metrics + Stats */}
          <div className="lg:col-span-2 space-y-6">
            {/* Metrics */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Sistem Metrikleri</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <MetricBar label="CPU" value={device.cpuUsage} icon={<Cpu className="w-4 h-4 text-blue-500" />} />
                <MetricBar label="Bellek" value={device.memoryUsage} icon={<MemoryStick className="w-4 h-4 text-purple-500" />} />
                <MetricBar label="Depolama" value={device.storageUsage} icon={<HardDrive className="w-4 h-4 text-orange-500" />} />
                <MetricBar label="Sicaklik" value={device.temperatureCelsius} unit="°C" icon={<Thermometer className="w-4 h-4 text-red-500" />} />
              </div>
              {!device.cpuUsage && !device.memoryUsage && !device.storageUsage && !device.temperatureCelsius && (
                <p className="text-gray-500 text-sm text-center py-4">Metrik verisi henuz gelmedi</p>
              )}
            </div>

            {/* Connection Info */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Baglanti Bilgileri</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-500">Baglanti Kalitesi</p>
                  <p className="font-medium text-gray-900">{device.connectionQuality != null ? `${device.connectionQuality}%` : '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">MQTT Client ID</p>
                  <p className="font-medium text-gray-900 text-xs break-all">{device.mqttClientId || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Guvenlik Seviyesi</p>
                  <p className="font-medium text-gray-900 flex items-center gap-1">
                    <Shield className="w-4 h-4 text-blue-500" />
                    {device.securityLevel != null ? `SL-${device.securityLevel}` : '-'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Sertifika</p>
                  <p className="font-medium text-gray-900">
                    {device.certificateExpiresAt
                      ? new Date(device.certificateExpiresAt).toLocaleDateString('tr-TR')
                      : '-'}
                  </p>
                </div>
              </div>
            </div>

            {/* Firmware Management */}
            <FirmwareManagementCard device={device} refetch={refetch} />

            {/* Summary stats */}
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
                <p className="text-2xl font-bold text-gray-900">{device.sensorCount ?? 0}</p>
                <p className="text-sm text-gray-500">Sensor</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
                <p className="text-2xl font-bold text-gray-900">{device.programCount ?? 0}</p>
                <p className="text-sm text-gray-500">Program</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
                <p className="text-2xl font-bold text-gray-900">{device.activeAlarmCount ?? 0}</p>
                <p className="text-sm text-gray-500">Aktif Alarm</p>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleMaintenanceToggle}
                disabled={maintenanceMutation.isPending}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                  device.lifecycleState === DeviceLifecycleState.MAINTENANCE
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
                }`}
              >
                {device.lifecycleState === DeviceLifecycleState.MAINTENANCE ? (
                  <><Play className="w-4 h-4" />Bakimdan Cikar</>
                ) : (
                  <><Pause className="w-4 h-4" />Bakim Moduna Al</>
                )}
              </button>
              <button
                onClick={handleDecommission}
                disabled={decommissionMutation.isPending || device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED}
                className="flex items-center gap-2 px-4 py-2 bg-red-100 text-red-700 hover:bg-red-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                <Power className="w-4 h-4" />
                Devre Disi Birak
              </button>
            </div>
          </div>
        </div>
      )}

      {/* I/O CONFIG TAB */}
      {activeTab === 'io' && (
        <IoConfigSection device={device} refetch={refetch} />
      )}

      {/* CONFIG TAB */}
      {activeTab === 'config' && (
        <div className="space-y-6">
          {/* Install Commands */}
          <InstallCommandsSection deviceId={device.id} />

          {/* Tags */}
          {device.tags && device.tags.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Etiketler</h3>
              <div className="flex flex-wrap gap-2">
                {device.tags.map((tag) => (
                  <span key={tag} className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm">{tag}</span>
                ))}
              </div>
            </div>
          )}

          {/* Capabilities */}
          {device.capabilities && Object.keys(device.capabilities).length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Yetenekler</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {Object.entries(device.capabilities).map(([key, enabled]) => (
                  <div key={key} className={`flex items-center gap-2 p-2 rounded-lg ${enabled ? 'bg-green-50' : 'bg-gray-50'}`}>
                    {enabled ? (
                      <CheckCircle className="w-4 h-4 text-green-600" />
                    ) : (
                      <span className="w-4 h-4 rounded-full border-2 border-gray-300" />
                    )}
                    <span className={`text-sm ${enabled ? 'text-green-800' : 'text-gray-500'}`}>{key}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Raw Config */}
          {device.config && Object.keys(device.config).length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Cihaz Konfigurasyonu</h3>
              <pre className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700 overflow-x-auto">
                {JSON.stringify(device.config, null, 2)}
              </pre>
            </div>
          )}

          {/* Description */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Açıklama</h3>
            <p className="text-gray-600">{device.description || 'Açıklama eklenmemis.'}</p>
          </div>
        </div>
      )}

      {/* LORA TAB */}
      {activeTab === 'lora' && (
        <LoRaSection device={device} />
      )}

      {/* Ping result toast */}
      {pingMutation.isSuccess && pingMutation.data && (
        <div className="fixed bottom-6 right-6 bg-white rounded-lg shadow-lg border border-gray-200 p-4 z-50 animate-fade-in">
          <div className="flex items-center gap-3">
            {pingMutation.data.success ? (
              <CheckCircle className="w-5 h-5 text-green-600" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-red-600" />
            )}
            <div>
              <p className="font-medium text-gray-900">
                {pingMutation.data.success ? 'Ping Basarili' : 'Ping Basarisiz'}
              </p>
              {pingMutation.data.latencyMs != null && (
                <p className="text-sm text-gray-500">{pingMutation.data.latencyMs}ms</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EdgeDeviceDetailPage;
