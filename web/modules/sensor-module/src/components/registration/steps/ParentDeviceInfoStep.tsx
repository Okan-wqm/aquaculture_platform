import React, { useMemo } from 'react';
import { ParentDeviceInfo } from '../../../types/registration.types';
import { useSiteList, useDepartmentsBySite, useSystemsByDepartment } from '../../../hooks/useLocationHierarchy';
import { useEquipmentList } from '../../../hooks/useEquipment';

interface ParentDeviceInfoStepProps {
  values: Partial<ParentDeviceInfo>;
  onChange: (updates: Partial<ParentDeviceInfo>) => void;
}

export function ParentDeviceInfoStep({ values, onChange }: ParentDeviceInfoStepProps) {
  // Fetch location hierarchy data
  const { data: sitesData, isLoading: sitesLoading } = useSiteList({ isActive: true });
  const { data: departments, isLoading: deptLoading } = useDepartmentsBySite(values.siteId || '');
  const { data: systems, isLoading: sysLoading } = useSystemsByDepartment(values.departmentId || '');
  const { data: equipmentData, isLoading: equipLoading } = useEquipmentList({
    departmentId: values.departmentId,
    isActive: true
  });

  // Extract items arrays
  const sites = useMemo(() => sitesData?.items || [], [sitesData]);
  const equipment = useMemo(() => equipmentData?.items || [], [equipmentData]);

  // Filter equipment by system if selected
  const filteredEquipment = useMemo(() => {
    if (!values.systemId) return equipment;
    return equipment.filter(e => e.systemIds?.includes(values.systemId!) || e.systems?.some(s => s.systemId === values.systemId));
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
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-blue-900">Parent Device Information</h3>
        <p className="text-sm text-blue-700 mt-1">
          Enter information about the physical device that connects to multiple sensors.
          This device will route data from all child sensors.
        </p>
      </div>

      {/* Device Name - Required */}
      <div>
        <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
          Device Name <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          id="name"
          value={values.name || ''}
          onChange={(e) => handleChange('name', e.target.value)}
          placeholder="e.g., Pool 1 Multi-Parameter Monitor"
          className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <p className="mt-1 text-xs text-gray-500">
          A descriptive name for this device (e.g., "Pool 1 Water Monitor")
        </p>
      </div>

      {/* Manufacturer and Model */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="manufacturer" className="block text-sm font-medium text-gray-700 mb-1">
            Manufacturer
          </label>
          <input
            type="text"
            id="manufacturer"
            value={values.manufacturer || ''}
            onChange={(e) => handleChange('manufacturer', e.target.value)}
            placeholder="e.g., Atlas Scientific"
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label htmlFor="model" className="block text-sm font-medium text-gray-700 mb-1">
            Model
          </label>
          <input
            type="text"
            id="model"
            value={values.model || ''}
            onChange={(e) => handleChange('model', e.target.value)}
            placeholder="e.g., EZO-WQM"
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>

      {/* Serial Number */}
      <div>
        <label htmlFor="serialNumber" className="block text-sm font-medium text-gray-700 mb-1">
          Serial Number
        </label>
        <input
          type="text"
          id="serialNumber"
          value={values.serialNumber || ''}
          onChange={(e) => handleChange('serialNumber', e.target.value)}
          placeholder="e.g., WQM-2024-001234"
          className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {/* Location Section - Cascading Dropdowns */}
      <div className="border-t border-gray-200 pt-6">
        <h4 className="text-sm font-medium text-gray-900 mb-4">Location Assignment</h4>
        <p className="text-xs text-gray-500 mb-4">
          Select where this device is installed. Site and Department are required.
        </p>

        <div className="grid grid-cols-2 gap-4">
          {/* Site - Required */}
          <div>
            <label htmlFor="siteId" className="block text-sm font-medium text-gray-700 mb-1">
              Site <span className="text-red-500">*</span>
            </label>
            <select
              id="siteId"
              value={values.siteId || ''}
              onChange={(e) => handleSiteChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              disabled={sitesLoading}
            >
              <option value="">
                {sitesLoading ? 'Loading sites...' : 'Select Site...'}
              </option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name} ({site.code})
                </option>
              ))}
            </select>
          </div>

          {/* Department - Required */}
          <div>
            <label htmlFor="departmentId" className="block text-sm font-medium text-gray-700 mb-1">
              Department <span className="text-red-500">*</span>
            </label>
            <select
              id="departmentId"
              value={values.departmentId || ''}
              onChange={(e) => handleDepartmentChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
              disabled={!values.siteId || deptLoading}
            >
              <option value="">
                {!values.siteId
                  ? 'Select Site first...'
                  : deptLoading
                    ? 'Loading departments...'
                    : 'Select Department...'}
              </option>
              {departments?.map((dept) => (
                <option key={dept.id} value={dept.id}>
                  {dept.name} ({dept.code})
                </option>
              ))}
            </select>
          </div>

          {/* System - Optional */}
          <div>
            <label htmlFor="systemId" className="block text-sm font-medium text-gray-700 mb-1">
              System
            </label>
            <select
              id="systemId"
              value={values.systemId || ''}
              onChange={(e) => handleSystemChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
              disabled={!values.departmentId || sysLoading}
            >
              <option value="">
                {!values.departmentId
                  ? 'Select Department first...'
                  : sysLoading
                    ? 'Loading systems...'
                    : 'Select System (optional)...'}
              </option>
              {systems?.map((sys) => (
                <option key={sys.id} value={sys.id}>
                  {sys.name} ({sys.code})
                </option>
              ))}
            </select>
          </div>

          {/* Equipment - Optional */}
          <div>
            <label htmlFor="equipmentId" className="block text-sm font-medium text-gray-700 mb-1">
              Equipment
            </label>
            <select
              id="equipmentId"
              value={values.equipmentId || ''}
              onChange={(e) => handleEquipmentChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
              disabled={!values.departmentId || equipLoading}
            >
              <option value="">
                {!values.departmentId
                  ? 'Select Department first...'
                  : equipLoading
                    ? 'Loading equipment...'
                    : 'Select Equipment (optional)...'}
              </option>
              {filteredEquipment.map((equip) => (
                <option key={equip.id} value={equip.id}>
                  {equip.name} ({equip.code})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Physical Location */}
      <div>
        <label htmlFor="location" className="block text-sm font-medium text-gray-700 mb-1">
          Physical Location
        </label>
        <input
          type="text"
          id="location"
          value={values.location || ''}
          onChange={(e) => handleChange('location', e.target.value)}
          placeholder="e.g., North wall, 2m depth"
          className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <p className="mt-1 text-xs text-gray-500">
          Describe where the device is physically installed
        </p>
      </div>

      {/* Description */}
      <div>
        <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
          Description
        </label>
        <textarea
          id="description"
          value={values.description || ''}
          onChange={(e) => handleChange('description', e.target.value)}
          placeholder="Additional notes about this device..."
          rows={3}
          className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
    </div>
  );
}

export default ParentDeviceInfoStep;
