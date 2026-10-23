import type { SelectQueryBuilder } from 'typeorm';

import { HrModuleCode } from './enums';
import { applyEmployeeModuleScope, employeeModuleWhere, isModuleScoped } from './module-scope';

describe('module scope', () => {
  describe('isModuleScoped', () => {
    it.each([HrModuleCode.FARM, HrModuleCode.HYDROPONICS, HrModuleCode.SENSOR])(
      'is in force for %s',
      (moduleCode) => {
        expect(isModuleScoped(moduleCode)).toBe(true);
      },
    );

    it.each([undefined, null])('is not in force for %s', (moduleCode) => {
      expect(isModuleScoped(moduleCode)).toBe(false);
    });
  });

  describe('employeeModuleWhere', () => {
    it('matches only live departments of the module', () => {
      expect(employeeModuleWhere(HrModuleCode.SENSOR)).toEqual({
        moduleCode: HrModuleCode.SENSOR,
        isDeleted: false,
      });
    });
  });

  describe('applyEmployeeModuleScope', () => {
    const buildQueryBuilder = (): {
      queryBuilder: SelectQueryBuilder<object>;
      innerJoin: jest.Mock;
    } => {
      const innerJoin = jest.fn();
      // Only innerJoin is reachable from applyEmployeeModuleScope; the double is declared as a
      // Partial so a single assertion hands it over as the builder.
      const partial: Partial<SelectQueryBuilder<object>> = { innerJoin };
      innerJoin.mockReturnValue(partial);
      return { queryBuilder: partial as SelectQueryBuilder<object>, innerJoin };
    };

    it('joins the employee department under a scope alias and filters on module and liveness', () => {
      const { queryBuilder, innerJoin } = buildQueryBuilder();

      const result = applyEmployeeModuleScope(queryBuilder, 'employee', HrModuleCode.FARM);

      expect(innerJoin).toHaveBeenCalledWith(
        'employee.departmentHr',
        'employee_scope_department',
        'employee_scope_department.moduleCode = :scopeModuleCode AND employee_scope_department.isDeleted = false',
        { scopeModuleCode: HrModuleCode.FARM },
      );
      expect(result).toBe(queryBuilder);
    });

    it('reads an explicit null like an absent module: the Company view', () => {
      const { queryBuilder, innerJoin } = buildQueryBuilder();

      const result = applyEmployeeModuleScope(queryBuilder, 'employee', null);

      expect(innerJoin).not.toHaveBeenCalled();
      expect(result).toBe(queryBuilder);
    });

    it('leaves the query untouched when no module is given (the Company view)', () => {
      const { queryBuilder, innerJoin } = buildQueryBuilder();

      const result = applyEmployeeModuleScope(queryBuilder, 'employee', undefined);

      expect(innerJoin).not.toHaveBeenCalled();
      expect(result).toBe(queryBuilder);
    });
  });
});
