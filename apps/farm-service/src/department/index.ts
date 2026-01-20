/**
 * Department Module Exports
 */
export * from './department.module';
export * from './entities/department.entity';
export * from './dto';

// Export commands (class only, not re-exported types)
export { CreateDepartmentCommand } from './commands/create-department.command';
export { UpdateDepartmentCommand } from './commands/update-department.command';
export { DeleteDepartmentCommand } from './commands/delete-department.command';

// Export queries
export * from './queries/get-department.query';
export * from './queries/list-departments.query';
