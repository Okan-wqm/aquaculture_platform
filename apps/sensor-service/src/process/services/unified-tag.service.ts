import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike, In, QueryFailedError } from 'typeorm';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

import { DeviceIoConfig, IoType, IoDataType } from '../../edge-device/entities/device-io-config.entity';
import { EdgeDevice } from '../../edge-device/entities/edge-device.entity';

import {
  CreateTagInput,
  UpdateTagInput,
  TagFilterInput,
} from '../dto/unified-tag.dto';
import { ProcessPaginationInput } from '../dto/process.dto';
import { Process } from '../entities/process.entity';
import {
  UnifiedTag,
  TagIoType,
  TagDataType,
  TagDirection,
  TagSource,
  TagHierarchy,
} from '../entities/unified-tag.entity';

/**
 * Convert an optional numeric column to `number | undefined`, PRESERVING zero.
 * A truthiness guard (`v ? Number(v) : undefined`) silently drops legitimate
 * zero-valued engineering ranges and alarm limits (e.g. a 0-100% level sensor's
 * engMin=0, or a low-low alarm at 0), which the edge then never enforces.
 */
function numberOrUndefined(value: number | null | undefined): number | undefined {
  return value != null ? Number(value) : undefined;
}

@Injectable()
export class UnifiedTagService {
  private readonly logger = new Logger(UnifiedTagService.name);

  constructor(
    @InjectRepository(UnifiedTag)
    private readonly tagRepository: Repository<UnifiedTag>,
    @InjectRepository(DeviceIoConfig)
    private readonly ioConfigRepository: Repository<DeviceIoConfig>,
    @InjectRepository(EdgeDevice)
    private readonly edgeDeviceRepository: Repository<EdgeDevice>,
    @InjectRepository(Process)
    private readonly processRepository: Repository<Process>,
  ) {}

  async createTag(input: CreateTagInput, tenantId: string): Promise<UnifiedTag> {
    this.logger.log(`Creating tag "${input.fqn}" for tenant ${tenantId}`);
    const tag = this.tagRepository.create({
      ...input,
      tenantId,
    });
    try {
      return await this.tagRepository.save(tag);
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === '23505') {
        throw new ConflictException(`Tag with FQN "${input.fqn}" already exists for this tenant`);
      }
      throw error;
    }
  }

  async updateTag(id: string, input: UpdateTagInput, tenantId: string): Promise<UnifiedTag> {
    const tag = await this.tagRepository.findOne({ where: { id, tenantId } });
    if (!tag) throw new NotFoundException(`Tag ${id} not found`);

    if (input.fqn !== undefined) tag.fqn = input.fqn;
    if (input.localName !== undefined) tag.localName = input.localName;
    if (input.displayName !== undefined) tag.displayName = input.displayName;
    if (input.description !== undefined) tag.description = input.description;
    if (input.ioType !== undefined) tag.ioType = input.ioType;
    if (input.dataType !== undefined) tag.dataType = input.dataType;
    if (input.direction !== undefined) tag.direction = input.direction;
    if (input.engUnit !== undefined) tag.engUnit = input.engUnit;
    if (input.engMin !== undefined) tag.engMin = input.engMin;
    if (input.engMax !== undefined) tag.engMax = input.engMax;
    if (input.alarmHH !== undefined) tag.alarmHH = input.alarmHH;
    if (input.alarmH !== undefined) tag.alarmH = input.alarmH;
    if (input.alarmL !== undefined) tag.alarmL = input.alarmL;
    if (input.alarmLL !== undefined) tag.alarmLL = input.alarmLL;
    if (input.deadband !== undefined) tag.deadband = input.deadband;
    if (input.source !== undefined) tag.source = input.source as TagSource;
    if (input.hierarchy !== undefined) tag.hierarchy = input.hierarchy as TagHierarchy;

    // Every registry edit bumps the revision so binding snapshots can detect
    // that they were resolved against an older registry state.
    tag.revision += 1;

    return this.tagRepository.save(tag);
  }

  async getTag(id: string, tenantId: string): Promise<UnifiedTag | null> {
    return this.tagRepository.findOne({ where: { id, tenantId } });
  }

  async deleteTag(id: string, tenantId: string): Promise<boolean> {
    const tag = await this.tagRepository.findOne({ where: { id, tenantId } });
    if (!tag) throw new NotFoundException(`Tag ${id} not found`);
    await this.tagRepository.remove(tag);
    return true;
  }

  async listTags(
    tenantId: string,
    filter?: TagFilterInput,
    pagination?: ProcessPaginationInput,
  ): Promise<IStandardPaginatedResult<UnifiedTag>> {
    const page = pagination?.page || 1;
    const limit = Math.min(pagination?.limit || 20, 100);
    const offset = (page - 1) * limit;

    const qb = this.tagRepository
      .createQueryBuilder('tag')
      .where('tag.tenantId = :tenantId', { tenantId });

    if (filter?.ioType) {
      qb.andWhere('tag.ioType = :ioType', { ioType: filter.ioType });
    }
    if (filter?.dataType) {
      qb.andWhere('tag.dataType = :dataType', { dataType: filter.dataType });
    }
    if (filter?.direction) {
      qb.andWhere('tag.direction = :direction', { direction: filter.direction });
    }
    if (filter?.equipmentId) {
      qb.andWhere("tag.hierarchy->>'equipmentId' = :equipmentId", {
        equipmentId: filter.equipmentId,
      });
    }
    if (filter?.edgeDeviceId) {
      qb.andWhere("tag.source->>'edgeDeviceId' = :edgeDeviceId", {
        edgeDeviceId: filter.edgeDeviceId,
      });
    }
    if (filter?.searchTerm) {
      const escapedSearch = filter.searchTerm.replace(/[%_]/g, '\\$&');
      qb.andWhere('(tag.fqn ILIKE :search OR tag.displayName ILIKE :search)', {
        search: `%${escapedSearch}%`,
      });
    }

    qb.orderBy('tag.fqn', 'ASC').skip(offset).take(limit);

    const [items, total] = await qb.getManyAndCount();
    return createStandardPaginatedResult(items, total, page, limit);
  }

  /**
   * Search tags by FQN or displayName (ILIKE)
   */
  async tagSearch(query: string, tenantId: string, limit = 50): Promise<UnifiedTag[]> {
    const escapedQuery = query.replace(/[%_]/g, '\\$&');
    return this.tagRepository
      .createQueryBuilder('tag')
      .where('tag.tenantId = :tenantId', { tenantId })
      .andWhere('(tag.fqn ILIKE :query OR tag.displayName ILIKE :query)', {
        query: `%${escapedQuery}%`,
      })
      .orderBy('tag.fqn', 'ASC')
      .take(Math.min(limit, 200))
      .getMany();
  }

  /**
   * Discover tags from DeviceIoConfig entries for a given edge device.
   * Creates UnifiedTag entries for each I/O config that doesn't already have one.
   */
  async discoverTags(
    deviceId: string,
    tenantId: string,
  ): Promise<{ discoveredCount: number; createdCount: number; tags: UnifiedTag[] }> {
    this.logger.log(`Discovering tags from device ${deviceId} for tenant ${tenantId}`);

    const device = await this.edgeDeviceRepository.findOne({
      where: { id: deviceId, tenantId },
    });
    if (!device) throw new NotFoundException(`Edge device ${deviceId} not found`);

    // DeviceIoConfig has no tenantId - device ownership already verified above
    const ioConfigs = await this.ioConfigRepository.find({
      where: { deviceId },
    });

    const discoveredCount = ioConfigs.length;

    // Batch: collect all FQNs and fetch existing tags in one query
    const fqns = ioConfigs.map(io => `${device.deviceCode}/${io.tagName}`);
    const existingTags = fqns.length > 0
      ? await this.tagRepository.find({ where: { tenantId, fqn: In(fqns) } })
      : [];
    const existingFqnMap = new Map(existingTags.map(t => [t.fqn, t]));

    const newTags: UnifiedTag[] = [];

    for (const io of ioConfigs) {
      const fqn = `${device.deviceCode}/${io.tagName}`;
      if (existingFqnMap.has(fqn)) continue;

      newTags.push(this.tagRepository.create({
        tenantId,
        fqn,
        localName: io.tagName,
        displayName: io.description || io.tagName,
        ioType: this.mapIoType(io.ioType),
        dataType: this.mapDataType(io.dataType),
        direction: this.inferDirection(io.ioType),
        engUnit: io.engUnit,
        engMin: numberOrUndefined(io.engMin),
        engMax: numberOrUndefined(io.engMax),
        alarmHH: numberOrUndefined(io.alarmHH),
        alarmH: numberOrUndefined(io.alarmH),
        alarmL: numberOrUndefined(io.alarmL),
        alarmLL: numberOrUndefined(io.alarmLL),
        deadband: numberOrUndefined(io.deadband),
        source: {
          type: 'edge_device',
          edgeDeviceId: deviceId,
          ioConfigId: io.id,
        },
        hierarchy: {},
      }));
    }

    if (newTags.length > 0) {
      // ON CONFLICT DO NOTHING: a concurrent discovery of the same device (or a
      // re-run) races on the unique (tenantId, fqn) index. A plain bulk save
      // throws 23505 and rolls back the WHOLE batch; orIgnore skips only the
      // rows another transaction already created, so discovery is idempotent
      // and concurrent-safe (BE-004).
      await this.tagRepository
        .createQueryBuilder()
        .insert()
        .into(UnifiedTag)
        .values(newTags)
        .orIgnore()
        .execute();
    }

    // Re-read the full set by fqn so the result reflects rows persisted here AND
    // any that a concurrent discovery won the insert race for (our orIgnore then
    // skipped). This is also what gives the newly-inserted rows their ids.
    const tags = fqns.length > 0
      ? await this.tagRepository.find({ where: { tenantId, fqn: In(fqns) } })
      : [];
    const createdCount = Math.max(0, tags.length - existingTags.length);
    this.logger.log(`Discovered ${discoveredCount} I/O configs, created ${createdCount} new tags`);
    return { discoveredCount, createdCount, tags };
  }

  /**
   * Auto-bind tags to process nodes based on equipment assignments.
   * Matches equipment codes in process nodes to discovered tags' FQN hierarchy.
   */
  async autoBindTags(
    processId: string,
    deviceId: string,
    tenantId: string,
  ): Promise<{ discoveredCount: number; createdCount: number; tags: UnifiedTag[] }> {
    this.logger.log(`Auto-binding tags for process ${processId}, device ${deviceId}`);

    const process = await this.processRepository.findOne({
      where: { id: processId, tenantId },
    });
    if (!process) throw new NotFoundException(`Process ${processId} not found`);

    // First discover all tags from the device
    const discovery = await this.discoverTags(deviceId, tenantId);

    // Extract equipment info from process nodes
    const equipmentNodes = (process.nodes || []).filter(
      (n) => n.data?.equipmentId || n.data?.equipmentCode,
    );

    // Update hierarchy on tags whose local-name equipment segment EXACTLY
    // matches the node's equipment code. The previous infix substring match
    // (`fqn.includes(code)`) bound unrelated tags whenever one equipment code
    // was a substring of another (e.g. "tank1" matched "tank10.temp").
    const modifiedTags: UnifiedTag[] = [];
    for (const node of equipmentNodes) {
      const code = node.data.equipmentCode;
      if (!code) continue;

      const codeLower = code.toLowerCase();
      const matchingTags = discovery.tags.filter((t) => {
        const local = t.localName.toLowerCase();
        return local === codeLower || local.startsWith(`${codeLower}.`);
      });

      for (const tag of matchingTags) {
        tag.hierarchy = {
          ...tag.hierarchy,
          equipmentId: node.data.equipmentId,
          equipmentCode: node.data.equipmentCode,
        };
        modifiedTags.push(tag);
      }
    }

    if (modifiedTags.length > 0) {
      await this.tagRepository.save(modifiedTags);
    }

    return discovery;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private mapIoType(ioType: IoType): TagIoType {
    const map: Record<IoType, TagIoType> = {
      [IoType.DI]: TagIoType.DI,
      [IoType.DO]: TagIoType.DO,
      [IoType.AI]: TagIoType.AI,
      [IoType.AO]: TagIoType.AO,
    };
    return map[ioType];
  }

  private mapDataType(dataType: IoDataType): TagDataType {
    const map: Record<IoDataType, TagDataType> = {
      [IoDataType.BOOL]: TagDataType.BOOL,
      [IoDataType.INT16]: TagDataType.INT16,
      [IoDataType.INT32]: TagDataType.INT32,
      [IoDataType.UINT16]: TagDataType.UINT16,
      [IoDataType.UINT32]: TagDataType.UINT32,
      [IoDataType.FLOAT32]: TagDataType.FLOAT32,
      [IoDataType.FLOAT64]: TagDataType.FLOAT64,
    };
    return map[dataType];
  }

  private inferDirection(ioType: IoType): TagDirection {
    switch (ioType) {
      case IoType.DI:
      case IoType.AI:
        return TagDirection.INPUT;
      case IoType.DO:
      case IoType.AO:
        return TagDirection.OUTPUT;
      default:
        return TagDirection.INPUT;
    }
  }
}
