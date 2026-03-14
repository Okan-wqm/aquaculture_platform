import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { ChevronDown, Search, X, Loader2 } from 'lucide-react';
import { useDeviceTags, TagInfo } from '../../hooks/useDeviceTags';
import { IoType } from '../../hooks/useEdgeDevices';

interface TagBrowserProps {
  deviceId: string | null;
  value: string;
  onChange: (tagName: string) => void;
  placeholder?: string;
  multiple?: boolean;
}

const IO_BADGE_COLORS: Record<IoType, string> = {
  [IoType.AI]: 'bg-blue-100 text-blue-700',
  [IoType.AO]: 'bg-purple-100 text-purple-700',
  [IoType.DI]: 'bg-green-100 text-green-700',
  [IoType.DO]: 'bg-orange-100 text-orange-700',
};

export const TagBrowser: React.FC<TagBrowserProps> = ({
  deviceId,
  value,
  onChange,
  placeholder = 'Select tag...',
  multiple = false,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { groupedTags, loading, error } = useDeviceTags(deviceId);

  // Parse selected tags for multiple mode
  const selectedTags = useMemo<string[]>(() => {
    if (!multiple || !value) return [];
    return value.split(',').map((t) => t.trim()).filter(Boolean);
  }, [multiple, value]);

  // Filter grouped tags by search term
  const filteredGroups = useMemo(() => {
    const term = search.toLowerCase();
    if (!term) return groupedTags;
    return groupedTags
      .map((group) => ({
        ...group,
        tags: group.tags.filter(
          (tag) =>
            tag.name.toLowerCase().includes(term) ||
            (tag.description && tag.description.toLowerCase().includes(term)) ||
            tag.unit.toLowerCase().includes(term),
        ),
      }))
      .filter((group) => group.tags.length > 0);
  }, [groupedTags, search]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = useCallback(
    (tagName: string) => {
      if (multiple) {
        const current = value ? value.split(',').map((t) => t.trim()).filter(Boolean) : [];
        if (current.includes(tagName)) return; // already selected
        const next = [...current, tagName].join(', ');
        onChange(next);
      } else {
        onChange(tagName);
        setOpen(false);
      }
      setSearch('');
    },
    [multiple, value, onChange],
  );

  const handleRemoveTag = useCallback(
    (tagName: string) => {
      const current = value.split(',').map((t) => t.trim()).filter(Boolean);
      const next = current.filter((t) => t !== tagName).join(', ');
      onChange(next);
    },
    [value, onChange],
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (open) {
      setSearch(v);
    } else {
      // Direct typing mode (manual tag entry)
      if (!multiple) {
        onChange(v);
      } else {
        setSearch(v);
      }
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && search && multiple) {
      handleSelect(search);
      e.preventDefault();
    }
    if (e.key === 'Escape') {
      setOpen(false);
      setSearch('');
    }
  };

  const handleToggle = () => {
    setOpen((prev) => !prev);
    if (!open) {
      setSearch('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const renderTagItem = (tag: TagInfo) => {
    const isSelected = multiple && selectedTags.includes(tag.name);
    return (
      <button
        key={tag.name}
        type="button"
        onClick={() => handleSelect(tag.name)}
        disabled={isSelected}
        className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-cyan-50 transition-colors ${
          isSelected ? 'opacity-40 cursor-default' : 'cursor-pointer'
        }`}
      >
        <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded ${IO_BADGE_COLORS[tag.ioType]}`}>
          {tag.ioType}
        </span>
        <span className="flex-1 truncate font-medium text-gray-800">{tag.name}</span>
        {tag.unit && <span className="text-xs text-gray-500">{tag.unit}</span>}
        <span className="text-[10px] text-gray-500 shrink-0">CH{tag.channel}</span>
      </button>
    );
  };

  const renderDropdownContent = () => {
    if (!deviceId) {
      return <div className="px-3 py-4 text-sm text-gray-500 text-center">Select a target device first</div>;
    }
    if (loading) {
      return (
        <div className="px-3 py-4 flex items-center justify-center gap-2 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading...
        </div>
      );
    }
    if (error) {
      return <div className="px-3 py-4 text-sm text-red-400 text-center">{error}</div>;
    }
    if (filteredGroups.length === 0) {
      return (
        <div className="px-3 py-4 text-sm text-gray-500 text-center">
          {search ? 'No results found' : 'No tags found for this device'}
        </div>
      );
    }
    return filteredGroups.map((group) => (
      <div key={group.ioType}>
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-50 sticky top-0">
          {group.label}
        </div>
        {group.tags.map(renderTagItem)}
      </div>
    ));
  };

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Selected chips for multiple mode */}
      {multiple && selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {selectedTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-cyan-50 text-cyan-700 border border-cyan-200 rounded-full"
            >
              {tag}
              <button
                type="button"
                onClick={() => handleRemoveTag(tag)}
                className="hover:text-red-500 transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input + toggle */}
      <div className="relative flex">
        <div className="relative flex-1">
          {open && (
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={open ? search : multiple ? '' : value}
            onChange={handleInputChange}
            onFocus={() => setOpen(true)}
            onKeyDown={handleInputKeyDown}
            placeholder={open ? 'Search...' : multiple && selectedTags.length > 0 ? 'Add tag...' : placeholder}
            className={`w-full py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 ${
              open ? 'pl-8 pr-3' : 'pl-3 pr-8'
            }`}
          />
        </div>
        <button
          type="button"
          onClick={handleToggle}
          className="absolute right-0 top-0 h-full px-2.5 text-gray-500 hover:text-gray-600 transition-colors"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {renderDropdownContent()}
        </div>
      )}
    </div>
  );
};
