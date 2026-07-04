/**
 * Config Form Modal
 *
 * Create/Edit modal for water quality parameter configuration.
 * Used by ParameterConfigManager for adding new parameters
 * and editing existing ones.
 */
import React, { useState } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import {
  ParameterDataType,
  ParameterGroup,
  GROUP_OPTIONS,
  DATA_TYPE_OPTIONS,
} from '../../../hooks/useParameterConfigs';

// ============================================================================
// TYPES
// ============================================================================

export interface ConfigFormData {
  code: string;
  name: string;
  unit: string;
  dataType: ParameterDataType;
  group: ParameterGroup;
  precision: string;
  optimalMin: string;
  optimalMax: string;
  warningMin: string;
  warningMax: string;
  criticalMin: string;
  criticalMax: string;
  chartColor: string;
  chartAxisGroup: string;
  isVisible: boolean;
  isRequired: boolean;
}

export const EMPTY_FORM: ConfigFormData = {
  code: '',
  name: '',
  unit: '',
  dataType: 'NUMBER',
  group: 'BASIC',
  precision: '2',
  optimalMin: '',
  optimalMax: '',
  warningMin: '',
  warningMax: '',
  criticalMin: '',
  criticalMax: '',
  chartColor: '#3B82F6',
  chartAxisGroup: 'left',
  isVisible: true,
  isRequired: false,
};

interface ConfigFormModalProps {
  mode: 'create' | 'edit';
  initialData: ConfigFormData;
  onSubmit: (data: ConfigFormData) => void;
  onClose: () => void;
  isSubmitting: boolean;
  error: Error | null;
}

// ============================================================================
// RANGE FIELDSET SUB-COMPONENT
// ============================================================================

const RangeFieldset: React.FC<{
  legend: string;
  minName: string;
  maxName: string;
  minValue: string;
  maxValue: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}> = ({ legend, minName, maxName, minValue, maxValue, onChange }) => (
  <fieldset className="border border-gray-200 rounded-lg p-3">
    <legend className="text-sm font-medium text-gray-700 px-1">{legend}</legend>
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Min</label>
        <input
          type="number"
          name={minName}
          value={minValue}
          onChange={onChange}
          step="any"
          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Max</label>
        <input
          type="number"
          name={maxName}
          value={maxValue}
          onChange={onChange}
          step="any"
          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
        />
      </div>
    </div>
  </fieldset>
);

// ============================================================================
// COMPONENT
// ============================================================================

export const ConfigFormModal: React.FC<ConfigFormModalProps> = ({
  mode,
  initialData,
  onSubmit,
  onClose,
  isSubmitting,
  error,
}) => {
  const [formData, setFormData] = useState<ConfigFormData>(initialData);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    if (type === 'checkbox') {
      setFormData((prev) => ({ ...prev, [name]: (e.target as HTMLInputElement).checked }));
    } else {
      setFormData((prev) => ({ ...prev, [name]: value }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={mode === 'create' ? 'Add Parameter' : 'Edit Parameter'}
      size="md"
    >
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          {error.message}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Code */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Code *</label>
          <input
            type="text"
            name="code"
            value={formData.code}
            onChange={handleChange}
            required
            disabled={mode === 'edit'}
            placeholder="e.g., dissolved_oxygen"
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm disabled:bg-gray-100 disabled:text-gray-500"
          />
        </div>

        {/* Name + Unit */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
            <input
              type="text"
              name="name"
              value={formData.name}
              onChange={handleChange}
              required
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Unit *</label>
            <input
              type="text"
              name="unit"
              value={formData.unit}
              onChange={handleChange}
              required
              placeholder="e.g., mg/L"
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            />
          </div>
        </div>

        {/* Data Type + Group */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Data Type</label>
            <select
              name="dataType"
              value={formData.dataType}
              onChange={handleChange}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            >
              {DATA_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Group</label>
            <select
              name="group"
              value={formData.group}
              onChange={handleChange}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            >
              {GROUP_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Precision */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Precision (0-6)</label>
          <input
            type="number"
            name="precision"
            value={formData.precision}
            onChange={handleChange}
            min={0}
            max={6}
            className="block w-32 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          />
        </div>

        {/* Range Fieldsets */}
        <RangeFieldset
          legend="Optimal Range"
          minName="optimalMin"
          maxName="optimalMax"
          minValue={formData.optimalMin}
          maxValue={formData.optimalMax}
          onChange={handleChange}
        />
        <RangeFieldset
          legend="Warning Range"
          minName="warningMin"
          maxName="warningMax"
          minValue={formData.warningMin}
          maxValue={formData.warningMax}
          onChange={handleChange}
        />
        <RangeFieldset
          legend="Critical Range"
          minName="criticalMin"
          maxName="criticalMax"
          minValue={formData.criticalMin}
          maxValue={formData.criticalMax}
          onChange={handleChange}
        />

        {/* Chart Color */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Chart Color</label>
          <div className="flex items-center space-x-3">
            <input
              type="text"
              name="chartColor"
              value={formData.chartColor}
              onChange={handleChange}
              placeholder="#3B82F6"
              className="block w-32 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            />
            <div
              className="w-8 h-8 rounded border border-gray-300"
              style={{ backgroundColor: formData.chartColor || '#ccc' }}
            />
            <input
              type="color"
              value={formData.chartColor || '#3B82F6'}
              onChange={(e) => setFormData((prev) => ({ ...prev, chartColor: e.target.value }))}
              className="w-8 h-8 p-0 border-0 cursor-pointer"
            />
          </div>
        </div>

        {/* Chart Axis Group */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Chart Axis Group</label>
          <div className="flex items-center space-x-6">
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="radio"
                name="chartAxisGroup"
                value="left"
                checked={formData.chartAxisGroup === 'left'}
                onChange={handleChange}
                className="text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Left</span>
            </label>
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="radio"
                name="chartAxisGroup"
                value="right"
                checked={formData.chartAxisGroup === 'right'}
                onChange={handleChange}
                className="text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Right</span>
            </label>
          </div>
        </div>

        {/* Checkboxes */}
        <div className="flex items-center space-x-6">
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              name="isVisible"
              checked={formData.isVisible}
              onChange={handleChange}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">Visible</span>
          </label>
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              name="isRequired"
              checked={formData.isRequired}
              onChange={handleChange}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">Required</span>
          </label>
        </div>

        {/* Actions */}
        <div className="flex justify-end space-x-3 pt-4 border-t">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
