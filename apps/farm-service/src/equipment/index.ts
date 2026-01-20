/**
 * Equipment Module Exports
 */
export * from './equipment.module';
export * from './entities/equipment.entity';
export * from './entities/equipment-type.entity';
export * from './entities/sub-equipment.entity';
export * from './entities/sub-equipment-type.entity';
export * from './dto';

// Export commands (class only, not re-exported types)
export { CreateEquipmentCommand } from './commands/create-equipment.command';
export { UpdateEquipmentCommand } from './commands/update-equipment.command';
export { DeleteEquipmentCommand } from './commands/delete-equipment.command';

// Export queries
export * from './queries/get-equipment.query';
export * from './queries/list-equipment.query';
export * from './queries/get-equipment-types.query';
