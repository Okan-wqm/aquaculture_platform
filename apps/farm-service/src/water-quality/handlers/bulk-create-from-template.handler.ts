/**
 * BulkCreateFromTemplateHandler
 *
 * Creates water quality parameter configurations in bulk from a predefined template.
 * Supports overwrite mode (replace all) or additive mode (skip existing codes).
 *
 * @module WaterQuality/Handlers
 */
import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { parameterHasMeasurements, unitMeaningChanged } from '../services/parameter-meaning';
import { liveChannelSourceCount } from '../services/parameter-sources';
import { runSourceTransaction } from '../services/source-transaction';
import { ParameterSourceError } from '../../common/errors/farm-errors';
import { PARAMETER_SOURCE_ERROR } from '@aquaculture/shared-contracts';

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

    // The source transaction maps the one-active-config-per-quantity index to a
    // 409 (a custom parameter may already be declared as a template's quantity).
    const created = await runSourceTransaction(this.dataSource, tenantId, async (queryRunner) => {
      if (overwrite) {
        // Non-destructive re-apply: upsert each template parameter BY CODE.
        // An existing row is updated in place (id preserved); a missing one is
        // inserted. Rows whose code is not in the template (custom params) are
        // left untouched — the prior delete-all silently destroyed them along
        // with tuned thresholds (ORPHAN-MEDIUM-267).
        // Locked like every write to a parameter's meaning (FARM-HIGH-373, D8).
        const existing = await queryRunner.manager.find(WaterQualityParameterConfig, {
          where: { tenantId },
          order: { id: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        });
        const byCode = new Map(existing.map((config) => [config.code, config]));
        const toSave: WaterQualityParameterConfig[] = [];
        for (const param of template.parameters) {
          const mapped = this.mapTemplateEntryToEntity(param, tenantId, templateId);
          const current = byCode.get(param.code);
          // A bound channel was accepted for this unit: the template may not
          // change it underneath (plan Q8).
          if (
            current !== undefined &&
            unitMeaningChanged(current, current.unit, param.unit) &&
            (await liveChannelSourceCount(queryRunner.manager, tenantId, current.id)) > 0
          ) {
            throw new ParameterSourceError(
              PARAMETER_SOURCE_ERROR.PARAMETER_BOUND,
              HttpStatus.CONFLICT,
              `Parameter '${current.code}' has a bound sensor channel; the template would change ` +
                `its unit from '${current.unit}' to '${mapped.unit}'. Unbind it first.`,
            );
          }
          // Recorded values are read in the config's unit: once a code has
          // measurements its unit is fixed (plan D7).
          if (
            current !== undefined &&
            unitMeaningChanged(current, current.unit, param.unit) &&
            (await parameterHasMeasurements(queryRunner.manager, tenantId, current.code))
          ) {
            throw new ParameterSourceError(
              PARAMETER_SOURCE_ERROR.PARAMETER_HAS_MEASUREMENTS,
              HttpStatus.CONFLICT,
              `Measurements already record '${current.code}' in ${current.unit}; the template ` +
                `would re-read them as '${mapped.unit}'. Create a new parameter instead.`,
            );
          }
          toSave.push(this.configRepository.create(current ? { ...current, ...mapped } : mapped));
        }
        return toSave.length > 0 ? queryRunner.manager.save(toSave) : [];
      }

      return additiveEntities.length > 0 ? queryRunner.manager.save(additiveEntities) : [];
    });

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
