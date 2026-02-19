import { Resolver, Query, Context } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Roles, Role } from '@platform/backend-common';
import { HydroponicsStatusResponse } from '../dto/hydroponics-status.response';
import { HydroponicsConfig } from '../entities/hydroponics-config.entity';

@Resolver()
export class SetupResolver {
  constructor(
    @InjectRepository(HydroponicsConfig)
    private readonly configRepository: Repository<HydroponicsConfig>,
  ) {}

  @Query(() => HydroponicsStatusResponse, { description: 'Get hydroponics module status' })
  @Roles(Role.MODULE_USER)
  async hydroponicsStatus(
    @Context() context: { req: { user?: { tenantId?: string } } },
  ): Promise<HydroponicsStatusResponse> {
    const tenantId = context.req?.user?.tenantId;
    let configured = false;

    if (tenantId) {
      const count = await this.configRepository.count({ where: { tenantId } });
      configured = count > 0;
    }

    return {
      configured,
      moduleName: 'Hydroponics Management',
    };
  }
}
