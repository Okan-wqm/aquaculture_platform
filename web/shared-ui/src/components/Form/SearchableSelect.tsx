/**
 * SearchableSelect Component
 * Single-select dropdown with search filtering and DOM-limited rendering.
 * Follows MultiSelect's click-outside + dropdown + ARIA pattern
 * combined with SearchInput's filtering approach.
 * Zero external dependencies — React primitives only.
 */

import React, { useState, useRef, useEffect, useId, useMemo } from 'react';
import type { Size } from '../../types';
import type { SelectOption } from './Select';

export interface SearchableSelectProps {
  label?: string;
  options: SelectOption[];
  value: string | number | '';
  onChange: (value: string | number | '') => void;
  placeholder?: string;
  searchPlaceholder?: string;
  error?: string;
  helperText?: string;
  size?: Size;
  fullWidth?: boolean;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  noResultsText?: string;
  maxDisplayOptions?: number;
}

const sizeStyles: Record<Size, string> = {
  xs: 'px-2 py-1 text-xs min-h-[26px]',
  sm: 'px-3 py-1.5 text-sm min-h-[32px]',
  md: 'px-3 py-2 text-sm min-h-[38px]',
  lg: 'px-4 py-2.5 text-base min-h-[44px]',
  xl: 'px-4 py-3 text-lg min-h-[50px]',
};

export const SearchableSelect: React.FC<SearchableSelectProps> = ({
  label,
  options,
  value,
  onChange,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  error,
  helperText,
  size = 'md',
  fullWidth = true,
  required = false,
  disabled = false,
  className = '',
  noResultsText = 'No results found',
  maxDisplayOptions = 50,
}) => {
  const generatedId = useId();
  const labelId = `${generatedId}-label`;
  const listboxId = `${generatedId}-listbox`;
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Click-outside: only listen while open
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Autofocus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value),
    [options, value],
  );

  const filteredOptions = useMemo(() => {
    if (!search) return options.slice(0, maxDisplayOptions);
    const q = search.toLowerCase();
    const matched = options.filter((opt) => opt.label.toLowerCase().includes(q));
    return matched.slice(0, maxDisplayOptions);
  }, [options, search, maxDisplayOptions]);

  const handleSelect = (optValue: string | number) => {
    onChange(optValue);
    setIsOpen(false);
    setSearch('');
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      setSearch('');
    }
    if ((e.key === 'Enter' || e.key === ' ') && !isOpen) {
      e.preventDefault();
      setIsOpen(true);
    }
  };

  const inputStateStyles = error
    ? 'border-red-500 focus-within:ring-red-500 focus-within:border-red-500'
    : 'border-gray-300 dark:border-gray-600 focus-within:ring-blue-500 focus-within:border-blue-500';

  const disabledStyles = disabled
    ? 'bg-gray-100 dark:bg-gray-800 cursor-not-allowed text-gray-500'
    : 'bg-white dark:bg-gray-700 cursor-pointer';

  return (
    <div className={`${fullWidth ? 'w-full' : ''} ${className}`}>
      {label && (
        <span
          id={labelId}
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </span>
      )}

      <div ref={containerRef} className="relative">
        {/* Trigger */}
        <div
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls={isOpen ? listboxId : undefined}
          aria-invalid={!!error}
          aria-labelledby={label ? labelId : undefined}
          tabIndex={disabled ? -1 : 0}
          onClick={() => !disabled && setIsOpen(!isOpen)}
          onKeyDown={handleKeyDown}
          className={`
            flex items-center justify-between
            rounded-lg border
            transition-colors duration-200
            focus:outline-hidden focus-within:ring-2
            ${sizeStyles[size]}
            ${inputStateStyles}
            ${disabledStyles}
            pr-10
          `}
        >
          <span className={selectedOption ? 'text-gray-900 dark:text-white truncate' : 'text-gray-500 dark:text-gray-400'}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>

          <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2">
            {/* Clear button */}
            {value !== '' && !disabled && (
              <button
                type="button"
                onClick={handleClear}
                className="p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                tabIndex={-1}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            {/* Chevron */}
            <svg
              className={`w-4 h-4 text-gray-500 transition-transform pointer-events-none ${isOpen ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        {/* Dropdown */}
        {isOpen && (
          <div className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg">
            {/* Search input */}
            <div className="p-2 border-b border-gray-200 dark:border-gray-700">
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-hidden focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setIsOpen(false);
                    setSearch('');
                  }
                  e.stopPropagation();
                }}
              />
            </div>

            {/* Options list */}
            <div
              id={listboxId}
              role="listbox"
              className="max-h-60 overflow-auto"
            >
              {filteredOptions.length === 0 ? (
                <div className="px-3 py-2 text-gray-500 dark:text-gray-400 text-sm">
                  {noResultsText}
                </div>
              ) : (
                filteredOptions.map((option) => (
                  <div
                    key={option.value}
                    role="option"
                    aria-selected={option.value === value}
                    onClick={() => !option.disabled && handleSelect(option.value)}
                    className={`
                      px-3 py-2 text-sm
                      ${option.disabled ? 'opacity-50 cursor-not-allowed text-gray-400' : 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700'}
                      ${option.value === value ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium' : 'text-gray-900 dark:text-gray-200'}
                    `}
                  >
                    {option.label}
                  </div>
                ))
              )}
              {!search && options.length > maxDisplayOptions && (
                <div className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700">
                  Showing {maxDisplayOptions} of {options.length} — type to search
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-1 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {!error && helperText && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {helperText}
        </p>
      )}
    </div>
  );
};

SearchableSelect.displayName = 'SearchableSelect';

export default SearchableSelect;
