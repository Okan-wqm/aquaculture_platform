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

interface AOIAnalysisPanelProps {
  aoi: AOI;
  layer: LayerType;
  date: Date;
  token: string | null;
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

// CDSE Processing API URL
const CDSE_PROCESS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/process';

// Evalscript for high-res analysis
const getAnalysisEvalscript = (layer: LayerType): string => {
  const scripts: Record<LayerType, string> = {
    'TRUE-COLOR': `
      //VERSION=3
      function setup() {
        return { input: ["B04", "B03", "B02", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        return [2.5 * sample.B04, 2.5 * sample.B03, 2.5 * sample.B02, sample.dataMask];
      }
    `,
    'CHLOROPHYLL': `
      //VERSION=3
      function setup() {
        return { input: ["B02", "B03", "B04", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        let ratio = sample.B03 / Math.max(sample.B02, 0.001);
        let chl_a = 4.26 * Math.pow(ratio, 3.94);
        let r, g, b;
        if (chl_a < 5) { r = 0.1; g = 0.3; b = 0.8; }
        else if (chl_a < 10) { r = 0.2; g = 0.6; b = 0.8; }
        else if (chl_a < 20) { r = 0.3; g = 0.8; b = 0.3; }
        else if (chl_a < 50) { r = 0.8; g = 0.8; b = 0.2; }
        else if (chl_a < 100) { r = 0.9; g = 0.5; b = 0.1; }
        else { r = 0.9; g = 0.2; b = 0.2; }
        return [r, g, b, sample.dataMask];
      }
    `,
    'CYANOBACTERIA': `
      //VERSION=3
      function setup() {
        return { input: ["B02", "B03", "B04", "B05", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        let cya = 115530.31 * Math.pow((sample.B03 * sample.B04) / Math.max(sample.B02, 0.001), 2.38);
        let r, g, b;
        if (cya < 10000) { r = 0.1; g = 0.4; b = 0.8; }
        else if (cya < 50000) { r = 0.3; g = 0.7; b = 0.4; }
        else if (cya < 100000) { r = 0.9; g = 0.9; b = 0.2; }
        else if (cya < 500000) { r = 0.9; g = 0.5; b = 0.1; }
        else { r = 0.9; g = 0.1; b = 0.1; }
        return [r, g, b, sample.dataMask];
      }
    `,
    'TURBIDITY': `
      //VERSION=3
      function setup() {
        return { input: ["B01", "B03", "B04", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        let turb = 8.93 * (sample.B03 / Math.max(sample.B01, 0.001)) - 6.39;
        turb = Math.max(0, turb);
        let r, g, b;
        if (turb < 5) { r = 0.1; g = 0.5; b = 0.9; }
        else if (turb < 10) { r = 0.3; g = 0.7; b = 0.8; }
        else if (turb < 25) { r = 0.5; g = 0.8; b = 0.5; }
        else if (turb < 50) { r = 0.8; g = 0.7; b = 0.3; }
        else if (turb < 100) { r = 0.8; g = 0.5; b = 0.2; }
        else { r = 0.6; g = 0.4; b = 0.3; }
        return [r, g, b, sample.dataMask];
      }
    `,
    'CDOM': `
      //VERSION=3
      function setup() {
        return { input: ["B02", "B03", "B04", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        let cdom = (sample.B04 - sample.B02) / Math.max(sample.B03, 0.001);
        let r, g, b;
        if (cdom < 0.1) { r = 0.2; g = 0.6; b = 0.9; }
        else if (cdom < 0.3) { r = 0.4; g = 0.7; b = 0.6; }
        else if (cdom < 0.5) { r = 0.6; g = 0.6; b = 0.3; }
        else { r = 0.5; g = 0.3; b = 0.1; }
        return [r, g, b, sample.dataMask];
      }
    `,
    'TSS': `
      //VERSION=3
      function setup() {
        return { input: ["B02", "B03", "B04", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        let tss = 1.89 * Math.pow(sample.B04 / Math.max(sample.B02, 0.001), 1.17);
        let r, g, b;
        if (tss < 10) { r = 0.1; g = 0.4; b = 0.8; }
        else if (tss < 25) { r = 0.3; g = 0.6; b = 0.7; }
        else if (tss < 50) { r = 0.5; g = 0.7; b = 0.4; }
        else if (tss < 100) { r = 0.7; g = 0.6; b = 0.3; }
        else { r = 0.6; g = 0.4; b = 0.2; }
        return [r, g, b, sample.dataMask];
      }
    `,
    'NDVI': `
      //VERSION=3
      function setup() {
        return { input: ["B04", "B08", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        let ndvi = (sample.B08 - sample.B04) / Math.max(sample.B08 + sample.B04, 0.001);
        let r, g, b;
        if (ndvi < 0) { r = 0.5; g = 0; b = 0; }
        else if (ndvi < 0.2) { r = 0.8; g = 0.4; b = 0.2; }
        else if (ndvi < 0.4) { r = 1; g = 0.8; b = 0; }
        else if (ndvi < 0.6) { r = 0.6; g = 0.9; b = 0.2; }
        else { r = 0.1; g = 0.6; b = 0.1; }
        return [r, g, b, sample.dataMask];
      }
    `,
    'MOISTURE': `
      //VERSION=3
      function setup() {
        return { input: ["B8A", "B11", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        let ndmi = (sample.B8A - sample.B11) / Math.max(sample.B8A + sample.B11, 0.001);
        let r, g, b;
        if (ndmi < -0.4) { r = 0.8; g = 0.2; b = 0.2; }
        else if (ndmi < 0) { r = 0.9; g = 0.6; b = 0.3; }
        else if (ndmi < 0.2) { r = 1; g = 0.9; b = 0.5; }
        else if (ndmi < 0.4) { r = 0.5; g = 0.8; b = 0.5; }
        else { r = 0.2; g = 0.4; b = 0.8; }
        return [r, g, b, sample.dataMask];
      }
    `,
    'NDWI': `
      //VERSION=3
      function setup() {
        return { input: ["B03", "B08", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        let ndwi = (sample.B03 - sample.B08) / Math.max(sample.B03 + sample.B08, 0.001);
        let r, g, b;
        if (ndwi < -0.3) { r = 0.6; g = 0.4; b = 0.2; }
        else if (ndwi < 0) { r = 0.8; g = 0.7; b = 0.5; }
        else if (ndwi < 0.3) { r = 0.5; g = 0.7; b = 0.9; }
        else { r = 0.2; g = 0.4; b = 0.9; }
        return [r, g, b, sample.dataMask];
      }
    `,
    'SECCHI': `
      //VERSION=3
      function setup() {
        return { input: ["B02", "B03", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        let ratio = Math.log10(Math.max(sample.B03, 0.001) / Math.max(sample.B02, 0.001));
        let secchi = 4.5 + 8.0 * ratio;
        secchi = Math.max(0, Math.min(secchi, 30));
        let r, g, b;
        if (secchi < 3) { r = 0.5; g = 0.2; b = 0.1; }
        else if (secchi < 6) { r = 0.7; g = 0.4; b = 0.2; }
        else if (secchi < 12) { r = 0.5; g = 0.8; b = 0.9; }
        else { r = 0.2; g = 0.4; b = 0.9; }
        return [r, g, b, sample.dataMask];
      }
    `,
  };
  return scripts[layer] || scripts['TRUE-COLOR'];
};

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
  token,
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
    if (!token) {
      setResult({ imageUrl: null, isLoading: false, error: 'Token bulunamadi' });
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

    const requestBody = {
      input: {
        bounds: {
          bbox: aoi.bbox,
          properties: {
            crs: 'http://www.opengis.net/def/crs/EPSG/0/4326',
          },
        },
        data: [
          {
            type: 'sentinel-2-l2a',
            dataFilter: {
              timeRange: {
                from: fromDate.toISOString(),
                to: date.toISOString(),
              },
              maxCloudCoverage: 30,
              mosaickingOrder: 'leastCC',
            },
          },
        ],
      },
      output: {
        width: 1024,
        height: 1024,
        responses: [
          {
            identifier: 'default',
            format: {
              type: 'image/png',
            },
          },
        ],
      },
      evalscript: getAnalysisEvalscript(layer),
    };

    try {
      const response = await fetch(CDSE_PROCESS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      imageUrlRef.current = url;

      setResult({
        imageUrl: url,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      console.error('AOI analysis fetch error:', error);
      setResult({
        imageUrl: null,
        isLoading: false,
        error: 'Goruntu alinamadi',
      });
    }
  }, [aoi.bbox, date, layer, token]);

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
            className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500"
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
