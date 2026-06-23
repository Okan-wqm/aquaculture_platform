/**
 * AOIAnalysisPanel Component
 *
 * Shows analysis for the selected Area of Interest (AOI).
 * Displays high-resolution satellite imagery and statistics.
 *
 * Features:
 * - High-res image preview (1024x1024)
 * - Layer-specific statistics
 * - Export to PNG
 * - Date selection
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { format } from 'date-fns';
import { tr } from 'date-fns/locale';
import type { AOI } from '../../hooks/useAOIDrawing';
import type { LayerType } from '../../services/sentinelHubService';
import { fetchMarineAoiImage, toMarineLayerId } from '../../services/marineDataService';

interface AOIAnalysisPanelProps {
  aoi: AOI;
  layer: LayerType;
  date: Date;
  onClose: () => void;
  onDateChange: (date: Date) => void;
}

interface AnalysisResult {
  imageUrl: string | null;
  isLoading: boolean;
  error: string | null;
  stats?: {
    min: number;
    max: number;
    mean: number;
    coverage: number; // % valid pixels
  };
}

// Layer display names
const LAYER_NAMES: Record<LayerType, string> = {
  'TRUE-COLOR': 'Gercek Renk',
  'CHLOROPHYLL': 'Klorofil-a',
  'CYANOBACTERIA': 'Siyanobakteri',
  'TURBIDITY': 'Bulaniklik',
  'CDOM': 'Cozunmus Organik Madde',
  'TSS': 'Askida Kati Madde',
  'NDVI': 'Bitki Indeksi',
  'MOISTURE': 'Nem Indeksi',
  'NDWI': 'Su Indeksi',
  'SECCHI': 'Secchi Derinligi',
};

export const AOIAnalysisPanel: React.FC<AOIAnalysisPanelProps> = ({
  aoi,
  layer,
  date,
  onClose,
  onDateChange,
}) => {
  const [result, setResult] = useState<AnalysisResult>({
    imageUrl: null,
    isLoading: false,
    error: null,
  });
  const imageUrlRef = useRef<string | null>(null);

  // Fetch high-res image for AOI
  const fetchAnalysis = useCallback(async () => {
    const marineLayerId = toMarineLayerId(layer);
    if (!marineLayerId) {
      setResult({
        imageUrl: null,
        isLoading: false,
        error: 'Bu katman AOI analizi icin desteklenmiyor',
      });
      return;
    }

    setResult((prev) => ({ ...prev, isLoading: true, error: null }));

    // Clean up previous image URL
    if (imageUrlRef.current) {
      URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = null;
    }

    const fromDate = new Date(date);
    fromDate.setDate(fromDate.getDate() - 30);

    try {
      const blob = await fetchMarineAoiImage({
        layerId: marineLayerId,
        bbox: aoi.bbox,
        fromDate,
        toDate: date,
        width: 1024,
        height: 1024,
      });
      const url = URL.createObjectURL(blob);
      imageUrlRef.current = url;

      setResult({
        imageUrl: url,
        isLoading: false,
        error: null,
      });
    } catch {
      setResult({
        imageUrl: null,
        isLoading: false,
        error: 'Goruntu alinamadi',
      });
    }
  }, [aoi.bbox, date, layer]);

  // Fetch on mount and when dependencies change
  useEffect(() => {
    fetchAnalysis();

    return () => {
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
      }
    };
  }, [fetchAnalysis]);

  // Handle export
  const handleExport = () => {
    if (!result.imageUrl) return;

    const link = document.createElement('a');
    link.href = result.imageUrl;
    link.download = `${aoi.name}_${layer}_${format(date, 'yyyy-MM-dd')}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="absolute bottom-4 right-4 z-[1000] w-96 bg-white rounded-lg shadow-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b bg-gray-50">
        <div className="flex items-center gap-2">
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: aoi.color }}
          />
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{aoi.name}</h3>
            <p className="text-xs text-gray-500">{LAYER_NAMES[layer]}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Image Preview */}
      <div className="relative aspect-square bg-gray-100">
        {result.isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <svg className="w-8 h-8 animate-spin text-primary-600 mx-auto" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <p className="mt-2 text-sm text-gray-500">Yuksek cozunurluk yukleniyor...</p>
            </div>
          </div>
        )}

        {result.error && !result.isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-red-500">
              <svg className="w-8 h-8 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="mt-2 text-sm">{result.error}</p>
              <button
                onClick={fetchAnalysis}
                className="mt-2 text-xs text-primary-600 hover:underline"
              >
                Tekrar Dene
              </button>
            </div>
          </div>
        )}

        {result.imageUrl && !result.isLoading && (
          <img
            src={result.imageUrl}
            alt={`${aoi.name} - ${layer}`}
            className="w-full h-full object-cover"
          />
        )}
      </div>

      {/* Info & Actions */}
      <div className="p-3 space-y-3">
        {/* AOI Info */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-gray-50 rounded p-2">
            <span className="text-gray-500">Alan</span>
            <p className="font-medium text-gray-900">
              {aoi.area < 1
                ? `${(aoi.area * 1000).toFixed(0)} m²`
                : `${aoi.area.toFixed(2)} km²`}
            </p>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <span className="text-gray-500">Tarih</span>
            <p className="font-medium text-gray-900">
              {format(date, 'd MMM yyyy', { locale: tr })}
            </p>
          </div>
        </div>

        {/* Date picker */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Tarih Sec</label>
          <input
            type="date"
            value={format(date, 'yyyy-MM-dd')}
            onChange={(e) => onDateChange(new Date(e.target.value))}
            max={format(new Date(), 'yyyy-MM-dd')}
            className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-hidden focus:ring-1 focus:ring-primary-500"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            disabled={!result.imageUrl || result.isLoading}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            PNG Indir
          </button>
          <button
            onClick={fetchAnalysis}
            disabled={result.isLoading}
            className="px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors"
            title="Yenile"
          >
            <svg className={`w-4 h-4 ${result.isLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export default AOIAnalysisPanel;
