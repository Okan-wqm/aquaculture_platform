/**
 * Process Selector Component
 * Dropdown to select a process for SCADA view
 */

import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, Play, Pause, FileText, Check } from 'lucide-react';
import { useScadaStore, ScadaProcess } from '../../store/scadaStore';

interface ProcessSelectorProps {
  className?: string;
}

const statusConfig: Record<string, { label: string; color: string; icon: typeof FileText }> = {
  draft: { label: 'Taslak', color: 'bg-gray-100 text-gray-700', icon: FileText },
  active: { label: 'Aktif', color: 'bg-green-100 text-green-700', icon: Play },
  inactive: { label: 'Pasif', color: 'bg-yellow-100 text-yellow-700', icon: Pause },
  archived: { label: 'Arşivlenmiş', color: 'bg-red-100 text-red-700', icon: FileText },
};

const defaultStatus = { label: 'Bilinmiyor', color: 'bg-gray-100 text-gray-700', icon: FileText };

export const ProcessSelector: React.FC<ProcessSelectorProps> = ({ className = '' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  const {
    processes,
    selectedProcessId,
    selectedProcess,
    setSelectedProcessId,
  } = useScadaStore();

  // Filter processes based on search
  const filteredProcesses = processes.filter(
    (process) =>
      process.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      process.description?.toLowerCase().includes(searchTerm.toLowerCase())
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
        className={`
          flex items-center gap-2 px-4 py-2
          bg-white border border-gray-300 rounded-lg
          hover:bg-gray-50 transition-colors
          min-w-[200px] max-w-[300px]
          ${isOpen ? 'ring-2 ring-blue-500 border-blue-500' : ''}
        `}
      >
        <FileText size={18} className="text-gray-500 flex-shrink-0" />
        <span className="flex-1 text-left truncate text-sm font-medium text-gray-700">
          {selectedProcess ? selectedProcess.name : 'Proses Seçin'}
        </span>
        <ChevronDown
          size={18}
          className={`text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-lg">
          {/* Search */}
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Proses ara..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
            </div>
          </div>

          {/* Process list */}
          <div className="max-h-64 overflow-y-auto">
            {filteredProcesses.length === 0 ? (
              <div className="p-4 text-center text-gray-500 text-sm">
                Proses bulunamadı
              </div>
            ) : (
              <div className="p-1">
                {filteredProcesses.map((process) => {
                  const status = statusConfig[process.status] || defaultStatus;
                  const StatusIcon = status.icon;
                  const isSelected = selectedProcessId === process.id;

                  return (
                    <button
                      key={process.id}
                      onClick={() => handleSelectProcess(process)}
                      className={`
                        w-full flex items-start gap-3 p-3 rounded-lg text-left
                        transition-colors
                        ${isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}
                      `}
                    >
                      {/* Status icon */}
                      <div className={`p-1.5 rounded ${status.color}`}>
                        <StatusIcon size={16} />
                      </div>

                      {/* Process info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 truncate">
                            {process.name}
                          </span>
                          {isSelected && (
                            <Check size={16} className="text-blue-600 flex-shrink-0" />
                          )}
                        </div>
                        {process.description && (
                          <p className="text-xs text-gray-500 truncate mt-0.5">
                            {process.description}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${status.color}`}>
                            {status.label}
                          </span>
                          <span className="text-xs text-gray-400">
                            {process.nodes.length} ekipman
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-2 border-t border-gray-100 bg-gray-50 rounded-b-lg">
            <div className="text-xs text-gray-500 text-center">
              {processes.length} proses mevcut
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProcessSelector;
