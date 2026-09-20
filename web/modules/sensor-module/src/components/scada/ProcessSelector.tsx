/**
 * Process Selector Component
 * Dropdown to select a process for SCADA view
 */

import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, Play, Pause, FileText, Check } from 'lucide-react';
import { useScadaViewerStore, ScadaProcess } from '../../store/scadaViewerStore';
import { ToggleButton } from '@aquaculture/shared-ui';

interface ProcessSelectorProps {
  className?: string;
}

const statusConfig: Record<string, { label: string; color: string; icon: typeof FileText }> = {
  draft: {
    label: 'Taslak',
    color: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
    icon: FileText,
  },
  active: {
    label: 'Aktif',
    color: 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300',
    icon: Play,
  },
  inactive: {
    label: 'Pasif',
    color: 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
    icon: Pause,
  },
  archived: {
    label: 'Arşivlenmiş',
    color: 'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300',
    icon: FileText,
  },
};

const defaultStatus = {
  label: 'Bilinmiyor',
  color: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
  icon: FileText,
};

export const ProcessSelector: React.FC<ProcessSelectorProps> = ({ className = '' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { processes, selectedProcessId, selectedProcess, setSelectedProcessId } =
    useScadaViewerStore();

  // Filter processes based on search
  const filteredProcesses = processes.filter(
    (process) =>
      process.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      process.description?.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelectProcess = (process: ScadaProcess) => {
    setSelectedProcessId(process.id);
    setIsOpen(false);
    setSearchTerm('');
  };

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      {/* Trigger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className={`
          flex items-center gap-2 px-4 py-2
          bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg
          hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors
          min-w-[200px] max-w-[300px]
          ${isOpen ? 'ring-2 ring-info-500 border-info-500' : ''}
        `}
      >
        <FileText size={18} className="text-gray-500 dark:text-gray-400 flex-shrink-0" />
        <span className="flex-1 text-left truncate text-sm font-medium text-gray-700 dark:text-gray-300">
          {selectedProcess ? selectedProcess.name : 'Proses Seçin'}
        </span>
        <ChevronDown
          size={18}
          className={`text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-2 w-80 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg">
          {/* Search */}
          <div className="p-2 border-b border-gray-100 dark:border-gray-700">
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400"
              />
              <input
                type="text"
                placeholder="Proses ara..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-info-500"
                autoFocus
              />
            </div>
          </div>

          {/* Process list */}
          <div className="max-h-64 overflow-y-auto">
            {filteredProcesses.length === 0 ? (
              <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
                Proses bulunamadı
              </div>
            ) : (
              <div className="p-1">
                {filteredProcesses.map((process) => {
                  const status = statusConfig[process.status] || defaultStatus;
                  const StatusIcon = status.icon;
                  const isSelected = selectedProcessId === process.id;

                  return (
                    <ToggleButton
                      key={process.id}
                      onClick={() => handleSelectProcess(process)}
                      pressed={isSelected}
                      className="w-full flex items-start gap-3 p-3 rounded-lg text-left transition-colors"
                      pressedClassName="bg-info-50 dark:bg-info-900/20"
                      idleClassName="hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      {/* Status icon */}
                      <div className={`p-1.5 rounded ${status.color}`}>
                        <StatusIcon size={16} />
                      </div>

                      {/* Process info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                            {process.name}
                          </span>
                          {isSelected && (
                            <Check
                              size={16}
                              className="text-info-600 dark:text-info-400 flex-shrink-0"
                            />
                          )}
                        </div>
                        {process.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                            {process.description}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${status.color}`}>
                            {status.label}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {process.nodes.length} ekipman
                          </span>
                        </div>
                      </div>
                    </ToggleButton>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-2 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 rounded-b-lg">
            <div className="text-xs text-gray-500 dark:text-gray-400 text-center">
              {processes.length} proses mevcut
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProcessSelector;
