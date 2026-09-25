/**
 * Search Input Component
 * Specialized input for search functionality with debounce
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';

import { useI18n } from '../../i18n';
import { Search as SearchIcon, X } from 'lucide-react';

export interface SearchInputProps {
  value?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  onSearch?: (value: string) => void;
  debounceMs?: number;
  size?: 'sm' | 'md' | 'lg';
  showClearButton?: boolean;
  loading?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

export const SearchInput: React.FC<SearchInputProps> = ({
  value: controlledValue,
  placeholder: placeholderProp,
  onChange,
  onSearch,
  debounceMs = 300,
  size = 'md',
  showClearButton = true,
  loading = false,
  disabled = false,
  autoFocus = false,
  className = '',
}) => {
  const { t } = useI18n();
  const placeholder = placeholderProp ?? t('table.searchPlaceholder');
  const [internalValue, setInternalValue] = useState(controlledValue || '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  // BUG-010: Store onSearch in a ref so pending debounce timeouts always call the
  // latest version of the callback, even if the prop changes between schedule and fire.
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  // Sync with controlled value
  useEffect(() => {
    if (controlledValue !== undefined) {
      setInternalValue(controlledValue);
    }
  }, [controlledValue]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setInternalValue(newValue);
      onChange?.(newValue);

      // PERF-013: Always clear previous timer before scheduling new one
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
      // BUG-010: Read onSearch from ref inside the timeout so it always reflects
      // the latest prop value at fire time, not the value captured at schedule time.
      if (onSearchRef.current) {
        debounceRef.current = setTimeout(() => {
          onSearchRef.current?.(newValue);
        }, debounceMs);
      }
    },
    [onChange, debounceMs],
  );

  const handleClear = useCallback(() => {
    setInternalValue('');
    onChange?.('');
    onSearchRef.current?.('');
    inputRef.current?.focus();
  }, [onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && onSearchRef.current) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }
        // BUG-010: Use ref to get latest onSearch at call time
        onSearchRef.current(internalValue);
      }
      if (e.key === 'Escape') {
        handleClear();
      }
    },
    [internalValue, handleClear],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm pl-9',
    md: 'px-4 py-2 text-sm pl-10',
    lg: 'px-4 py-2.5 text-base pl-11',
  };

  const iconSizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-5 h-5',
  };

  return (
    <div className={`relative ${className}`}>
      {/* Search Icon */}
      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
        {loading ? (
          <svg
            className={`${iconSizeClasses[size]} text-gray-500 dark:text-gray-400 animate-spin`}
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : (
          <SearchIcon
            className={`${iconSizeClasses[size]} text-gray-500 dark:text-gray-400`}
            aria-hidden="true"
          />
        )}
      </div>

      {/* Input */}
      <input
        ref={inputRef}
        type="text"
        value={internalValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        className={`
          block w-full rounded-lg border border-gray-300 dark:border-gray-600
          bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100
          focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-primary-500
          disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed
          transition-colors duration-200
          ${sizeClasses[size]}
          ${showClearButton && internalValue ? 'pr-10' : ''}
        `}
      />

      {/* Clear Button */}
      {showClearButton && internalValue && !disabled && (
        <button
          type="button"
          onClick={handleClear}
          aria-label={t('a11y.clearSearch')}
          className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          <X className={iconSizeClasses[size]} aria-hidden="true" />
        </button>
      )}
    </div>
  );
};

export default SearchInput;
