import React from 'react';
import {
  VfdBrandInfo,
  VfdBrand,
  VFD_BRAND_NAMES,
  VFD_BRAND_DESCRIPTIONS,
  VFD_MODEL_SERIES,
} from '../../../types/vfd.types';
import { useVfdBrands } from '../../../hooks/useVfdBrands';

interface VfdBrandSelectionStepProps {
  selectedBrand?: VfdBrandInfo;
  onSelect: (brand: VfdBrandInfo) => void;
}

// Brand logos/icons (using text placeholders - can be replaced with actual logos)
const BRAND_LOGOS: Record<VfdBrand, { color: string; bgColor: string }> = {
  [VfdBrand.DANFOSS]: { color: '#E30613', bgColor: '#FEE2E2' },
  [VfdBrand.ABB]: { color: '#FF000F', bgColor: '#FEE2E2' },
  [VfdBrand.SIEMENS]: { color: '#009999', bgColor: '#D1FAE5' },
  [VfdBrand.SCHNEIDER]: { color: '#3DCD58', bgColor: '#D1FAE5' },
  [VfdBrand.YASKAWA]: { color: '#0066B3', bgColor: '#DBEAFE' },
  [VfdBrand.DELTA]: { color: '#003399', bgColor: '#DBEAFE' },
  [VfdBrand.MITSUBISHI]: { color: '#E60012', bgColor: '#FEE2E2' },
  [VfdBrand.ROCKWELL]: { color: '#C8102E', bgColor: '#FEE2E2' },
};

// Popular brands to highlight
const POPULAR_BRANDS: VfdBrand[] = [
  VfdBrand.DANFOSS,
  VfdBrand.ABB,
  VfdBrand.SIEMENS,
  VfdBrand.SCHNEIDER,
];

export function VfdBrandSelectionStep({ selectedBrand, onSelect }: VfdBrandSelectionStepProps) {
  const { brands } = useVfdBrands();

  const popularBrands = brands.filter((b) => POPULAR_BRANDS.includes(b.code));
  const otherBrands = brands.filter((b) => !POPULAR_BRANDS.includes(b.code));

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">VFD Markası Seçin</h3>
        <p className="text-sm text-gray-500">
          Frekans konvertörünüzün markasını seçin. Marka seçimi, register mapping ve
          varsayılan ayarları otomatik olarak yapılandıracaktır.
        </p>
      </div>

      {/* Popular brands */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center">
          <svg className="w-4 h-4 mr-1 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
          Popüler Markalar
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {popularBrands.map((brand) => (
            <BrandCard
              key={brand.code}
              brand={brand}
              isSelected={selectedBrand?.code === brand.code}
              onSelect={onSelect}
              isPopular
            />
          ))}
        </div>
      </div>

      {/* Other brands */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-3">Diğer Markalar</h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {otherBrands.map((brand) => (
            <BrandCard
              key={brand.code}
              brand={brand}
              isSelected={selectedBrand?.code === brand.code}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>

      {/* Selected brand info */}
      {selectedBrand && (
        <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex items-start">
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-lg mr-4"
              style={{ backgroundColor: BRAND_LOGOS[selectedBrand.code]?.color || '#6366F1' }}
            >
              {selectedBrand.name.substring(0, 2).toUpperCase()}
            </div>
            <div className="flex-1">
              <h4 className="font-semibold text-gray-900">{selectedBrand.name}</h4>
              <p className="text-sm text-gray-600 mt-1">{selectedBrand.description}</p>

              <div className="mt-3 flex flex-wrap gap-2">
                <div className="text-xs bg-white px-2 py-1 rounded border border-blue-200">
                  <span className="text-gray-500">Protokoller:</span>{' '}
                  <span className="font-medium">{selectedBrand.supportedProtocols.length}</span>
                </div>
                <div className="text-xs bg-white px-2 py-1 rounded border border-blue-200">
                  <span className="text-gray-500">Model Serisi:</span>{' '}
                  <span className="font-medium">{selectedBrand.modelSeries.length}</span>
                </div>
              </div>

              {/* Model series preview */}
              <div className="mt-3">
                <p className="text-xs text-gray-500 mb-1">Desteklenen Model Serileri:</p>
                <div className="flex flex-wrap gap-1">
                  {selectedBrand.modelSeries.slice(0, 5).map((model) => (
                    <span
                      key={model.code}
                      className="text-xs bg-white px-2 py-0.5 rounded border border-gray-200"
                    >
                      {model.code}
                    </span>
                  ))}
                  {selectedBrand.modelSeries.length > 5 && (
                    <span className="text-xs text-gray-400">
                      +{selectedBrand.modelSeries.length - 5} daha
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface BrandCardProps {
  brand: VfdBrandInfo;
  isSelected: boolean;
  isPopular?: boolean;
  onSelect: (brand: VfdBrandInfo) => void;
}

function BrandCard({ brand, isSelected, isPopular, onSelect }: BrandCardProps) {
  const { color, bgColor } = BRAND_LOGOS[brand.code] || { color: '#6366F1', bgColor: '#E0E7FF' };

  return (
    <button
      onClick={() => onSelect(brand)}
      className={`relative p-4 rounded-lg border-2 transition-all text-left hover:shadow-md ${
        isSelected
          ? 'border-blue-500 bg-blue-50 shadow-md'
          : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      {isPopular && (
        <span className="absolute -top-2 -right-2 bg-yellow-400 text-yellow-900 text-xs px-1.5 py-0.5 rounded-full font-medium">
          Popüler
        </span>
      )}

      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold mb-3"
        style={{ backgroundColor: color }}
      >
        {brand.name.substring(0, 2).toUpperCase()}
      </div>

      <h4 className="font-medium text-gray-900 text-sm">{brand.name}</h4>

      <div className="mt-2 flex items-center text-xs text-gray-500">
        <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
        {brand.supportedProtocols.length} protokol
      </div>

      {isSelected && (
        <div className="absolute top-2 right-2">
          <svg className="w-5 h-5 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
        </div>
      )}
    </button>
  );
}

export default VfdBrandSelectionStep;
