import { StorageLocation } from '../types/storage.types';

export const storageLocations: StorageLocation[] = [
  { id: 'loc1', name: 'Main Warehouse', code: 'WH-01', type: 'WAREHOUSE', capacity: 500, capacityUnit: 'm³', usedCapacity: 320, description: 'General storage for equipment and consumables', isActive: true, humidityControl: false },
  { id: 'loc2', name: 'Cold Room 1', code: 'CR-01', type: 'COLD_ROOM', capacity: 50, capacityUnit: 'm³', usedCapacity: 38, temperatureMin: 2, temperatureMax: 8, description: 'Vaccine and sensitive feed storage', isActive: true, humidityControl: true },
  { id: 'loc3', name: 'Cold Room 2', code: 'CR-02', type: 'COLD_ROOM', capacity: 30, capacityUnit: 'm³', usedCapacity: 15, temperatureMin: 2, temperatureMax: 8, description: 'Pharmaceutical and chemical cold storage', isActive: true, humidityControl: true },
  { id: 'loc4', name: 'Chemical Store', code: 'CS-01', type: 'CHEMICAL_STORE', capacity: 100, capacityUnit: 'm³', usedCapacity: 65, temperatureMin: 10, temperatureMax: 25, description: 'Approved chemical storage with ventilation', isActive: true, humidityControl: true },
  { id: 'loc5', name: 'Feed Silo A', code: 'FS-A', type: 'FEED_SILO', capacity: 10000, capacityUnit: 'kg', usedCapacity: 5250, description: 'Primary feed silo - grower pellets', isActive: true, humidityControl: false },
  { id: 'loc6', name: 'Hazmat Storage', code: 'HZ-01', type: 'HAZMAT', capacity: 20, capacityUnit: 'm³', usedCapacity: 8, temperatureMin: 5, temperatureMax: 20, description: 'Hazardous materials containment area', isActive: true, humidityControl: true },
];
