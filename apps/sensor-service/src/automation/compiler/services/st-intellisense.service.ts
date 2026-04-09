import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UnifiedTag } from '../../../process/entities/unified-tag.entity';
import { AutomationProgram, ProgramType } from '../../entities/automation-program.entity';
import { ProgramVariable } from '../../entities/program-variable.entity';
import { CompletionEntry } from '../compiler.types';

/**
 * ST IntelliSense Service
 *
 * Provides dynamic completion items from database:
 * - SCADA tags (UnifiedTag)
 * - Function Block definitions from existing programs
 * - Program variables for a specific program
 */
@Injectable()
export class STIntellisenseService {
  private readonly logger = new Logger(STIntellisenseService.name);

  constructor(
    @InjectRepository(UnifiedTag)
    private readonly tagRepo: Repository<UnifiedTag>,
    @InjectRepository(AutomationProgram)
    private readonly programRepo: Repository<AutomationProgram>,
    @InjectRepository(ProgramVariable)
    private readonly variableRepo: Repository<ProgramVariable>,
  ) {}

  /**
   * Get SCADA tag completions for a tenant.
   * Maps UnifiedTag entries to CompletionEntry items.
   */
  async getTagCompletions(tenantId: string): Promise<CompletionEntry[]> {
    try {
      const tags = await this.tagRepo.find({
        where: { tenantId },
        select: ['id', 'fqn', 'description', 'dataType', 'ioType', 'engUnit'],
        take: 500,
      });

      return tags.map((tag) => ({
        label: tag.fqn,
        kind: 'tag' as const,
        detail: `${tag.ioType || 'TAG'} : ${tag.dataType || 'REAL'}`,
        documentation: [
          tag.description,
          tag.engUnit ? `Unit: ${tag.engUnit}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        insertText: tag.fqn,
        sortOrder: 50,
      }));
    } catch (error) {
      this.logger.warn(
        `Failed to load tag completions for tenant ${tenantId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Get Function Block definitions from existing programs.
   * Scans FUNCTION_BLOCK type programs for the tenant.
   */
  async getFBDefinitions(tenantId: string): Promise<CompletionEntry[]> {
    try {
      const fbPrograms = await this.programRepo.find({
        where: { tenantId, programType: ProgramType.FBD },
        select: ['id', 'programCode', 'programName', 'description'],
        take: 100,
      });

      return fbPrograms.map((fb) => ({
        label: fb.programCode,
        kind: 'functionBlock' as const,
        detail: fb.programName,
        documentation: fb.description || '',
        insertText: fb.programCode,
        sortOrder: 30,
      }));
    } catch (error) {
      this.logger.warn(
        `Failed to load FB definitions for tenant ${tenantId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Get program variables for a specific program.
   */
  async getProgramVariables(
    programId: string,
    tenantId: string,
  ): Promise<CompletionEntry[]> {
    try {
      const variables = await this.variableRepo.find({
        where: { programId },
        select: [
          'id',
          'varName',
          'displayName',
          'description',
          'dataType',
          'scope',
        ],
        order: { varOrder: 'ASC' },
      });

      return variables.map((v) => ({
        label: v.varName,
        kind: 'variable' as const,
        detail: `${v.scope} : ${v.dataType}`,
        documentation: v.description || v.displayName || '',
        insertText: v.varName,
        sortOrder: 10,
      }));
    } catch (error) {
      this.logger.warn(
        `Failed to load variables for program ${programId}: ${(error as Error).message}`,
      );
      return [];
    }
  }
}
