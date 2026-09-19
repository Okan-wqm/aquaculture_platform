import React from 'react';
import {
  VfdBrandInfo,
  VfdBrand,
  VFD_BRAND_NAMES,
  VFD_BRAND_DESCRIPTIONS,
  VFD_MODEL_SERIES,
} from '../../../types/vfd.types';
import { useVfdBrands } from '../../../hooks/useVfdBrands';
import { colors } from '@aquaculture/shared-ui';
import { CircleCheck, Code, Star } from 'lucide-react';

interface VfdBrandSelectionStepProps {
  selectedBrand?: VfdBrandInfo;
  onSelect: (brand: VfdBrandInfo) => void;
}

// Brand logos/icons (using text placeholders - can be replaced with actual logos)
const BRAND_LOGOS: Record<VfdBrand, { color: string; bgColor: string }> = {
  [VfdBrand.DANFOSS]: { color: colors.error[600], bgColor: colors.error[100] },
  [VfdBrand.ABB]: { color: colors.error[600], bgColor: colors.error[100] },
  [VfdBrand.SIEMENS]: { color: colors.success[500], bgColor: colors.success[100] },
  [VfdBrand.SCHNEIDER]: { color: colors.success[500], bgColor: colors.success[100] },
  [VfdBrand.YASKAWA]: { color: colors.primary[600], bgColor: colors.info[100] },
  [VfdBrand.DELTA]: { color: colors.primary[700], bgColor: colors.info[100] },
  [VfdBrand.MITSUBISHI]: { color: colors.error[600], bgColor: colors.error[100] },
  [VfdBrand.ROCKWELL]: { color: colors.error[700], bgColor: colors.error[100] },
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
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
          VFD Markası Seçin
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Frekans konvertörünüzün markasını seçin. Marka seçimi, register mapping ve varsayılan
          ayarları otomatik olarak yapılandıracaktır.
        </p>
      </div>

      {/* Popular brands */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center">
          <Star className="w-4 h-4 mr-1 text-warning-500" aria-hidden="true" />
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
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          Diğer Markalar
        </h4>
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
        <div className="mt-6 p-4 bg-info-50 dark:bg-info-900/20 rounded-lg border border-info-200 dark:border-info-800">
          <div className="flex items-start">
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-lg mr-4"
              style={{
                backgroundColor: BRAND_LOGOS[selectedBrand.code]?.color || colors.primary[500],
              }}
            >
              {selectedBrand.name.substring(0, 2).toUpperCase()}
            </div>
            <div className="flex-1">
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                {selectedBrand.name}
              </h4>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {selectedBrand.description}
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <div className="text-xs bg-white dark:bg-gray-900 px-2 py-1 rounded border border-info-200">
                  <span className="text-gray-500 dark:text-gray-400">Protokoller:</span>{' '}
                  <span className="font-medium">{selectedBrand.supportedProtocols.length}</span>
                </div>
                <div className="text-xs bg-white dark:bg-gray-900 px-2 py-1 rounded border border-info-200">
                  <span className="text-gray-500 dark:text-gray-400">Model Serisi:</span>{' '}
                  <span className="font-medium">{selectedBrand.modelSeries.length}</span>
                </div>
              </div>

              {/* Model series preview */}
              <div className="mt-3">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  Desteklenen Model Serileri:
                </p>
                <div className="flex flex-wrap gap-1">
                  {selectedBrand.modelSeries.slice(0, 5).map((model) => (
                    <span
                      key={model.code}
                      className="text-xs bg-white dark:bg-gray-900 px-2 py-0.5 rounded border border-gray-200 dark:border-gray-700"
                    >
                      {model.code}
                    </span>
                  ))}
                  {selectedBrand.modelSeries.length > 5 && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
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
  const { color, bgColor } = BRAND_LOGOS[brand.code] || {
    color: colors.primary[500],
    bgColor: colors.info[100],
  };

  return (
    <button
      onClick={() => onSelect(brand)}
      className={`relative p-4 rounded-lg border-2 transition-all text-left hover:shadow-md ${
        isSelected
          ? 'border-info-500 bg-info-50 dark:bg-info-900/20 shadow-md'
          : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-500'
      }`}
    >
      {isPopular && (
        <span className="absolute -top-2 -right-2 bg-warning-400 text-warning-900 dark:text-warning-100 text-xs px-1.5 py-0.5 rounded-full font-medium">
          Popüler
        </span>
      )}

      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold mb-3"
        style={{ backgroundColor: color }}
      >
        {brand.name.substring(0, 2).toUpperCase()}
      </div>

      <h4 className="font-medium text-gray-900 dark:text-gray-100 text-sm">{brand.name}</h4>

      <div className="mt-2 flex items-center text-xs text-gray-500 dark:text-gray-400">
        <Code className="w-3 h-3 mr-1" aria-hidden="true" />
        {brand.supportedProtocols.length} protokol
      </div>

      {isSelected && (
        <div className="absolute top-2 right-2">
          <CircleCheck className="w-5 h-5 text-info-500" aria-hidden="true" />
        </div>
      )}
    </button>
  );
}

export default VfdBrandSelectionStep;
