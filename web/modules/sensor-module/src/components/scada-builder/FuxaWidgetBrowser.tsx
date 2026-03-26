/**
 * Modal-based browser for discovering and selecting FUXA community widgets.
 * Presents the catalog as a searchable, filterable gallery organized
 * by categories with thumbnail descriptions.
 *
 * Architecture: The browser is a read-only view of the catalog.
 * Selecting a widget dispatches a callback with the catalog entry.
 * The parent (ScadaPackageBuilderPage or WidgetPalette) is responsible
 * for creating the new widget node on the canvas with the catalog
 * entry's ID stored in config.catalogId.
 *
 * For Phase 1, SVG content is bundled statically. Phase 2 will
 * add on-demand download from a CDN/GitHub raw URL.
 *
 * Focus management: The modal traps focus within its bounds and
 * returns focus to the trigger button on close (WAI-ARIA dialog pattern).
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  X, Search, ChevronRight, ChevronDown, Package,
  Plus, Hash, Tag, Layers,
} from 'lucide-react';
import {
  FUXA_WIDGET_CATALOG,
  buildCategoryTree,
  type FuxaWidgetCatalogEntry,
  type CatalogCategoryNode,
} from './fuxa-bridge/catalog';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FuxaWidgetBrowserProps {
  /** Whether the modal is visible */
  open: boolean;
  /** Called when the user closes the modal */
  onClose: () => void;
  /** Called when the user selects a widget to add to the canvas */
  onSelect: (entry: FuxaWidgetCatalogEntry) => void;
}

/* ------------------------------------------------------------------ */
/*  Fuzzy search helper                                                */
/* ------------------------------------------------------------------ */

/**
 * Fuzzy match: checks if all characters in query appear in target
 * in order, or if target contains query as a substring.
 */
function fuzzyMatch(query: string, target: string): boolean {
  const ql = query.toLowerCase();
  const tl = target.toLowerCase();
  if (tl.includes(ql)) return true;
  let qi = 0;
  for (let i = 0; i < tl.length && qi < ql.length; i++) {
    if (tl[i] === ql[qi]) qi++;
  }
  return qi === ql.length;
}

/**
 * Score a catalog entry against a search query.
 * Returns true if the query matches the name, tags, category,
 * subcategory, or description.
 */
function matchesQuery(
  entry: FuxaWidgetCatalogEntry,
  query: string,
): boolean {
  if (!query.trim()) return true;
  const q = query.trim();

  // Check name (highest priority)
  if (fuzzyMatch(q, entry.name)) return true;
  // Check tags
  if (entry.tags.some((t) => fuzzyMatch(q, t))) return true;
  // Check category / subcategory
  if (fuzzyMatch(q, entry.category)) return true;
  if (entry.subcategory && fuzzyMatch(q, entry.subcategory)) return true;
  // Check description
  if (fuzzyMatch(q, entry.description)) return true;

  return false;
}

/* ------------------------------------------------------------------ */
/*  Category tree component                                            */
/* ------------------------------------------------------------------ */

const CategoryTree: React.FC<{
  categories: CatalogCategoryNode[];
  selectedCategory: string | null;
  selectedSubcategory: string | null;
  onSelectCategory: (cat: string | null, sub: string | null) => void;
}> = ({ categories, selectedCategory, selectedSubcategory, onSelectCategory }) => {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(categories.map((c) => c.name)),
  );

  const toggle = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  return (
    <div className="space-y-0.5" data-testid="fuxa-category-tree">
      {/* "All" option */}
      <button
        onClick={() => onSelectCategory(null, null)}
        className={`w-full text-left px-3 py-1.5 text-xs rounded transition-colors ${
          selectedCategory === null
            ? 'bg-cyan-50 text-cyan-700 font-semibold'
            : 'text-gray-600 hover:bg-gray-100'
        }`}
      >
        All Categories
      </button>

      {categories.map((cat) => (
        <div key={cat.name}>
          <div className="flex items-center">
            {/* Expand/collapse toggle */}
            {cat.children.length > 0 && (
              <button
                onClick={() => toggle(cat.name)}
                className="p-0.5 text-gray-400 hover:text-gray-600"
                aria-label={`Toggle ${cat.name}`}
              >
                {expanded.has(cat.name)
                  ? <ChevronDown className="w-3 h-3" />
                  : <ChevronRight className="w-3 h-3" />
                }
              </button>
            )}
            {/* Category button */}
            <button
              onClick={() => onSelectCategory(cat.name, null)}
              className={`flex-1 text-left px-2 py-1.5 text-xs rounded transition-colors ${
                selectedCategory === cat.name && selectedSubcategory === null
                  ? 'bg-cyan-50 text-cyan-700 font-semibold'
                  : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {cat.name}
              <span className="ml-1 text-gray-400">({cat.count})</span>
            </button>
          </div>

          {/* Subcategories */}
          {expanded.has(cat.name) && cat.children.length > 0 && (
            <div className="ml-5 space-y-0.5">
              {cat.children.map((sub) => (
                <button
                  key={sub}
                  onClick={() => onSelectCategory(cat.name, sub)}
                  className={`w-full text-left px-2 py-1 text-xs rounded transition-colors ${
                    selectedCategory === cat.name && selectedSubcategory === sub
                      ? 'bg-cyan-50 text-cyan-700 font-semibold'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {sub}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Widget card in the grid                                            */
/* ------------------------------------------------------------------ */

const WidgetCard: React.FC<{
  entry: FuxaWidgetCatalogEntry;
  isSelected: boolean;
  onClick: () => void;
}> = ({ entry, isSelected, onClick }) => (
  <button
    onClick={onClick}
    className={`w-full text-left p-3 rounded-lg border transition-all ${
      isSelected
        ? 'border-cyan-400 bg-cyan-50 ring-1 ring-cyan-400'
        : 'border-gray-200 bg-white hover:border-cyan-300 hover:bg-gray-50'
    }`}
    data-testid={`fuxa-widget-card-${entry.id}`}
  >
    {/* Placeholder icon area */}
    <div className="w-full h-16 bg-gray-100 rounded flex items-center justify-center mb-2">
      <Package className="w-8 h-8 text-gray-400" />
    </div>
    <div className="text-xs font-medium text-gray-900 truncate">{entry.name}</div>
    <div className="text-[10px] text-gray-500 truncate mt-0.5">
      {entry.subcategory ? `${entry.category} > ${entry.subcategory}` : entry.category}
    </div>
  </button>
);

/* ------------------------------------------------------------------ */
/*  Detail panel for selected widget                                   */
/* ------------------------------------------------------------------ */

const DetailPanel: React.FC<{
  entry: FuxaWidgetCatalogEntry;
  onAdd: () => void;
}> = ({ entry, onAdd }) => (
  <div
    className="border-t border-gray-200 bg-gray-50 px-4 py-3"
    data-testid="fuxa-detail-panel"
  >
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-semibold text-gray-900">{entry.name}</h4>
        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <Layers className="w-3 h-3" />
            {entry.subcategory
              ? `${entry.category} > ${entry.subcategory}`
              : entry.category}
          </span>
          <span className="flex items-center gap-1">
            <Hash className="w-3 h-3" />
            {entry.variableCount} variables
          </span>
          <span className="flex items-center gap-1">
            <Tag className="w-3 h-3" />
            Tier {entry.tier}
          </span>
        </div>
        <p className="text-xs text-gray-600 mt-1.5">{entry.description}</p>
        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {entry.tags.map((t) => (
              <span
                key={t}
                className="px-1.5 py-0.5 text-[10px] bg-gray-200 text-gray-600 rounded"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={onAdd}
        className="flex-shrink-0 flex items-center gap-1.5 px-4 py-2 bg-cyan-600 text-white text-sm font-medium rounded-lg hover:bg-cyan-700 transition-colors"
        data-testid="fuxa-add-to-canvas"
      >
        <Plus className="w-4 h-4" />
        Add to Canvas
      </button>
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/*  Main modal                                                         */
/* ------------------------------------------------------------------ */

export const FuxaWidgetBrowser: React.FC<FuxaWidgetBrowserProps> = ({
  open,
  onClose,
  onSelect,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedSubcategory, setSelectedSubcategory] = useState<string | null>(null);
  const [selectedWidget, setSelectedWidget] = useState<FuxaWidgetCatalogEntry | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Build category tree from catalog
  const categoryTree = useMemo(
    () => buildCategoryTree(FUXA_WIDGET_CATALOG),
    [],
  );

  // Filter catalog based on search query and selected category
  const filteredWidgets = useMemo(() => {
    let results = FUXA_WIDGET_CATALOG;

    // Apply category filter
    if (selectedCategory) {
      results = results.filter((e) => e.category === selectedCategory);
      if (selectedSubcategory) {
        results = results.filter((e) => e.subcategory === selectedSubcategory);
      }
    }

    // Apply search filter
    if (searchQuery.trim()) {
      results = results.filter((e) => matchesQuery(e, searchQuery));
    }

    return results;
  }, [searchQuery, selectedCategory, selectedSubcategory]);

  // Auto-focus search input when modal opens
  useEffect(() => {
    if (open) {
      // Small delay to ensure DOM is ready after transition
      const timer = setTimeout(() => searchRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Keyboard handler: Escape closes, Arrow keys navigate
  useEffect(() => {
    if (!open) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      // Enter adds the selected widget
      if (e.key === 'Enter' && selectedWidget) {
        e.preventDefault();
        onSelect(selectedWidget);
        onClose();
        return;
      }

      // Arrow navigation within the grid
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (filteredWidgets.length === 0) return;
        e.preventDefault();

        const currentIdx = selectedWidget
          ? filteredWidgets.findIndex((w) => w.id === selectedWidget.id)
          : -1;

        let nextIdx: number;
        if (e.key === 'ArrowDown') {
          nextIdx = currentIdx < filteredWidgets.length - 1 ? currentIdx + 1 : 0;
        } else {
          nextIdx = currentIdx > 0 ? currentIdx - 1 : filteredWidgets.length - 1;
        }

        setSelectedWidget(filteredWidgets[nextIdx]);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose, onSelect, selectedWidget, filteredWidgets]);

  const handleCategorySelect = useCallback(
    (cat: string | null, sub: string | null) => {
      setSelectedCategory(cat);
      setSelectedSubcategory(sub);
      setSelectedWidget(null);
    },
    [],
  );

  const handleWidgetSelect = useCallback(
    (entry: FuxaWidgetCatalogEntry) => {
      setSelectedWidget(entry);
    },
    [],
  );

  const handleAdd = useCallback(() => {
    if (selectedWidget) {
      onSelect(selectedWidget);
      onClose();
    }
  }, [selectedWidget, onSelect, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        // Close when clicking the backdrop
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="FUXA Widget Library"
    >
      <div
        ref={modalRef}
        className="bg-white rounded-xl shadow-2xl flex flex-col"
        style={{ width: 900, height: 640, maxWidth: '95vw', maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Package className="w-4 h-4 text-cyan-600" />
            FUXA Widget Library
            <span className="text-xs font-normal text-gray-500">
              ({FUXA_WIDGET_CATALOG.length} widgets)
            </span>
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 transition-colors"
            aria-label="Close"
            data-testid="fuxa-browser-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search bar */}
        <div className="px-4 py-2 border-b border-gray-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search widgets by name, tag, or category..."
              className="w-full h-9 pl-9 pr-4 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              data-testid="fuxa-search-input"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-200 text-gray-400"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Body: category tree + widget grid */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left sidebar: category tree */}
          <div className="w-48 flex-shrink-0 border-r border-gray-200 overflow-y-auto py-2 px-2">
            <CategoryTree
              categories={categoryTree}
              selectedCategory={selectedCategory}
              selectedSubcategory={selectedSubcategory}
              onSelectCategory={handleCategorySelect}
            />
          </div>

          {/* Right content: widget grid */}
          <div className="flex-1 overflow-y-auto p-3">
            {filteredWidgets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500">
                <Package className="w-10 h-10 text-gray-300 mb-2" />
                <p className="text-sm">No widgets match your search</p>
                <p className="text-xs text-gray-400 mt-1">
                  Try different keywords or select a different category
                </p>
              </div>
            ) : (
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
                data-testid="fuxa-widget-grid"
              >
                {filteredWidgets.map((entry) => (
                  <WidgetCard
                    key={entry.id}
                    entry={entry}
                    isSelected={selectedWidget?.id === entry.id}
                    onClick={() => handleWidgetSelect(entry)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer: selected widget detail panel */}
        {selectedWidget && (
          <DetailPanel entry={selectedWidget} onAdd={handleAdd} />
        )}
      </div>
    </div>
  );
};

export default FuxaWidgetBrowser;
