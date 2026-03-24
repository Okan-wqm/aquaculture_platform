/**
 * AutoDetectResultsPanel — I/O Auto-Detection Scan Results
 * -----------------------------------------------------------------------
 * Edge device hardware scan sonuclarini gosteren panel component.
 * Kullanici kesfedilen I/O kanallarini secip tek tikla import edebilir.
 *
 * NASIL CALISIR:
 *   1. Parent component scan_hardware mutation'ini cagirir
 *   2. Sonuc bu panel'e prop olarak gonderilir
 *   3. Kullanici checkbox'larla hangi kanallari import edecegini secer
 *   4. "Import Selected" butonu bulkAddDeviceIoConfigs mutation'ini cagirir
 *   5. Basari/hata durumu gosterilir
 *
 * PLATFORM BADGE'LERI:
 *   - RevolutionPi: mor badge (piControl uzerinden tam tarama)
 *   - RaspberryPi: yesil badge (BCM GPIO 2-27)
 *   - GenericLinux: mavi badge (sysfs gpiochip)
 *   - Unknown: gri badge
 *
 * DUPLICATE HANDLING:
 *   Zaten mevcut olan tagName'ler gri renkte "Already exists" etiketi
 *   ile gosterilir ve checkbox'lari disabled olur.
 * -----------------------------------------------------------------------
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  Search,
  Download,
  CheckSquare,
  Square,
  Loader2,
  AlertTriangle,
  CheckCircle,
  X,
  Cpu,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

import type {
  DiscoveredIoChannel,
  HardwareScanResult,
  BulkAddIoConfigResult,
  AddIoConfigInput,
} from '../../hooks/useEdgeDevices';
import { IoType, IoDataType } from '../../hooks/useEdgeDevices';

// ============================================================================
// Types
// ============================================================================

interface AutoDetectResultsPanelProps {
  /** Scan result from useScanHardware mutation */
  scanResult: HardwareScanResult;
  /** Existing tag names on this device — for duplicate detection */
  existingTagNames: Set<string>;
  /** Callback to import selected channels */
  onImport: (inputs: AddIoConfigInput[]) => Promise<BulkAddIoConfigResult>;
  /** Whether import is in progress */
  isImporting: boolean;
  /** Close/dismiss the panel */
  onClose: () => void;
}

// ============================================================================
// Platform Badge
// ============================================================================

const platformConfig: Record<string, { label: string; color: string }> = {
  RevolutionPi: { label: 'Revolution Pi', color: 'bg-purple-100 text-purple-800' },
  RaspberryPi: { label: 'Raspberry Pi', color: 'bg-green-100 text-green-800' },
  GenericLinux: { label: 'Generic Linux', color: 'bg-blue-100 text-blue-800' },
  Unknown: { label: 'Unknown', color: 'bg-gray-100 text-gray-800' },
};

const PlatformBadge: React.FC<{ platform: string }> = ({ platform }) => {
  const config = platformConfig[platform] ?? platformConfig.Unknown;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.color}`}>
      <Cpu className="w-3 h-3" />
      {config.label}
    </span>
  );
};

// ============================================================================
// I/O Type Badge (reusable color coding)
// ============================================================================

const ioTypeBadgeColors: Record<string, string> = {
  DI: 'bg-emerald-100 text-emerald-800',
  DO: 'bg-orange-100 text-orange-800',
  AI: 'bg-sky-100 text-sky-800',
  AO: 'bg-amber-100 text-amber-800',
};

const IoTypeBadge: React.FC<{ ioType: string }> = ({ ioType }) => (
  <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${ioTypeBadgeColors[ioType] ?? 'bg-gray-100 text-gray-600'}`}>
    {ioType}
  </span>
);

// ============================================================================
// Source Badge (I2C / SPI / UART / GPIO / piControl / sysfs)
// ============================================================================

const sourceBadgeConfig: Record<string, { label: string; color: string }> = {
  picontrol: { label: 'piControl', color: 'bg-purple-100 text-purple-800' },
  gpiochip: { label: 'GPIO', color: 'bg-green-100 text-green-800' },
  sysfs: { label: 'sysfs', color: 'bg-blue-100 text-blue-800' },
  i2c: { label: 'I2C', color: 'bg-indigo-100 text-indigo-800' },
  spi: { label: 'SPI', color: 'bg-violet-100 text-violet-800' },
  uart: { label: 'UART', color: 'bg-rose-100 text-rose-800' },
};

const SourceBadge: React.FC<{ source: string }> = ({ source }) => {
  const config = sourceBadgeConfig[source] ?? { label: source, color: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${config.color}`}>
      {config.label}
    </span>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const AutoDetectResultsPanel: React.FC<AutoDetectResultsPanelProps> = ({
  scanResult,
  existingTagNames,
  onImport,
  isImporting,
  onClose,
}) => {
  // Track selected channel indices
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => {
    // Default: select all channels that don't already exist
    const initial = new Set<string>();
    for (const ch of scanResult.discoveredChannels) {
      if (!existingTagNames.has(ch.tagName)) {
        initial.add(ch.tagName);
      }
    }
    return initial;
  });

  const [importResult, setImportResult] = useState<BulkAddIoConfigResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Channels that can be selected (not already existing)
  const selectableChannels = useMemo(
    () => scanResult.discoveredChannels.filter((ch) => !existingTagNames.has(ch.tagName)),
    [scanResult.discoveredChannels, existingTagNames],
  );

  const allSelected = selectedTags.size === selectableChannels.length && selectableChannels.length > 0;

  // Group channels by source for collapsible sections
  const sourceOrder = ['picontrol', 'gpiochip', 'sysfs', 'i2c', 'spi', 'uart'];
  const groupedChannels = useMemo(() => {
    const groups = new Map<string, DiscoveredIoChannel[]>();
    for (const ch of scanResult.discoveredChannels) {
      const source = ch.source || 'unknown';
      if (!groups.has(source)) groups.set(source, []);
      groups.get(source)!.push(ch);
    }
    const sorted: Array<[string, DiscoveredIoChannel[]]> = [];
    for (const src of sourceOrder) {
      if (groups.has(src)) {
        sorted.push([src, groups.get(src)!]);
        groups.delete(src);
      }
    }
    for (const [src, chs] of groups) {
      sorted.push([src, chs]);
    }
    return sorted;
  }, [scanResult.discoveredChannels]);

  const toggleGroup = useCallback((source: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }, []);

  // Toggle a single channel
  const toggleChannel = useCallback((tagName: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagName)) {
        next.delete(tagName);
      } else {
        next.add(tagName);
      }
      return next;
    });
  }, []);

  // Select all / deselect all
  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelectedTags(new Set());
    } else {
      setSelectedTags(new Set(selectableChannels.map((ch) => ch.tagName)));
    }
  }, [allSelected, selectableChannels]);

  // Map ioType/dataType strings to enum values for AddIoConfigInput
  const mapIoType = (s: string): IoType => (IoType[s as keyof typeof IoType] ?? IoType.DI);
  const mapDataType = (s: string): IoDataType => (IoDataType[s as keyof typeof IoDataType] ?? IoDataType.BOOL);

  // Handle import
  const handleImport = useCallback(async () => {
    setImportError(null);
    setImportResult(null);

    const selectedChannels = scanResult.discoveredChannels.filter((ch) =>
      selectedTags.has(ch.tagName),
    );

    const inputs: AddIoConfigInput[] = selectedChannels.map((ch) => ({
      tagName: ch.tagName,
      description: ch.description,
      ioType: mapIoType(ch.ioType),
      dataType: mapDataType(ch.dataType),
      moduleAddress: ch.moduleAddress,
      channel: ch.channel,
      gpioPin: ch.gpioPin,
      busType: ch.busType,
      i2cBus: ch.i2cBus,
      i2cAddress: ch.i2cAddress,
      spiBus: ch.spiBus,
      spiCs: ch.spiCs,
      uartPort: ch.uartPort,
    }));

    try {
      const result = await onImport(inputs);
      setImportResult(result);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    }
  }, [scanResult.discoveredChannels, selectedTags, onImport]);

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <Search className="w-5 h-5 text-cyan-600" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900">
              I/O Auto-Detection Sonuçları
            </h3>
            <p className="text-xs text-gray-500">
              {scanResult.totalFound} kanal bulundu
            </p>
          </div>
          <PlatformBadge platform={scanResult.platform} />
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
          aria-label="Kapat"
        >
          <X className="w-4 h-4 text-gray-500" />
        </button>
      </div>

      {/* Import result feedback */}
      {importResult && (
        <div className="mx-4 mt-3 p-3 rounded-lg bg-green-50 border border-green-200 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />
          <span className="text-sm text-green-800">
            {importResult.createdCount} kanal eklendi
            {importResult.skippedCount > 0 && `, ${importResult.skippedCount} atlanıldı (duplicate)`}
          </span>
        </div>
      )}

      {importError && (
        <div className="mx-4 mt-3 p-3 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
          <span className="text-sm text-red-800">{importError}</span>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-100">
        <button
          onClick={toggleAll}
          className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors"
          disabled={selectableChannels.length === 0}
        >
          {allSelected ? (
            <CheckSquare className="w-3.5 h-3.5 text-cyan-600" />
          ) : (
            <Square className="w-3.5 h-3.5" />
          )}
          {allSelected ? 'Hepsini Kaldır' : 'Hepsini Seç'}
        </button>
        <button
          onClick={handleImport}
          disabled={selectedTags.size === 0 || isImporting || !!importResult}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isImporting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )}
          Import ({selectedTags.size})
        </button>
      </div>

      {/* Channel table */}
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left w-8"></th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tag</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tip</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Veri Tipi</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Modul/Kanal</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Kaynak</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Durum</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {groupedChannels.map(([source, channels]) => {
              const isCollapsed = collapsedGroups.has(source);
              return (
                <React.Fragment key={source}>
                  <tr
                    className="bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => toggleGroup(source)}
                  >
                    <td colSpan={7} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {isCollapsed ? (
                          <ChevronRight className="w-4 h-4 text-gray-500" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-gray-500" />
                        )}
                        <SourceBadge source={source} />
                        <span className="text-xs text-gray-500">
                          {channels.length} kanal
                        </span>
                      </div>
                    </td>
                  </tr>
                  {!isCollapsed && channels.map((ch) => {
                    const exists = existingTagNames.has(ch.tagName);
                    const isSelected = selectedTags.has(ch.tagName);

                    // Build module/channel display based on source/busType
                    let moduleChannelDisplay: React.ReactNode;
                    if (ch.source === 'i2c' || ch.busType === 'i2c') {
                      const addrHex = ch.i2cAddress != null
                        ? `0x${ch.i2cAddress.toString(16).toUpperCase().padStart(2, '0')}`
                        : '?';
                      moduleChannelDisplay = (
                        <>
                          Bus {ch.i2cBus ?? '?'} @ {addrHex}
                          {ch.i2cDeviceName && (
                            <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-indigo-50 text-indigo-600">
                              {ch.i2cDeviceName}
                            </span>
                          )}
                        </>
                      );
                    } else if (ch.source === 'spi' || ch.busType === 'spi') {
                      moduleChannelDisplay = (
                        <>Bus {ch.spiBus ?? '?'} CS{ch.spiCs ?? '?'}</>
                      );
                    } else if (ch.source === 'uart' || ch.busType === 'uart') {
                      moduleChannelDisplay = (
                        <>{ch.uartPort ?? '?'}</>
                      );
                    } else {
                      moduleChannelDisplay = (
                        <>
                          {ch.moduleAddress}/{ch.channel}
                          {ch.gpioPin != null && (
                            <span className="text-gray-500 ml-1">(GPIO {ch.gpioPin})</span>
                          )}
                        </>
                      );
                    }

                    return (
                      <tr
                        key={`${ch.tagName}-${ch.channel}`}
                        className={`${exists ? 'opacity-50 bg-gray-50' : 'hover:bg-gray-50 cursor-pointer'}`}
                        onClick={() => !exists && toggleChannel(ch.tagName)}
                      >
                        <td className="px-3 py-2">
                          {exists ? (
                            <span className="text-gray-500">--</span>
                          ) : isSelected ? (
                            <CheckSquare className="w-4 h-4 text-cyan-600" />
                          ) : (
                            <Square className="w-4 h-4 text-gray-500" />
                          )}
                        </td>
                        <td className="px-3 py-2 font-medium text-gray-900">{ch.tagName}</td>
                        <td className="px-3 py-2"><IoTypeBadge ioType={ch.ioType} /></td>
                        <td className="px-3 py-2 text-gray-600 font-mono text-xs">{ch.dataType}</td>
                        <td className="px-3 py-2 text-gray-600">
                          {moduleChannelDisplay}
                        </td>
                        <td className="px-3 py-2">
                          <SourceBadge source={ch.source} />
                        </td>
                        <td className="px-3 py-2">
                          {exists ? (
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700">
                              Zaten mevcut
                            </span>
                          ) : (
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                              Yeni
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Empty state */}
      {scanResult.discoveredChannels.length === 0 && (
        <div className="px-4 py-8 text-center text-gray-500">
          <Search className="w-8 h-8 mx-auto mb-2 text-gray-500" />
          <p className="text-sm">Hiçbir I/O kanalı bulunamadı.</p>
          <p className="text-xs text-gray-500 mt-1">
            Cihazda I/O modülleri takıldığından emin olun.
          </p>
        </div>
      )}
    </div>
  );
};

export default AutoDetectResultsPanel;
