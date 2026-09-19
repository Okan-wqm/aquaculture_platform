/**
 * UnifiedLeftPanel
 *
 * Merges SceneTreePanel, WidgetPalette, and LayersPanel into a single
 * 240px-wide tabbed sidebar. Two pill-toggle tabs (Scene / Palette) sit
 * at the top; a resizable, collapsible LayersPanel is always visible at
 * the bottom.
 *
 * Palette tab enhancements: fuzzy search, recently-used, favorites,
 * category count badges, persisted expansion state.
 */

import {
  FolderTree, Palette, Search, X, Star, Clock,
  ChevronDown, ChevronRight, GripVertical, GripHorizontal,
  Gauge, Hash, Activity, ToggleLeft, SlidersHorizontal, Keyboard,
  CircleDot, AlertOctagon, TrendingUp, Bell, List, Wrench, History,
  CheckCircle, LayoutDashboard, Droplets, Link2, Type,
  GitCommitHorizontal, Square, Circle, Minus, FileImage, Calendar,
  Video, MapPinned, MoreHorizontal, Spline, Image, Hexagon,
  Triangle, Diamond, ArrowRight, Package, Zap,
  Disc3, ChevronDownSquare, BarChart3, PieChart, Table2, Globe,
} from 'lucide-react';
import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Button, Input } from '@aquaculture/shared-ui';

import {
  PALETTE_CATEGORIES,
  DEFAULT_EXPANDED_CATEGORIES,
  paletteWidgetKey,
  type PaletteWidgetDef,
} from '../../constants/scada-palette-categories';
import {
  WIDGET_SIZES, GRID_CELL_W, GRID_CELL_H, EQUIPMENT_SUBTYPE_SIZES,
} from '../../constants/scada-widget-sizes';
import { useScadaPackageStore } from '../../store/scada';
import type { EquipmentSubType } from '../../types/scada-widget.types';

import type { FuxaWidgetCatalogEntry } from './fuxa-bridge/catalog';
import { FuxaWidgetBrowser } from './FuxaWidgetBrowser';
import { LayersPanel } from './LayersPanel';
import { SceneTreePanel } from './SceneTreePanel';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface UnifiedLeftPanelProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

type TabId = 'scene' | 'palette';

/* ------------------------------------------------------------------ */
/*  Icon registry                                                      */
/* ------------------------------------------------------------------ */

const ICONS: Record<string, React.FC<{ className?: string }>> = {
  Gauge, Hash, Activity, ToggleLeft, SlidersHorizontal, Keyboard,
  CircleDot, OctagonAlert: AlertOctagon, TrendingUp, Bell, List, Wrench, History,
  CheckCircle, LayoutDashboard, Droplets, Link2, Type,
  GitCommitHorizontal, Square, Circle, Minus, FileImage, Calendar,
  Video, MapPinned, Ellipsis: MoreHorizontal, Spline, Image, Hexagon, Triangle,
  Diamond, ArrowRight, Zap,
  Disc3, ChevronDownSquare, BarChart3, PieChart, Table2, Globe,
};

function icon(key: string, cls = 'w-4 h-4'): React.ReactNode {
  const I = ICONS[key] ?? Square;
  return <I className={cls} />;
}

/* ------------------------------------------------------------------ */
/*  localStorage helpers                                               */
/* ------------------------------------------------------------------ */

const TID = 'default';
const LS_RECENT = `scada-palette-recent-${TID}`;
const LS_FAV = `scada-palette-favorites-${TID}`;
const LS_CAT = `scada-palette-categories-${TID}`;

function lsRead<T>(key: string, fb: T): T {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) as T : fb; }
  catch { return fb; }
}
function lsWrite(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* noop */ }
}

/* ------------------------------------------------------------------ */
/*  Fuzzy match                                                        */
/* ------------------------------------------------------------------ */

function fuzzy(q: string, t: string): boolean {
  const ql = q.toLowerCase(), tl = t.toLowerCase();
  if (tl.includes(ql)) return true;
  let qi = 0;
  for (let i = 0; i < tl.length && qi < ql.length; i++) {
    if (tl[i] === ql[qi]) qi++;
  }
  return qi === ql.length;
}

/* ------------------------------------------------------------------ */
/*  Drag helper (mirrors WidgetPalette logic)                          */
/* ------------------------------------------------------------------ */

function startDrag(e: React.DragEvent, w: PaletteWidgetDef): void {
  const sub = w.defaultConfig?.equipmentSubType as string | undefined;
  const sd = sub
    ? EQUIPMENT_SUBTYPE_SIZES[sub as EquipmentSubType] ?? WIDGET_SIZES[w.type]
    : WIDGET_SIZES[w.type];
  e.dataTransfer.setData('application/reactflow-widget', JSON.stringify({
    widgetType: w.type, label: w.label,
    defaultWidth: sd ? sd.defaultW * GRID_CELL_W : 240,
    defaultHeight: sd ? sd.defaultH * GRID_CELL_H : 200,
    defaultConfig: { label: w.label, ...w.defaultConfig },
  }));
  e.dataTransfer.effectAllowed = 'copy';
}

/* ------------------------------------------------------------------ */
/*  WidgetCard                                                         */
/* ------------------------------------------------------------------ */

const WidgetCard: React.FC<{
  w: PaletteWidgetDef;
  isFav: boolean;
  onDrag: (e: React.DragEvent, w: PaletteWidgetDef) => void;
  onCtx: (e: React.MouseEvent, w: PaletteWidgetDef) => void;
  /** Keyboard path: Enter/Space places the widget on the active screen (drag is the pointer enhancement). */
  onAdd: (w: PaletteWidgetDef) => void;
}> = ({ w, isFav, onDrag, onCtx, onAdd }) => {
  const sub = w.defaultConfig?.equipmentSubType as string | undefined;
  const sd = sub ? EQUIPMENT_SUBTYPE_SIZES[sub as EquipmentSubType] : WIDGET_SIZES[w.type];
  const pw = sd ? sd.defaultW * GRID_CELL_W : 0;
  const ph = sd ? sd.defaultH * GRID_CELL_H : 0;
  return (
    <Button variant="secondary" size="sm" type="button" draggable onDragStart={(e) => onDrag(e, w)} onContextMenu={(e) => onCtx(e, w)} onClick={() => onAdd(w)} title="Add to the active screen; drag to place"><GripVertical className="w-3 h-3 text-gray-500 dark:text-gray-400 group-hover:text-cyan-400 flex-shrink-0" />
      <span className="text-gray-600 dark:text-gray-400 flex-shrink-0">{icon(w.iconKey)}</span>
      <span className="text-xs text-gray-700 dark:text-gray-300 truncate flex-1">{w.label}</span>
      {isFav && <Star className="w-3 h-3 text-amber-400 fill-amber-400 flex-shrink-0" />}
      {pw > 0 && <span className="text-[9px] text-gray-500 dark:text-gray-400 flex-shrink-0">{pw}x{ph}</span>}</Button>
  );
};

/* ------------------------------------------------------------------ */
/*  UnifiedLeftPanel                                                   */
/* ------------------------------------------------------------------ */

export const UnifiedLeftPanel: React.FC<UnifiedLeftPanelProps> = ({
  collapsed = false,
  onToggleCollapse,
}) => {
  const [tab, setTab] = useState<TabId>('scene');
  const [query, setQuery] = useState('');
  const [dq, setDq] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // FUXA Widget Browser modal state
  const [fuxaBrowserOpen, setFuxaBrowserOpen] = useState(false);

  // Store actions for adding FUXA widgets to the canvas
  const addWidget = useScadaPackageStore((s) => s.addWidget);
  const activeScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const setSelectedWidget = useScadaPackageStore((s) => s.setSelectedWidget);

  /**
   * Handle FUXA widget selection from the browser.
   * Creates a new fuxaWidget on the active screen with the catalog entry's
   * ID stored in config.catalogId for later SVG content loading.
   */
  const handleFuxaWidgetSelect = useCallback(
    (entry: FuxaWidgetCatalogEntry) => {
      const widgetId = `fuxa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      addWidget(activeScreenId, {
        id: widgetId,
        widgetType: 'fuxaWidget',
        position: { col: 2, row: 2, w: 2, h: 2 },
        config: {
          label: entry.name,
          catalogId: entry.id,
          category: entry.subcategory
            ? `${entry.category} > ${entry.subcategory}`
            : entry.category,
        },
      });
      setSelectedWidget(widgetId);
    },
    [addWidget, activeScreenId, setSelectedWidget],
  );

  // Layers resize
  const [layH, setLayH] = useState(200);
  const [resizing, setResizing] = useState(false);
  const rRef = useRef({ y: 0, h: 0 });
  const [layColl, setLayColl] = useState(false);

  // Recent / favorites / categories
  const [recent, setRecent] = useState<string[]>(() => lsRead<string[]>(LS_RECENT, []));
  const [favs, setFavs] = useState<Set<string>>(() => new Set(lsRead<string[]>(LS_FAV, [])));
  const [expCat, setExpCat] = useState<Set<string>>(() => {
    const s = lsRead<string[] | null>(LS_CAT, null);
    return s ? new Set(s) : new Set(DEFAULT_EXPANDED_CATEGORIES);
  });

  // Debounce search
  useEffect(() => { const t = setTimeout(() => setDq(query), 150); return () => clearTimeout(t); }, [query]);

  // "/" shortcut
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === '/' && tab === 'palette' && !collapsed
        && document.activeElement?.tagName !== 'INPUT'
        && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault(); searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tab, collapsed]);

  // Persist categories
  useEffect(() => { lsWrite(LS_CAT, Array.from(expCat)); }, [expCat]);

  const toggleCat = useCallback((n: string) => {
    setExpCat((p) => {
      const x = new Set(p);
      if (x.has(n)) {
        x.delete(n);
      } else {
        x.add(n);
      }
      return x;
    });
  }, []);

  const toggleFav = useCallback((k: string) => {
    setFavs((p) => {
      const x = new Set(p);
      if (x.has(k)) {
        x.delete(k);
      } else {
        x.add(k);
      }
      lsWrite(LS_FAV, Array.from(x)); return x;
    });
  }, []);

  const trackDrop = useCallback((k: string) => {
    setRecent((p) => { const n = [k, ...p.filter((x) => x !== k)].slice(0, 8); lsWrite(LS_RECENT, n); return n; });
  }, []);

  // Flat widget index
  const allW = useMemo(() => {
    const r: Array<{ w: PaletteWidgetDef; cat: string }> = [];
    for (const c of PALETTE_CATEGORIES) for (const w of c.widgets) r.push({ w, cat: c.name });
    return r;
  }, []);

  // Filtered
  const filtered = useMemo(() => {
    if (!dq.trim()) return null;
    return allW.filter(({ w, cat }) => {
      const sub = w.defaultConfig?.equipmentSubType as string | undefined;
      return fuzzy(dq, w.label) || fuzzy(dq, cat) || fuzzy(dq, w.type) || (sub ? fuzzy(dq, sub) : false);
    });
  }, [dq, allW]);

  const recentW = useMemo(() => {
    if (dq.trim()) return [];
    const m = new Map(allW.map((x) => [paletteWidgetKey(x.w), x]));
    return recent.map((k) => m.get(k)).filter(Boolean) as typeof allW;
  }, [dq, recent, allW]);

  const favW = useMemo(() => {
    if (dq.trim()) return [];
    return allW.filter(({ w }) => favs.has(paletteWidgetKey(w)));
  }, [dq, favs, allW]);

  // Drag & context handlers
  const onDrag = useCallback((e: React.DragEvent, w: PaletteWidgetDef) => {
    startDrag(e, w); trackDrop(paletteWidgetKey(w));
  }, [trackDrop]);

  const onCtx = useCallback((e: React.MouseEvent, w: PaletteWidgetDef) => {
    e.preventDefault(); toggleFav(paletteWidgetKey(w));
  }, [toggleFav]);

  // Keyboard path to placement: the same widget a drop would create, at a default position.
  const onAdd = useCallback((w: PaletteWidgetDef) => {
    if (!activeScreenId) return;
    const sub = w.defaultConfig?.equipmentSubType as string | undefined;
    const sd = (sub ? EQUIPMENT_SUBTYPE_SIZES[sub as EquipmentSubType] : undefined) ?? WIDGET_SIZES[w.type];
    const id = `w-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    addWidget(activeScreenId, {
      id,
      widgetType: w.type,
      position: { col: 2, row: 2, w: sd?.defaultW ?? 4, h: sd?.defaultH ?? 3 },
      config: { label: w.label, ...w.defaultConfig },
    });
    setSelectedWidget(id);
    trackDrop(paletteWidgetKey(w));
  }, [activeScreenId, addWidget, setSelectedWidget, trackDrop]);

  // Layers resize
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); setResizing(true);
    rRef.current = { y: e.clientY, h: layH };
    const move = (ev: MouseEvent): void => {
      setLayH(Math.min(400, Math.max(120, rRef.current.h + rRef.current.y - ev.clientY)));
    };
    const up = (): void => { setResizing(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [layH]);

  /* ---- Collapsed state ---- */
  if (collapsed) {
    return (
      <div className="w-10 flex flex-col items-center py-2 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700">
        <Button variant="ghost" size="sm" iconOnly aria-label="Expand panel" onClick={onToggleCollapse} title="Expand panel"><ChevronRight className="w-4 h-4" /></Button>
      </div>
    );
  }

  /* ---- Render palette content ---- */
  const renderPalette = (): React.ReactNode => {
    // Search results
    if (filtered) {
      if (filtered.length === 0) return <div className="py-8 text-center text-xs text-gray-500 dark:text-gray-400">No widgets match &ldquo;{dq}&rdquo;</div>;
      const byCat = new Map<string, PaletteWidgetDef[]>();
      for (const { w, cat } of filtered) {
        const widgets = byCat.get(cat) ?? [];
        widgets.push(w);
        byCat.set(cat, widgets);
      }
      return (
        <div className="py-1 px-1 space-y-1">
          {Array.from(byCat.entries()).map(([cat, ws]) => (
            <div key={cat}>
              <div className="px-2 py-1 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{cat} ({ws.length})</div>
              <div className="space-y-1 px-1">{ws.map((w) => <WidgetCard key={paletteWidgetKey(w)} w={w} isFav={favs.has(paletteWidgetKey(w))} onDrag={onDrag} onCtx={onCtx} onAdd={onAdd} />)}</div>
            </div>
          ))}
        </div>
      );
    }

    // Normal mode
    return (
      <div>
        {/* Recently Used */}
        {recentW.length > 0 && (
          <div className="border-b border-gray-100 dark:border-gray-700 pb-1">
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider"><Clock className="w-3 h-3" />Recent</div>
            <div className="flex gap-1.5 px-2 pb-1.5 overflow-x-auto">
              {recentW.map(({ w }) => (
                <button type="button" key={paletteWidgetKey(w)} draggable onDragStart={(e) => onDrag(e, w)} onContextMenu={(e) => onCtx(e, w)} onClick={() => onAdd(w)}
                  className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:border-cyan-400 hover:bg-cyan-50 cursor-grab text-xs text-gray-600 dark:text-gray-400 transition-colors" title={w.label}>
                  {icon(w.iconKey, 'w-3 h-3')}<span className="max-w-[60px] truncate text-[10px]">{w.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Favorites */}
        {favW.length > 0 && (
          <div className="border-b border-gray-100 dark:border-gray-700 pb-1">
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider"><Star className="w-3 h-3 text-amber-400" />Favorites</div>
            <div className="py-1 px-2 space-y-1">{favW.map(({ w }) => <WidgetCard key={paletteWidgetKey(w)} w={w} isFav onDrag={onDrag} onCtx={onCtx} onAdd={onAdd} />)}</div>
          </div>
        )}

        {/* Categories */}
        {PALETTE_CATEGORIES.map((cat) => (
          <div key={cat.name}>
            <Button variant="secondary" size="sm" onClick={() => toggleCat(cat.name)}><span>{cat.name} <span className="text-[11px] font-normal text-gray-500 dark:text-gray-400">({cat.widgets.length})</span></span>
              {expCat.has(cat.name) ? <ChevronDown className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />}</Button>
            {expCat.has(cat.name) && (
              <div className="py-1 px-2 space-y-1">{cat.widgets.map((w) => <WidgetCard key={paletteWidgetKey(w)} w={w} isFav={favs.has(paletteWidgetKey(w))} onDrag={onDrag} onCtx={onCtx} onAdd={onAdd} />)}</div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="w-60 flex flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 select-none">
      {/* Tab toggle */}
      <div className="px-2 pt-2 pb-1.5">
        <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          <button onClick={() => setTab('scene')}
            className={`flex-1 flex items-center justify-center gap-1.5 h-9 text-sm font-medium rounded-md transition-colors ${tab === 'scene' ? 'bg-white dark:bg-gray-900 shadow-sm text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'}`}>
            <FolderTree className="w-3.5 h-3.5" />Scene
          </button>
          <button onClick={() => setTab('palette')}
            className={`flex-1 flex items-center justify-center gap-1.5 h-9 text-sm font-medium rounded-md transition-colors ${tab === 'palette' ? 'bg-white dark:bg-gray-900 shadow-sm text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'}`}>
            <Palette className="w-3.5 h-3.5" />Palette
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {tab === 'scene' ? (
          <div className="flex-1 overflow-hidden"><SceneTreePanel /></div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            {/* Search bar */}
            <div className="px-2 pb-1.5 flex-shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-gray-500 pointer-events-none" />
                <Input fullWidth ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search widgets..." />
                {query && (
                  <Button variant="ghost" iconOnly aria-label="Close" className="absolute right-2 top-1/2" onClick={() => setQuery('')}><X className="w-3.5 h-3.5" /></Button>
                )}
              </div>
            </div>
            {/* FUXA Community Library button */}
            <div className="px-2 pb-1.5 flex-shrink-0">
              <button
                onClick={() => setFuxaBrowserOpen(true)}
                className="w-full flex items-center justify-center gap-1.5 h-8 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100 hover:border-emerald-300 transition-colors"
                data-testid="fuxa-library-btn"
              >
                <Package className="w-3.5 h-3.5" />
                FUXA Community Library
              </button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">{renderPalette()}</div>
          </div>
        )}
      </div>

      {/* Layers — always visible, collapsible, resizable */}
      <div className="flex-shrink-0">
        {!layColl && (
          <button
            type="button"
            aria-label="Resize layers panel"
            onMouseDown={onResizeStart}
            className={`h-1.5 cursor-row-resize flex items-center justify-center border-t border-gray-200 dark:border-gray-700 hover:bg-cyan-50 transition-colors ${resizing ? 'bg-cyan-100' : ''}`}>
            <GripHorizontal className="w-4 h-4 text-gray-300" />
          </button>
        )}
        <Button variant="secondary" size="xs" onClick={() => setLayColl((p) => !p)}>{layColl ? <ChevronRight className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />}
          LAYERS</Button>
        {!layColl && (
          <div style={{ height: layH, minHeight: 120, maxHeight: 400 }} className="overflow-hidden">
            <LayersPanel />
          </div>
        )}
      </div>

      {/* FUXA Widget Browser modal -- rendered via portal-style at root level */}
      <FuxaWidgetBrowser
        open={fuxaBrowserOpen}
        onClose={() => setFuxaBrowserOpen(false)}
        onSelect={handleFuxaWidgetSelect}
      />
    </div>
  );
};

export default UnifiedLeftPanel;
