/**
 * Shared tag binding section for SVG shape widgets.
 * Adds device-aware tag selection to any SVG shape, making it data-driven.
 *
 * Architecture: This is the missing link between SVG shapes and the
 * animation/event/alarm system. Without a bound tag, SVG shapes are
 * purely decorative. With a tag, they become live process indicators
 * that respond to animations, fire events, and display alarm states.
 *
 * Optional by design -- decorative shapes keep tagName undefined.
 * The "bind" toggle lets users explicitly opt into data binding.
 * The section is collapsible and starts collapsed when no tag is bound,
 * keeping the config panel clean for purely decorative shapes.
 */

import React, { useState, useCallback } from 'react';
import { TagBrowser } from '../TagBrowser';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

interface SvgTagBindingSectionProps {
  /** Currently bound tag name, or empty string / undefined when unbound */
  tagName: string;
  /** Called when the user selects or clears a tag */
  onChange: (updates: Record<string, unknown>) => void;
  /** Device ID used by TagBrowser to fetch available tags */
  deviceId?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const SvgTagBindingSection: React.FC<SvgTagBindingSectionProps> = ({
  tagName,
  onChange,
  deviceId,
}) => {
  // Start expanded when a tag is already bound so the user sees the binding
  const [open, setOpen] = useState(Boolean(tagName));

  const handleTagChange = useCallback(
    (newTag: string) => {
      onChange({ tagName: newTag });
    },
    [onChange],
  );

  const handleClear = useCallback(() => {
    onChange({ tagName: '' });
  }, [onChange]);

  return (
    <div className="border-t border-gray-100 pt-2" data-testid="svg-tag-binding-section">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full text-xs font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-700"
        aria-expanded={open}
        aria-label="Data binding settings"
      >
        <span className="flex items-center gap-1.5">
          Data Binding
          {tagName && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" title="Tag bound" />
          )}
        </span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="space-y-2 mt-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tag</label>
            <TagBrowser
              deviceId={deviceId ?? null}
              value={tagName}
              onChange={handleTagChange}
              placeholder="Select tag to bind..."
            />
          </div>

          {/* Show clear button only when a tag is bound */}
          {tagName && (
            <button
              type="button"
              onClick={handleClear}
              className="w-full py-1 text-[10px] text-gray-400 hover:text-red-500 border border-gray-200 hover:border-red-200 rounded-lg transition-colors"
              aria-label="Clear tag binding"
              data-testid="clear-tag-binding"
            >
              Clear Binding
            </button>
          )}

          {!deviceId && (
            <p className="text-[10px] text-amber-500">
              Select a target device in widget properties to browse tags.
            </p>
          )}
        </div>
      )}
    </div>
  );
};
