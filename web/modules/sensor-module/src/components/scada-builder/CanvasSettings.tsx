import React, { useRef } from 'react';
import { Grid3X3, Magnet, ZoomIn, ZoomOut, Maximize2, Image, X } from 'lucide-react';

interface CanvasSettingsProps {
  snapEnabled: boolean;
  onSnapToggle: (enabled: boolean) => void;
  showGrid: boolean;
  onGridToggle: (show: boolean) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onFitView: () => void;
  backgroundImage?: string | null;
  backgroundOpacity?: number;
  onBackgroundImageChange?: (dataUrl: string | null) => void;
  onBackgroundOpacityChange?: (opacity: number) => void;
}

const Toggle: React.FC<{
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
  onToggle: (v: boolean) => void;
}> = ({ label, icon, enabled, onToggle }) => (
  <button
    onClick={() => onToggle(!enabled)}
    className={`flex items-center gap-1 px-2 py-1 rounded border text-xs transition-colors ${
      enabled
        ? 'bg-cyan-100 text-cyan-700 border-cyan-300'
        : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-150'
    }`}
    title={label}
  >
    {icon}
    <span>{enabled ? 'ON' : 'OFF'}</span>
  </button>
);

export const CanvasSettings: React.FC<CanvasSettingsProps> = ({
  snapEnabled,
  onSnapToggle,
  showGrid,
  onGridToggle,
  zoom,
  onZoomChange,
  onFitView,
  backgroundImage,
  backgroundOpacity,
  onBackgroundImageChange,
  onBackgroundOpacityChange,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onBackgroundImageChange) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onBackgroundImageChange(reader.result);
      }
    };
    reader.readAsDataURL(file);
    // Reset input so the same file can be re-selected
    e.target.value = '';
  };

  return (
    <div className="absolute bottom-14 right-3 z-20 flex items-center gap-1 bg-white/90 backdrop-blur-sm rounded-lg shadow-md border border-gray-200 px-2 py-1 text-xs">
      {/* Grid Snap Toggle */}
      <Toggle
        label="Grid Snap"
        icon={<Magnet className="w-3.5 h-3.5" />}
        enabled={snapEnabled}
        onToggle={onSnapToggle}
      />

      {/* Show Grid Toggle */}
      <Toggle
        label="Show Grid"
        icon={<Grid3X3 className="w-3.5 h-3.5" />}
        enabled={showGrid}
        onToggle={onGridToggle}
      />

      {/* Separator */}
      <div className="w-px h-5 bg-gray-200 mx-1" />

      {/* Zoom Controls */}
      <span className="text-gray-600 flex items-center gap-0.5">
        {/* Zoom Out */}
        <button
          onClick={() => onZoomChange(Math.max(0.2, zoom - 0.1))}
          className="w-6 h-6 rounded hover:bg-gray-100 flex items-center justify-center"
          title="Zoom Out"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>

        {/* Zoom Percentage (click to reset to 100%) */}
        <button
          onClick={() => onZoomChange(1)}
          className="w-12 text-center font-mono hover:bg-gray-100 rounded px-1 py-0.5"
          title="Reset Zoom"
        >
          {Math.round(zoom * 100)}%
        </button>

        {/* Zoom In */}
        <button
          onClick={() => onZoomChange(Math.min(2, zoom + 0.1))}
          className="w-6 h-6 rounded hover:bg-gray-100 flex items-center justify-center"
          title="Zoom In"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>

        {/* Fit View */}
        <button
          onClick={onFitView}
          className="w-6 h-6 rounded hover:bg-gray-100 flex items-center justify-center"
          title="Fit View"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </span>

      {/* Background Image Controls */}
      {onBackgroundImageChange && (
        <>
          <div className="w-px h-5 bg-gray-200 mx-1" />
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.jpg,.jpeg,.svg"
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className={`flex items-center gap-1 px-2 py-1 rounded border text-xs transition-colors ${
              backgroundImage
                ? 'bg-cyan-100 text-cyan-700 border-cyan-300'
                : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-150'
            }`}
            title="Background Image"
          >
            <Image className="w-3.5 h-3.5" />
            <span>BG</span>
          </button>

          {backgroundImage && (
            <>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.1}
                value={backgroundOpacity ?? 0.3}
                onChange={(e) => onBackgroundOpacityChange?.(Number(e.target.value))}
                className="w-16 h-4 accent-cyan-600"
                title={`Opacity: ${Math.round((backgroundOpacity ?? 0.3) * 100)}%`}
              />
              <button
                onClick={() => onBackgroundImageChange(null)}
                className="w-6 h-6 rounded hover:bg-red-100 flex items-center justify-center text-red-400 hover:text-red-600"
                title="Remove Background"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
};
