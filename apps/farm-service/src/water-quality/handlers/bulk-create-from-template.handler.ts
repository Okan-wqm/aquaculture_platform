/**
 * BulkCreateFromTemplateHandler
 *
 * Creates water quality parameter configurations in bulk from a predefined template.
 * Supports overwrite mode (replace all) or additive mode (skip existing codes).
 *
 * @module WaterQuality/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { BulkCreateFromTemplateCommand } from '../commands/bulk-create-from-template.command';
import {
  WaterQualityParameterConfig,
  ParameterDataType,
  ParameterGroup,
} from '../entities/water-quality-parameter-config.entity';
import { getTemplateById, ParameterTemplateEntry } from '../data/parameter-templates.data';
import { ParameterConfigCacheService } from '../services/parameter-config-cache.service';

@Injectable()
@CommandHandler(BulkCreateFromTemplateCommand)
export class BulkCreateFromTemplateHandler
  implements ICommandHandler<BulkCreateFromTemplateCommand, WaterQualityParameterConfig[]>
{
  private readonly logger = new Logger(BulkCreateFromTemplateHandler.name);

  constructor(
    @InjectRepository(WaterQualityParameterConfig)
    private readonly configRepository: Repository<WaterQualityParameterConfig>,
    private readonly configCache: ParameterConfigCacheService,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: BulkCreateFromTemplateCommand): Promise<WaterQualityParameterConfig[]> {
    const { tenantId, templateId, overwrite } = command;

    this.logger.log(
      `Bulk creating parameter configs from template "${templateId}" for tenant ${tenantId} (overwrite=${overwrite})`,
    );

    const template = getTemplateById(templateId);

    if (!template) {
      throw new NotFoundException(`Parameter template with ID '${templateId}' not found`);
    }

    let existingCodes = new Set<string>();

    if (!overwrite) {
      // Find existing codes to skip
      const existingConfigs = await this.configRepository.find({
        where: { tenantId },
        select: ['code'],
      });
      existingCodes = new Set(existingConfigs.map((c) => c.code));
    }

    // Map template parameters to entity instances, skipping existing if not overwriting
    const entitiesToCreate: WaterQualityParameterConfig[] = [];
    let skippedCount = 0;

    for (const param of template.parameters) {
      if (!overwrite && existingCodes.has(param.code)) {
        skippedCount++;
        continue;
      }

      const entity = this.configRepository.create(
        this.mapTemplateEntryToEntity(param, tenantId, templateId),
      );
      entitiesToCreate.push(entity);
    }

    // Wrap delete (if overwrite) + bulk insert in a tenant-scoped transaction
    const created = await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        if (overwrite) {
          const deleted = await queryRunner.manager.delete(WaterQualityParameterConfig, {
            tenantId,
          });
          this.logger.log(
            `Overwrite mode: removed ${deleted.affected ?? 0} existing configs for tenant ${tenantId}`,
          );
        }

        if (entitiesToCreate.length > 0) {
          return queryRunner.manager.save(entitiesToCreate);
        }

        return [];
      },
    );

    this.configCache.invalidate(tenantId);

    this.logger.log(
      `Template "${templateId}": created ${created.length} configs, skipped ${skippedCount} existing for tenant ${tenantId}`,
    );

    return created;
  }

  private mapTemplateEntryToEntity(
    param: ParameterTemplateEntry,
    tenantId: string,
    templateId: string,
  ): Partial<WaterQualityParameterConfig> {
    return {
      tenantId,
      code: param.code,
      name: param.name,
      unit: param.unit,
      dataType: param.dataType as ParameterDataType,
      precision: param.precision,
      group: param.group as ParameterGroup,
      optimalMin: param.optimalMin ?? undefined,
      optimalMax: param.optimalMax ?? undefined,
      warningMin: param.warningMin ?? undefined,
      warningMax: param.warningMax ?? undefined,
      criticalMin: param.criticalMin ?? undefined,
      criticalMax: param.criticalMax ?? undefined,
      enumValues: param.enumValues,
      chartColor: param.chartColor,
      displayOrder: param.displayOrder,
      isVisible: param.isVisible,
      isRequired: param.isRequired,
      isActive: true,
      chartAxisGroup: param.chartAxisGroup,
      templateSource: templateId,
    };
  }
}
