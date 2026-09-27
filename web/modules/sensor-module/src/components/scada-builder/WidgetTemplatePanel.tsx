/**
 * WidgetTemplatePanel - Browse and apply saved widget templates/presets.
 *
 * Shows templates grouped by category. Clicking a template adds it to the
 * active screen at a default position. Also allows deleting templates.
 */

import React, { useMemo } from 'react';
import { Button } from '@aquaculture/shared-ui';
import { Bookmark, Trash2, Plus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useScadaPackageStore } from '../../store/scada';

export const WidgetTemplatePanel: React.FC = () => {
  const { widgetTemplates, activeScreenId, deleteTemplate, applyTemplate } =
    useScadaPackageStore(
      useShallow((s) => ({
        widgetTemplates: s.widgetTemplates,
        activeScreenId: s.activeScreenId,
        deleteTemplate: s.deleteTemplate,
        applyTemplate: s.applyTemplate,
      })),
    );

  const grouped = useMemo(() => {
    const map: Record<string, typeof widgetTemplates> = {};
    for (const t of widgetTemplates) {
      if (!map[t.category]) map[t.category] = [];
      map[t.category].push(t);
    }
    return map;
  }, [widgetTemplates]);

  const categories = Object.keys(grouped).sort();

  const handleApply = (templateId: string) => {
    if (!activeScreenId) return;
    // Place at a default position (center-ish)
    applyTemplate(activeScreenId, templateId, { col: 2, row: 2 });
  };

  if (widgetTemplates.length === 0) {
    return (
      <div className="w-64 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <Bookmark className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Templates</span>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 text-center py-4">
          No templates yet. Right-click a widget and select "Save as Template".
        </p>
      </div>
    );
  }

  return (
    <div className="w-64 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <Bookmark className="w-4 h-4 text-gray-500 dark:text-gray-400" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Templates</span>
        <span className="text-[10px] text-gray-500 dark:text-gray-400 ml-auto">{widgetTemplates.length}</span>
      </div>

      <div className="max-h-72 overflow-y-auto">
        {categories.map((cat) => (
          <div key={cat}>
            <div className="px-3 py-1.5 text-[10px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider bg-gray-50 dark:bg-gray-800">
              {cat}
            </div>
            {grouped[cat].map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 border-b border-gray-50 group"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-800 dark:text-gray-200 truncate">{t.name}</div>
                  <div className="text-[10px] text-gray-500 dark:text-gray-400">
                    {t.widgetType} · {t.defaultSize.w}x{t.defaultSize.h}
                  </div>
                </div>
                <Button variant="ghost" size="sm" iconOnly aria-label="Add" onClick={() => handleApply(t.id)} title="Add"><Plus className="w-3.5 h-3.5" /></Button>
                <Button variant="ghost" size="sm" iconOnly aria-label="Delete" onClick={() => deleteTemplate(t.id)} title="Delete"><Trash2 className="w-3.5 h-3.5" /></Button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
