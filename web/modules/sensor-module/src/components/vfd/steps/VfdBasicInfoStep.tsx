import React from 'react';
import { Input, Textarea } from '@aquaculture/shared-ui';
import { VfdBrandInfo, RegisterVfdInput } from '../../../types/vfd.types';
import { Info } from 'lucide-react';

interface VfdBasicInfoStepProps {
  brand: VfdBrandInfo;
  values: Partial<RegisterVfdInput>;
  selectedModelSeries?: string;
  onModelSeriesChange: (modelSeries: string | undefined) => void;
  onChange: (updates: Partial<RegisterVfdInput>) => void;
}

export function VfdBasicInfoStep({
  brand,
  values,
  selectedModelSeries,
  onModelSeriesChange,
  onChange,
}: VfdBasicInfoStepProps) {
  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target;
    onChange({ [name]: value || undefined });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
          Temel Bilgiler
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          VFD cihazınız için temel tanımlayıcı bilgileri girin.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Device Name */}
        <div className="md:col-span-2">
          <label
            htmlFor="name"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Cihaz Adı <span className="text-red-500">*</span>
          </label>
          <Input
            fullWidth
            type="text"
            id="name"
            name="name"
            value={values.name || ''}
            onChange={handleChange}
            placeholder="Örn: Ana Havuz Pompası VFD-1"
            required
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Cihazı kolayca tanımlayabileceğiniz benzersiz bir ad girin.
          </p>
        </div>

        {/* Model Series */}
        <div>
          <label
            htmlFor="modelSeries"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Model Serisi
          </label>
          <select
            id="modelSeries"
            name="modelSeries"
            value={selectedModelSeries || ''}
            onChange={(e) => onModelSeriesChange(e.target.value || undefined)}
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">Seçiniz...</option>
            {brand.modelSeries.map((model) => (
              <option key={model.code} value={model.code}>
                {model.code} - {model.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Model serisi seçimi, varsayılan register ayarlarını yapılandırır.
          </p>
        </div>

        {/* Model */}
        <div>
          <label
            htmlFor="model"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Model Numarası
          </label>
          <Input
            fullWidth
            type="text"
            id="model"
            name="model"
            value={values.model || ''}
            onChange={handleChange}
            placeholder="Örn: FC-302P15KT5"
          />
        </div>

        {/* Serial Number */}
        <div>
          <label
            htmlFor="serialNumber"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Seri Numarası
          </label>
          <Input
            fullWidth
            type="text"
            id="serialNumber"
            name="serialNumber"
            value={values.serialNumber || ''}
            onChange={handleChange}
            placeholder="Örn: SN123456789"
          />
        </div>

        {/* Location */}
        <div>
          <label
            htmlFor="location"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Konum
          </label>
          <Input
            fullWidth
            type="text"
            id="location"
            name="location"
            value={values.location || ''}
            onChange={handleChange}
            placeholder="Örn: Bina A, Kat 2, Panel 3"
          />
        </div>
      </div>

      {/* Assignment Section */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-4">
          Atama (Opsiyonel)
        </h4>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Farm ID */}
          <div>
            <label
              htmlFor="farmId"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Çiftlik
            </label>
            <select
              id="farmId"
              name="farmId"
              value={values.farmId || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">Seçiniz...</option>
              {/* Farm options would be loaded dynamically */}
            </select>
          </div>

          {/* Tank ID */}
          <div>
            <label
              htmlFor="tankId"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Tank/Havuz
            </label>
            <select
              id="tankId"
              name="tankId"
              value={values.tankId || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">Seçiniz...</option>
              {/* Tank options would be loaded dynamically */}
            </select>
          </div>

          {/* Pump ID */}
          <div>
            <label
              htmlFor="pumpId"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Pompa
            </label>
            <select
              id="pumpId"
              name="pumpId"
              value={values.pumpId || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">Seçiniz...</option>
              {/* Pump options would be loaded dynamically */}
            </select>
          </div>
        </div>
      </div>

      {/* Notes Section */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
        <label
          htmlFor="notes"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Notlar (Opsiyonel)
        </label>
        <Textarea
          fullWidth
          id="notes"
          name="notes"
          value={values.notes || ''}
          onChange={handleChange}
          rows={3}
          placeholder="Cihaz hakkında ek notlar..."
        />
      </div>

      {/* Tags Section */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Etiketler (Opsiyonel)
        </label>
        <div className="flex flex-wrap gap-2">
          {['Yeni', 'Kritik', 'Yedek', 'Bakımda'].map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => {
                const currentTags = values.tags || [];
                const newTags = currentTags.includes(tag)
                  ? currentTags.filter((t) => t !== tag)
                  : [...currentTags, tag];
                onChange({ tags: newTags });
              }}
              className={`px-3 py-1 text-sm rounded-full border transition-colors ${
                values.tags?.includes(tag)
                  ? 'bg-blue-100 border-blue-300 text-blue-700'
                  : 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      {/* Selected model info */}
      {selectedModelSeries && (
        <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-start">
            <Info
              className="w-5 h-5 text-gray-500 dark:text-gray-400 mr-2 mt-0.5"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {brand.modelSeries.find((m) => m.code === selectedModelSeries)?.name}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Güç Aralığı:{' '}
                {brand.modelSeries.find((m) => m.code === selectedModelSeries)?.powerRange || 'N/A'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default VfdBasicInfoStep;
