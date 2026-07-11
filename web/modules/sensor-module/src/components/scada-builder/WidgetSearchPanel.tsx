import React, { useState, useMemo, useCallback } from 'react';
import { Search, Box } from 'lucide-react';
import { useScadaPackageStore } from '../../store/scada';

export const WidgetSearchPanel: React.FC = () => {
  const screens = useScadaPackageStore((s) => s.screens);
  const activeScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const selectedWidgetId = useScadaPackageStore((s) => s.selectedWidgetId);
  const setActiveScreen = useScadaPackageStore((s) => s.setActiveScreen);
  const setSelectedWidget = useScadaPackageStore((s) => s.setSelectedWidget);
  const [searchText, setSearchText] = useState('');

  const results = useMemo(() => {
    const query = searchText.toLowerCase().trim();
    const items: Array<{
      widgetId: string;
      widgetType: string;
      label: string;
      tag: string;
      screenId: string;
      screenName: string;
    }> = [];

    for (const screen of screens) {
      for (const widget of screen.widgets) {
        const label = (widget.config?.label as string) || widget.widgetType;
        const tag = (widget.config?.tagName as string) || (widget.config?.tag as string) || '';

        if (
          !query ||
          widget.widgetType.toLowerCase().includes(query) ||
          label.toLowerCase().includes(query) ||
          tag.toLowerCase().includes(query) ||
          screen.name.toLowerCase().includes(query)
        ) {
          items.push({
            widgetId: widget.id,
            widgetType: widget.widgetType,
            label,
            tag,
            screenId: screen.id,
            screenName: screen.name,
          });
        }
      }
    }
    return items;
  }, [screens, searchText]);

  const totalWidgets = useMemo(
    () => screens.reduce((sum, s) => sum + s.widgets.length, 0),
    [screens],
  );

  const handleResultClick = useCallback(
    (screenId: string, widgetId: string) => {
      if (screenId !== activeScreenId) {
        setActiveScreen(screenId);
      }
      // Small delay to let screen transition happen
      setTimeout(() => setSelectedWidget(widgetId), 50);
    },
    [activeScreenId, setActiveScreen, setSelectedWidget],
  );

  return (
    <div className="w-64 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
        <input
          type="text"
          placeholder="Search widgets..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="w-full pl-8 pr-3 py-2 text-sm border-b border-gray-200 focus:outline-hidden focus:ring-1 focus:ring-cyan-500"
        />
      </div>

      {/* Results List */}
      <div className="max-h-64 overflow-y-auto">
        {results.length === 0 ? (
          <div className="px-3 py-4 text-xs text-gray-500 text-center">
            No matching widgets found
          </div>
        ) : (
          results.map((item) => {
            const isActive =
              item.screenId === activeScreenId &&
              item.widgetId === selectedWidgetId;

            return (
              <div
                key={`${item.screenId}-${item.widgetId}`}
                onClick={() => handleResultClick(item.screenId, item.widgetId)}
                className={`flex items-start gap-2 px-3 py-2 text-xs hover:bg-gray-50 cursor-pointer border-b border-gray-50 ${
                  isActive ? 'bg-cyan-50' : ''
                }`}
              >
                <Box className="w-3.5 h-3.5 text-gray-500 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1">
                    <span className="text-gray-500 font-mono text-[10px]">
                      {item.widgetType}
                    </span>
                    <span className="text-gray-900 font-medium truncate">
                      {item.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-gray-500">[{item.screenName}]</span>
                    {item.tag && (
                      <span className="text-cyan-600 font-mono text-[10px]">
                        tag:{item.tag}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Stats Footer */}
      <div className="px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-200">
        {totalWidgets} widget{totalWidgets !== 1 ? 's' : ''}, {screens.length} screen{screens.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
};
