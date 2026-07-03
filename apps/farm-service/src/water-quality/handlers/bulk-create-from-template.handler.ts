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

    // Additive mode skips template codes that already exist. Overwrite mode
    // UPSERTS every template parameter by code inside the transaction below —
    // it never deletes, so a tenant's custom (non-template) parameters and any
    // tuning on rows whose code is absent from the template are preserved.
    let skippedCount = 0;
    const additiveEntities: WaterQualityParameterConfig[] = [];

    if (!overwrite) {
      const existingConfigs = await this.configRepository.find({
        where: { tenantId },
        select: ['code'],
      });
      const existingCodes = new Set(existingConfigs.map((c) => c.code));
      for (const param of template.parameters) {
        if (existingCodes.has(param.code)) {
          skippedCount++;
          continue;
        }
        additiveEntities.push(
          this.configRepository.create(this.mapTemplateEntryToEntity(param, tenantId, templateId)),
        );
      }
    }

    const created = await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        if (overwrite) {
          // Non-destructive re-apply: upsert each template parameter BY CODE.
          // An existing row is updated in place (id preserved); a missing one is
          // inserted. Rows whose code is not in the template (custom params) are
          // left untouched — the prior delete-all silently destroyed them along
          // with tuned thresholds (ORPHAN-MEDIUM-267).
          const existing = await queryRunner.manager.find(WaterQualityParameterConfig, {
            where: { tenantId },
          });
          const byCode = new Map(existing.map((config) => [config.code, config]));
          const toSave = template.parameters.map((param) => {
            const mapped = this.mapTemplateEntryToEntity(param, tenantId, templateId);
            const current = byCode.get(param.code);
            return this.configRepository.create(current ? { ...current, ...mapped } : mapped);
          });
          return toSave.length > 0 ? queryRunner.manager.save(toSave) : [];
        }

        return additiveEntities.length > 0 ? queryRunner.manager.save(additiveEntities) : [];
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
