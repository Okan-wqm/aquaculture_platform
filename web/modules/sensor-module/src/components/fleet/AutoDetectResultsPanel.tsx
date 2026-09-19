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
import { DataTable, type DataTableColumn, Spinner, Button } from '@aquaculture/shared-ui';

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
  RevolutionPi: {
    label: 'Revolution Pi',
    color: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  },
  RaspberryPi: {
    label: 'Raspberry Pi',
    color: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  },
  GenericLinux: {
    label: 'Generic Linux',
    color: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  },
  Unknown: {
    label: 'Unknown',
    color: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  },
};

const PlatformBadge: React.FC<{ platform: string }> = ({ platform }) => {
  const config = platformConfig[platform] ?? platformConfig.Unknown;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.color}`}
    >
      <Cpu className="w-3 h-3" />
      {config.label}
    </span>
  );
};

// ============================================================================
// I/O Type Badge (reusable color coding)
// ============================================================================

const ioTypeBadgeColors: Record<string, string> = {
  DI: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  DO: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  AI: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  AO: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
};

const IoTypeBadge: React.FC<{ ioType: string }> = ({ ioType }) => (
  <span
    className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${ioTypeBadgeColors[ioType] ?? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}
  >
    {ioType}
  </span>
);

// ============================================================================
// Source Badge (I2C / SPI / UART / GPIO / piControl / sysfs)
// ============================================================================

const sourceBadgeConfig: Record<string, { label: string; color: string }> = {
  picontrol: {
    label: 'piControl',
    color: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  },
  gpiochip: {
    label: 'GPIO',
    color: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  },
  sysfs: {
    label: 'sysfs',
    color: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  },
  i2c: {
    label: 'I2C',
    color: 'bg-primary-100 dark:bg-primary-900/40 text-primary-800 dark:text-primary-200',
  },
  spi: {
    label: 'SPI',
    color: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  },
  uart: {
    label: 'UART',
    color: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  },
};

const SourceBadge: React.FC<{ source: string }> = ({ source }) => {
  const config = sourceBadgeConfig[source] ?? {
    label: source,
    color: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
  };
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

  const allSelected =
    selectedTags.size === selectableChannels.length && selectableChannels.length > 0;

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
  const mapIoType = (s: string): IoType => IoType[s as keyof typeof IoType] ?? IoType.DI;
  const mapDataType = (s: string): IoDataType =>
    IoDataType[s as keyof typeof IoDataType] ?? IoDataType.BOOL;

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

  // Rows group by source; each group is its own DataTable under a collapsible header.
  type DetectedChannelRow = (typeof groupedChannels)[number][1][number];
  const moduleChannelDisplay = (ch: DetectedChannelRow): React.ReactNode => {
    if (ch.source === 'i2c' || ch.busType === 'i2c') {
      const addrHex =
        ch.i2cAddress != null
          ? `0x${ch.i2cAddress.toString(16).toUpperCase().padStart(2, '0')}`
          : '?';
      return (
        <>
          Bus {ch.i2cBus ?? '?'} @ {addrHex}
          {ch.i2cDeviceName && (
            <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400">
              {ch.i2cDeviceName}
            </span>
          )}
        </>
      );
    }
    if (ch.source === 'spi' || ch.busType === 'spi')
      return (
        <>
          Bus {ch.spiBus ?? '?'} CS{ch.spiCs ?? '?'}
        </>
      );
    if (ch.source === 'uart' || ch.busType === 'uart') return <>{ch.uartPort ?? '?'}</>;
    return (
      <>
        {ch.moduleAddress}/{ch.channel}
        {ch.gpioPin != null && (
          <span className="text-gray-500 dark:text-gray-400 ml-1">(GPIO {ch.gpioPin})</span>
        )}
      </>
    );
  };
  const detectedChannelColumns: DataTableColumn<DetectedChannelRow>[] = [
    {
      key: 'selected',
      header: '',
      width: '2rem',
      render: (_value, ch) =>
        existingTagNames.has(ch.tagName) ? (
          <span className="text-gray-500 dark:text-gray-400">--</span>
        ) : selectedTags.has(ch.tagName) ? (
          <CheckSquare className="w-4 h-4 text-info-600 dark:text-info-400" />
        ) : (
          <Square className="w-4 h-4 text-gray-500 dark:text-gray-400" />
        ),
    },
    {
      key: 'tagName',
      header: 'Tag',
      render: (_value, ch) => (
        <span className="font-medium text-gray-900 dark:text-gray-100">{ch.tagName}</span>
      ),
    },
    { key: 'ioType', header: 'Tip', render: (_value, ch) => <IoTypeBadge ioType={ch.ioType} /> },
    {
      key: 'dataType',
      header: 'Veri Tipi',
      render: (_value, ch) => (
        <span className="text-gray-600 dark:text-gray-400 font-mono text-xs">{ch.dataType}</span>
      ),
    },
    {
      key: 'moduleChannel',
      header: 'Modul/Kanal',
      render: (_value, ch) => (
        <span className="text-gray-600 dark:text-gray-400">{moduleChannelDisplay(ch)}</span>
      ),
    },
    { key: 'source', header: 'Kaynak', render: (_value, ch) => <SourceBadge source={ch.source} /> },
    {
      key: 'status',
      header: 'Durum',
      render: (_value, ch) =>
        existingTagNames.has(ch.tagName) ? (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300">
            Zaten mevcut
          </span>
        ) : (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300">
            Yeni
          </span>
        ),
    },
  ];

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-900 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <Search className="w-5 h-5 text-info-600 dark:text-info-400" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              I/O Auto-Detection Sonuçları
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {scanResult.totalFound} kanal bulundu
            </p>
          </div>
          <PlatformBadge platform={scanResult.platform} />
        </div>
        <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Kapat">
          <X className="w-4 h-4 text-gray-500 dark:text-gray-400" />
        </Button>
      </div>

      {/* Import result feedback */}
      {importResult && (
        <div className="mx-4 mt-3 p-3 rounded-lg bg-success-50 dark:bg-success-900/20 border border-success-200 dark:border-success-800 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-success-600 dark:text-success-400 shrink-0" />
          <span className="text-sm text-success-800 dark:text-success-200">
            {importResult.createdCount} kanal eklendi
            {importResult.skippedCount > 0 &&
              `, ${importResult.skippedCount} atlanıldı (duplicate)`}
          </span>
        </div>
      )}

      {importError && (
        <div className="mx-4 mt-3 p-3 rounded-lg bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-error-600 dark:text-error-400 shrink-0" />
          <span className="text-sm text-error-800 dark:text-error-200">{importError}</span>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
        <Button
          variant="ghost"
          size="xs"
          onClick={toggleAll}
          disabled={selectableChannels.length === 0}
        >
          {allSelected ? (
            <CheckSquare className="w-3.5 h-3.5 text-info-600 dark:text-info-400" />
          ) : (
            <Square className="w-3.5 h-3.5" />
          )}
          {allSelected ? 'Hepsini Kaldır' : 'Hepsini Seç'}
        </Button>
        <Button
          variant="primary"
          size="xs"
          onClick={handleImport}
          disabled={selectedTags.size === 0 || isImporting || !!importResult}
        >
          {isImporting ? (
            <Spinner size="sm" color="inherit" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )}
          Import ({selectedTags.size})
        </Button>
      </div>

      {/* Channel table */}
      <div className="max-h-[400px] overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
        {groupedChannels.map(([source, channels]) => {
          const isCollapsed = collapsedGroups.has(source);
          return (
            <div key={source}>
              <button
                type="button"
                onClick={() => toggleGroup(source)}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-2 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                {isCollapsed ? (
                  <ChevronRight className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                )}
                <SourceBadge source={source} />
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {channels.length} kanal
                </span>
              </button>
              {!isCollapsed && (
                <DataTable<DetectedChannelRow>
                  data={channels}
                  columns={detectedChannelColumns}
                  keyExtractor={(ch) => `${ch.tagName}-${ch.channel}`}
                  onRowClick={(ch) => {
                    if (!existingTagNames.has(ch.tagName)) toggleChannel(ch.tagName);
                  }}
                  rowClassName={(ch) =>
                    existingTagNames.has(ch.tagName)
                      ? 'opacity-50 bg-gray-50 dark:bg-gray-800'
                      : 'cursor-pointer'
                  }
                  emptyMessage="Kanal yok"
                  searchable={false}
                  sortable={false}
                  stickyHeader={false}
                  compact
                  className="border-0 rounded-none shadow-none"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Empty state */}
      {scanResult.discoveredChannels.length === 0 && (
        <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
          <Search className="w-8 h-8 mx-auto mb-2 text-gray-500 dark:text-gray-400" />
          <p className="text-sm">Hiçbir I/O kanalı bulunamadı.</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Cihazda I/O modülleri takıldığından emin olun.
          </p>
        </div>
      )}
    </div>
  );
};

export default AutoDetectResultsPanel;
