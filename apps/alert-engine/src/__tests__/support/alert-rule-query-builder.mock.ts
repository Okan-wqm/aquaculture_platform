import { FindManyOptions, FindOptionsWhere } from 'typeorm';
import { AlertRule } from '../../database/entities/alert-rule.entity';

type QueryParams = Readonly<Record<string, unknown>>;
type FindAlertRules = (options?: FindManyOptions<AlertRule>) => Promise<AlertRule[]>;

export interface AlertRuleQueryBuilderMock {
  where: jest.Mock<AlertRuleQueryBuilderMock, [string, QueryParams?]>;
  andWhere: jest.Mock<AlertRuleQueryBuilderMock, [string, QueryParams?]>;
  orderBy: jest.Mock<AlertRuleQueryBuilderMock, [string, ('ASC' | 'DESC')?]>;
  getMany: jest.Mock<Promise<AlertRule[]>, []>;
  getOne: jest.Mock<Promise<AlertRule | null>, []>;
}

function applyQueryParams(where: FindOptionsWhere<AlertRule>, params?: QueryParams): void {
  if (!params) {
    return;
  }

  const tenantId = params['tenantId'];
  if (typeof tenantId === 'string') {
    where.tenantId = tenantId;
  }

  const isActive = params['isActive'];
  if (typeof isActive === 'boolean') {
    where.isActive = isActive;
  }

  const farmId = params['farmId'];
  if (typeof farmId === 'string') {
    where.farmId = farmId;
  }

  const pondId = params['pondId'];
  if (typeof pondId === 'string') {
    where.pondId = pondId;
  }

  const sensorId = params['sensorId'];
  if (typeof sensorId === 'string') {
    where.sensorId = sensorId;
  }
}

export function createAlertRuleQueryBuilderMock(findRules: FindAlertRules): AlertRuleQueryBuilderMock {
  let where: FindOptionsWhere<AlertRule> = {};

  const queryBuilder: AlertRuleQueryBuilderMock = {
    where: jest.fn((_condition: string, params?: QueryParams) => {
      where = {};
      applyQueryParams(where, params);
      return queryBuilder;
    }),
    andWhere: jest.fn((_condition: string, params?: QueryParams) => {
      applyQueryParams(where, params);
      return queryBuilder;
    }),
    orderBy: jest.fn((_field: string, _order?: 'ASC' | 'DESC') => queryBuilder),
    getMany: jest.fn(async () => findRules({ where: { ...where } })),
    getOne: jest.fn(async () => {
      const rules = await findRules({ where: { ...where } });
      return rules[0] ?? null;
    }),
  };

  return queryBuilder;
}
