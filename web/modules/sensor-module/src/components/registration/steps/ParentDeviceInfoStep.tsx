import React from 'react';
import { Input, Textarea, useI18n } from '@aquaculture/shared-ui';
import { ParentDeviceInfo } from '../../../types/registration.types';
import { DeviceLocationFields } from '../../location/DeviceLocationFields';

interface ParentDeviceInfoStepProps {
  values: Partial<ParentDeviceInfo>;
  onChange: (updates: Partial<ParentDeviceInfo>) => void;
}

export function ParentDeviceInfoStep({ values, onChange }: ParentDeviceInfoStepProps) {
  const { t } = useI18n();
  const handleChange = (field: keyof ParentDeviceInfo, value: string) => {
    onChange({ [field]: value || undefined });
  };

  return (
    <div className="space-y-6">
      {/* Info header */}
      <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4">
        <h3 className="text-lg font-medium text-info-900 dark:text-info-100">
          Parent Device Information
        </h3>
        <p className="text-sm text-info-700 dark:text-info-300 mt-1">
          Enter information about the physical device that connects to multiple sensors. This device
          will route data from all child sensors.
        </p>
      </div>

      {/* Device Name - Required */}
      <div>
        <label
          htmlFor="name"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Device Name <span className="text-error-500">*</span>
        </label>
        <Input
          fullWidth
          type="text"
          id="name"
          value={values.name || ''}
          onChange={(e) => handleChange('name', e.target.value)}
          placeholder="e.g., Pool 1 Multi-Parameter Monitor"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          A descriptive name for this device (e.g., "Pool 1 Water Monitor")
        </p>
      </div>

      {/* Manufacturer and Model */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="manufacturer"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Manufacturer
          </label>
          <Input
            fullWidth
            type="text"
            id="manufacturer"
            value={values.manufacturer || ''}
            onChange={(e) => handleChange('manufacturer', e.target.value)}
            placeholder="e.g., Atlas Scientific"
          />
        </div>
        <div>
          <label
            htmlFor="model"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Model
          </label>
          <Input
            fullWidth
            type="text"
            id="model"
            value={values.model || ''}
            onChange={(e) => handleChange('model', e.target.value)}
            placeholder="e.g., EZO-WQM"
          />
        </div>
      </div>

      {/* Serial Number */}
      <div>
        <label
          htmlFor="serialNumber"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Serial Number
        </label>
        <Input
          fullWidth
          type="text"
          id="serialNumber"
          value={values.serialNumber || ''}
          onChange={(e) => handleChange('serialNumber', e.target.value)}
          placeholder="e.g., WQM-2024-001234"
        />
      </div>

      {/* Location Section - Cascading Dropdowns */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('sensor.location.title')}
        </h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          {t('sensor.location.sectionHelp')}
        </p>

        <DeviceLocationFields
          value={{
            siteId: values.siteId,
            departmentId: values.departmentId,
            systemId: values.systemId,
            unitId: values.unitId,
          }}
          // Every level is passed, cleared ones as undefined: the wizard merges
          // updates, and a level below a changed one must not survive it.
          onChange={(location) =>
            onChange({
              siteId: location.siteId,
              departmentId: location.departmentId,
              systemId: location.systemId,
              unitId: location.unitId,
            })
          }
        />
      </div>

      {/* Physical Location */}
      <div>
        <label
          htmlFor="location"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Physical Location
        </label>
        <Input
          fullWidth
          type="text"
          id="location"
          value={values.location || ''}
          onChange={(e) => handleChange('location', e.target.value)}
          placeholder="e.g., North wall, 2m depth"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Describe where the device is physically installed
        </p>
      </div>

      {/* Description */}
      <div>
        <label
          htmlFor="description"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Description
        </label>
        <Textarea
          fullWidth
          id="description"
          value={values.description || ''}
          onChange={(e) => handleChange('description', e.target.value)}
          placeholder="Additional notes about this device..."
          rows={3}
        />
      </div>
    </div>
  );
}

export default ParentDeviceInfoStep;
