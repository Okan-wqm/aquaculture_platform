import React, { useMemo } from 'react';
import { Input, Select, Textarea } from '@aquaculture/shared-ui';
import { ParentDeviceInfo } from '../../../types/registration.types';
import {
  useSiteList,
  useDepartmentsBySite,
  useSystemsByDepartment,
} from '../../../hooks/useLocationHierarchy';
import { useEquipmentList } from '../../../hooks/useEquipment';

interface ParentDeviceInfoStepProps {
  values: Partial<ParentDeviceInfo>;
  onChange: (updates: Partial<ParentDeviceInfo>) => void;
}

export function ParentDeviceInfoStep({ values, onChange }: ParentDeviceInfoStepProps) {
  // Fetch location hierarchy data
  const { data: sitesData, isLoading: sitesLoading } = useSiteList({ isActive: true });
  const { data: departments, isLoading: deptLoading } = useDepartmentsBySite(values.siteId || '');
  const { data: systems, isLoading: sysLoading } = useSystemsByDepartment(
    values.departmentId || '',
  );
  const { data: equipmentData, isLoading: equipLoading } = useEquipmentList({
    departmentId: values.departmentId,
    isActive: true,
  });

  // Extract items arrays
  const sites = useMemo(() => sitesData?.items || [], [sitesData]);
  const equipment = useMemo(() => equipmentData?.items || [], [equipmentData]);

  // Filter equipment by system if selected
  const filteredEquipment = useMemo(() => {
    if (!values.systemId) return equipment;
    return equipment.filter(
      (e) =>
        e.systemIds?.includes(values.systemId!) ||
        e.systems?.some((s) => s.systemId === values.systemId),
    );
  }, [equipment, values.systemId]);

  const handleChange = (field: keyof ParentDeviceInfo, value: string) => {
    onChange({ [field]: value || undefined });
  };

  // Cascading reset logic
  const handleSiteChange = (siteId: string) => {
    onChange({
      siteId: siteId || undefined,
      departmentId: undefined,
      systemId: undefined,
      equipmentId: undefined,
    });
  };

  const handleDepartmentChange = (departmentId: string) => {
    onChange({
      departmentId: departmentId || undefined,
      systemId: undefined,
      equipmentId: undefined,
    });
  };

  const handleSystemChange = (systemId: string) => {
    onChange({
      systemId: systemId || undefined,
      equipmentId: undefined,
    });
  };

  const handleEquipmentChange = (equipmentId: string) => {
    onChange({ equipmentId: equipmentId || undefined });
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
          Location Assignment
        </h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          Select where this device is installed. Site and Department are required.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Site - Required */}
          <div>
            <Select
              id="siteId"
              label="Site"
              required
              placeholder={sitesLoading ? 'Loading sites...' : 'Select Site...'}
              value={values.siteId || ''}
              onChange={(e) => handleSiteChange(e.target.value)}
              disabled={sitesLoading}
              options={sites.map((site) => ({
                value: site.id,
                label: `${site.name} (${site.code})`,
              }))}
            />
          </div>

          {/* Department - Required */}
          <div>
            <Select
              id="departmentId"
              label="Department"
              required
              placeholder={
                !values.siteId
                  ? 'Select Site first...'
                  : deptLoading
                    ? 'Loading departments...'
                    : 'Select Department...'
              }
              value={values.departmentId || ''}
              onChange={(e) => handleDepartmentChange(e.target.value)}
              disabled={!values.siteId || deptLoading}
              options={(departments ?? []).map((dept) => ({
                value: dept.id,
                label: `${dept.name} (${dept.code})`,
              }))}
            />
          </div>

          {/* System - Optional */}
          <div>
            <Select
              id="systemId"
              label="System"
              value={values.systemId || ''}
              onChange={(e) => handleSystemChange(e.target.value)}
              disabled={!values.departmentId || sysLoading}
              options={[
                {
                  value: '',
                  label: !values.departmentId
                    ? 'Select Department first...'
                    : sysLoading
                      ? 'Loading systems...'
                      : 'Select System (optional)...',
                },
                ...(systems ?? []).map((sys) => ({
                  value: sys.id,
                  label: `${sys.name} (${sys.code})`,
                })),
              ]}
            />
          </div>

          {/* Equipment - Optional */}
          <div>
            <Select
              id="equipmentId"
              label="Equipment"
              value={values.equipmentId || ''}
              onChange={(e) => handleEquipmentChange(e.target.value)}
              disabled={!values.departmentId || equipLoading}
              options={[
                {
                  value: '',
                  label: !values.departmentId
                    ? 'Select Department first...'
                    : equipLoading
                      ? 'Loading equipment...'
                      : 'Select Equipment (optional)...',
                },
                ...filteredEquipment.map((equip) => ({
                  value: equip.id,
                  label: `${equip.name} (${equip.code})`,
                })),
              ]}
            />
          </div>
        </div>
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
