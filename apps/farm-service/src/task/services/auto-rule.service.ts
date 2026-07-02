/**
 * AutoRule Service
 *
 * Otomatik kural CRUD yönetimi.
 * Tetikleyici koşullara göre otomatik görev oluşturma kurallarının
 * oluşturulması, güncellenmesi, silinmesi ve aktif/pasif yönetimi.
 *
 * @module Task/Services
 */
import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AutoRule } from '../entities/auto-rule.entity';

@Injectable()
export class AutoRuleService {
  private readonly logger = new Logger(AutoRuleService.name);

  constructor(
    @InjectRepository(AutoRule)
    private readonly autoRuleRepository: Repository<AutoRule>,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * ID ile otomatik kural bulur (internal write-path helper; the GraphQL
   * autoRule(id) read goes through GetAutoRuleHandler).
   */
  async findById(tenantId: string, id: string): Promise<AutoRule> {
    const rule = await this.autoRuleRepository.findOne({
      where: { id, tenantId },
    });

    if (!rule) {
      throw new NotFoundException(`Otomatik kural bulunamadı: ${id}`);
    }

    return rule;
  }

  /**
   * Yeni otomatik kural oluşturur
   */
  async create(
    tenantId: string,
    input: Partial<AutoRule>,
  ): Promise<AutoRule> {
    this.logger.log(`Creating auto rule "${input.name}" for tenant ${tenantId}`);

    const rule = this.autoRuleRepository.create({
      ...input,
      tenantId,
      isActive: input.isActive !== undefined ? input.isActive : true,
      triggerCount: 0,
    });

    return this.autoRuleRepository.save(rule);
  }

  /**
   * Otomatik kuralı günceller
   */
  async update(
    tenantId: string,
    id: string,
    input: Partial<AutoRule>,
  ): Promise<AutoRule> {
    const rule = await this.findById(tenantId, id);

    // Strip immutable/system fields to prevent accidental overwrite
    const { id: _id, tenantId: _tid, createdAt: _ca, updatedAt: _ua, triggerCount: _tc, lastTriggered: _lt, ...safeInput } = input;
    Object.assign(rule, safeInput);

    return this.autoRuleRepository.save(rule);
  }

  /**
   * Otomatik kuralı aktif/pasif yapar
   */
  async toggleActive(tenantId: string, id: string): Promise<AutoRule> {
    const rule = await this.findById(tenantId, id);
    rule.isActive = !rule.isActive;

    return this.autoRuleRepository.save(rule);
  }

  /**
   * Otomatik kuralı siler
   */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const rule = await this.findById(tenantId, id);
    await this.autoRuleRepository.remove(rule);
    return true;
  }
}
