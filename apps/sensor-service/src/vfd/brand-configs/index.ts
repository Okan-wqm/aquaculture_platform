/**
 * VFD Brand Configurations Index
 * Exports all brand-specific register mappings and configurations
 */

// Danfoss FC Series
export {
  DANFOSS_FC_REGISTERS,
  DANFOSS_CONTROL_COMMANDS,
  DANFOSS_DEFAULT_CONFIG,
  DANFOSS_FC_CONFIG_REGISTERS,
} from './danfoss.config';

// ABB ACS Series
export {
  ABB_ACS_REGISTERS,
  ABB_CONTROL_COMMANDS,
  ABB_DEFAULT_CONFIG,
  ABB_FAULT_CODES,
  ABB_ACS_CONFIG_REGISTERS,
} from './abb.config';

// Siemens SINAMICS
export {
  SIEMENS_SINAMICS_REGISTERS,
  SIEMENS_CONTROL_COMMANDS,
  SIEMENS_DEFAULT_CONFIG,
  SIEMENS_FAULT_CODES,
  SIEMENS_G120_CONFIG_REGISTERS,
} from './siemens.config';

// Schneider Electric Altivar
export {
  SCHNEIDER_ALTIVAR_REGISTERS,
  SCHNEIDER_CONTROL_COMMANDS,
  SCHNEIDER_DEFAULT_CONFIG,
  SCHNEIDER_ALTIVAR_CONFIG_REGISTERS,
} from './schneider.config';

// Yaskawa
export {
  YASKAWA_REGISTERS,
  YASKAWA_CONTROL_COMMANDS,
  YASKAWA_DEFAULT_CONFIG,
  YASKAWA_CONFIG_REGISTERS,
} from './yaskawa.config';

// Delta VFD
export {
  DELTA_VFD_REGISTERS,
  DELTA_CONTROL_COMMANDS,
  DELTA_DEFAULT_CONFIG,
  DELTA_FAULT_CODES,
  DELTA_VFD_CONFIG_REGISTERS,
} from './delta.config';

// Mitsubishi FR Series
export {
  MITSUBISHI_FR_REGISTERS,
  MITSUBISHI_CONTROL_COMMANDS,
  MITSUBISHI_DEFAULT_CONFIG,
  MITSUBISHI_FAULT_CODES,
  MITSUBISHI_FR_CONFIG_REGISTERS,
} from './mitsubishi.config';

// Rockwell PowerFlex
export {
  ROCKWELL_POWERFLEX_REGISTERS,
  ROCKWELL_CONTROL_COMMANDS,
  ROCKWELL_DEFAULT_CONFIG,
  ROCKWELL_FAULT_CODES,
  ROCKWELL_MODELS,
  ROCKWELL_POWERFLEX_CONFIG_REGISTERS,
} from './rockwell.config';

import { VfdRegisterMappingInput, VfdConfigRegisterInput } from '../entities/vfd.types';
import { VfdBrand, VfdParameterCategory, VfdParameterGroup } from '../entities/vfd.enums';

import { ABB_ACS_REGISTERS, ABB_CONTROL_COMMANDS, ABB_DEFAULT_CONFIG, ABB_ACS_CONFIG_REGISTERS } from './abb.config';
import { DANFOSS_FC_REGISTERS, DANFOSS_CONTROL_COMMANDS, DANFOSS_DEFAULT_CONFIG, DANFOSS_FC_CONFIG_REGISTERS } from './danfoss.config';
import { DELTA_VFD_REGISTERS, DELTA_CONTROL_COMMANDS, DELTA_DEFAULT_CONFIG, DELTA_VFD_CONFIG_REGISTERS } from './delta.config';
import { MITSUBISHI_FR_REGISTERS, MITSUBISHI_CONTROL_COMMANDS, MITSUBISHI_DEFAULT_CONFIG, MITSUBISHI_FR_CONFIG_REGISTERS } from './mitsubishi.config';
import { ROCKWELL_POWERFLEX_REGISTERS, ROCKWELL_CONTROL_COMMANDS, ROCKWELL_DEFAULT_CONFIG, ROCKWELL_POWERFLEX_CONFIG_REGISTERS } from './rockwell.config';
import { SCHNEIDER_ALTIVAR_REGISTERS, SCHNEIDER_CONTROL_COMMANDS, SCHNEIDER_DEFAULT_CONFIG, SCHNEIDER_ALTIVAR_CONFIG_REGISTERS } from './schneider.config';
import { SIEMENS_SINAMICS_REGISTERS, SIEMENS_CONTROL_COMMANDS, SIEMENS_DEFAULT_CONFIG, SIEMENS_G120_CONFIG_REGISTERS } from './siemens.config';
import { YASKAWA_REGISTERS, YASKAWA_CONTROL_COMMANDS, YASKAWA_DEFAULT_CONFIG, YASKAWA_CONFIG_REGISTERS } from './yaskawa.config';

/**
 * Map of brand to register mappings
 */
export const VFD_BRAND_REGISTERS: Record<VfdBrand, VfdRegisterMappingInput[]> = {
  [VfdBrand.DANFOSS]: DANFOSS_FC_REGISTERS,
  [VfdBrand.ABB]: ABB_ACS_REGISTERS,
  [VfdBrand.SIEMENS]: SIEMENS_SINAMICS_REGISTERS,
  [VfdBrand.SCHNEIDER]: SCHNEIDER_ALTIVAR_REGISTERS,
  [VfdBrand.YASKAWA]: YASKAWA_REGISTERS,
  [VfdBrand.DELTA]: DELTA_VFD_REGISTERS,
  [VfdBrand.MITSUBISHI]: MITSUBISHI_FR_REGISTERS,
  [VfdBrand.ROCKWELL]: ROCKWELL_POWERFLEX_REGISTERS,
};

/**
 * Map of brand to control commands
 */
export const VFD_BRAND_COMMANDS: Record<VfdBrand, Record<string, number>> = {
  [VfdBrand.DANFOSS]: DANFOSS_CONTROL_COMMANDS,
  [VfdBrand.ABB]: ABB_CONTROL_COMMANDS,
  [VfdBrand.SIEMENS]: SIEMENS_CONTROL_COMMANDS,
  [VfdBrand.SCHNEIDER]: SCHNEIDER_CONTROL_COMMANDS,
  [VfdBrand.YASKAWA]: YASKAWA_CONTROL_COMMANDS,
  [VfdBrand.DELTA]: DELTA_CONTROL_COMMANDS,
  [VfdBrand.MITSUBISHI]: MITSUBISHI_CONTROL_COMMANDS,
  [VfdBrand.ROCKWELL]: ROCKWELL_CONTROL_COMMANDS,
};

/**
 * Map of brand to default serial configuration
 */
export const VFD_BRAND_DEFAULT_CONFIGS: Record<VfdBrand, {
  baudRate: number;
  dataBits: number;
  parity: 'none' | 'even' | 'odd';
  stopBits: number;
  timeout: number;
  retryCount: number;
}> = {
  [VfdBrand.DANFOSS]: DANFOSS_DEFAULT_CONFIG,
  [VfdBrand.ABB]: ABB_DEFAULT_CONFIG,
  [VfdBrand.SIEMENS]: SIEMENS_DEFAULT_CONFIG,
  [VfdBrand.SCHNEIDER]: SCHNEIDER_DEFAULT_CONFIG,
  [VfdBrand.YASKAWA]: YASKAWA_DEFAULT_CONFIG,
  [VfdBrand.DELTA]: DELTA_DEFAULT_CONFIG,
  [VfdBrand.MITSUBISHI]: MITSUBISHI_DEFAULT_CONFIG,
  [VfdBrand.ROCKWELL]: ROCKWELL_DEFAULT_CONFIG,
};

/**
 * Get register mappings for a specific brand
 */
export function getVfdRegisterMappings(brand: VfdBrand): VfdRegisterMappingInput[] {
  return VFD_BRAND_REGISTERS[brand] || [];
}

/**
 * Get control commands for a specific brand
 */
export function getVfdControlCommands(brand: VfdBrand): Record<string, number> {
  return VFD_BRAND_COMMANDS[brand] || {};
}

/**
 * Get default serial configuration for a specific brand
 */
export function getVfdDefaultConfig(brand: VfdBrand): {
  baudRate: number;
  dataBits: number;
  parity: 'none' | 'even' | 'odd';
  stopBits: number;
  timeout: number;
  retryCount: number;
} {
  return VFD_BRAND_DEFAULT_CONFIGS[brand] || DANFOSS_DEFAULT_CONFIG;
}

/**
 * Get all supported VFD brands
 */
export function getSupportedVfdBrands(): VfdBrand[] {
  return Object.values(VfdBrand);
}

/**
 * Get critical parameters for a brand (for real-time monitoring)
 */
export function getCriticalParameters(brand: VfdBrand): VfdRegisterMappingInput[] {
  const registers = getVfdRegisterMappings(brand);
  return registers.filter(r => r.isCritical);
}

/**
 * Get parameters by category for a brand
 */
export function getParametersByCategory(
  brand: VfdBrand,
  category: VfdParameterCategory
): VfdRegisterMappingInput[] {
  const registers = getVfdRegisterMappings(brand);
  return registers.filter(r => r.category === category);
}

/**
 * Get writable parameters for a brand (for control operations)
 */
export function getWritableParameters(brand: VfdBrand): VfdRegisterMappingInput[] {
  const registers = getVfdRegisterMappings(brand);
  return registers.filter(r => r.isWritable);
}

/**
 * Map of brand to configuration registers for remote programming
 */
export const VFD_BRAND_CONFIG_REGISTERS: Record<VfdBrand, VfdConfigRegisterInput[]> = {
  [VfdBrand.DANFOSS]: DANFOSS_FC_CONFIG_REGISTERS,
  [VfdBrand.ABB]: ABB_ACS_CONFIG_REGISTERS,
  [VfdBrand.SIEMENS]: SIEMENS_G120_CONFIG_REGISTERS,
  [VfdBrand.SCHNEIDER]: SCHNEIDER_ALTIVAR_CONFIG_REGISTERS,
  [VfdBrand.YASKAWA]: YASKAWA_CONFIG_REGISTERS,
  [VfdBrand.DELTA]: DELTA_VFD_CONFIG_REGISTERS,
  [VfdBrand.MITSUBISHI]: MITSUBISHI_FR_CONFIG_REGISTERS,
  [VfdBrand.ROCKWELL]: ROCKWELL_POWERFLEX_CONFIG_REGISTERS,
};

/**
 * Get configuration registers for a specific brand
 */
export function getVfdConfigRegisters(brand: VfdBrand): VfdConfigRegisterInput[] {
  return VFD_BRAND_CONFIG_REGISTERS[brand] || [];
}

/**
 * Get configuration registers for a specific brand filtered by parameter group
 */
export function getVfdConfigRegistersByGroup(
  brand: VfdBrand,
  group: VfdParameterGroup,
): VfdConfigRegisterInput[] {
  const registers = getVfdConfigRegisters(brand);
  return registers.filter(r => r.group === group);
}
