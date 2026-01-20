import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { DashboardLayout } from './entities/dashboard-layout.entity';
import { SaveDashboardLayoutInput, CreateSystemDefaultLayoutInput } from './dto/dashboard-layout.dto';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @InjectRepository(DashboardLayout)
    private readonly dashboardLayoutRepository: Repository<DashboardLayout>,
  ) {}

  /**
   * Get all layouts for a user (personal layouts)
   */
  async getUserLayouts(tenantId: string, userId: string): Promise<DashboardLayout[]> {
    return this.dashboardLayoutRepository.find({
      where: { tenantId, userId },
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Get a single layout by ID
   */
  async getLayoutById(id: string, tenantId: string, userId: string): Promise<DashboardLayout> {
    const layout = await this.dashboardLayoutRepository.findOne({
      where: { id, tenantId },
    });

    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    // Users can access their own layouts and system defaults
    if (layout.userId && layout.userId !== userId) {
      throw new ForbiddenException('You do not have access to this layout');
    }

    return layout;
  }

  /**
   * Get user's default layout, or system default if none set
   */
  async getMyDefaultLayout(tenantId: string, userId: string): Promise<DashboardLayout | null> {
    // 1. Try user's personal default
    let layout = await this.dashboardLayoutRepository.findOne({
      where: { tenantId, userId, isDefault: true },
    });

    if (layout) {
      this.logger.debug(`Found user default layout: ${layout.name}`);
      return layout;
    }

    // 2. Fall back to tenant system default
    layout = await this.dashboardLayoutRepository.findOne({
      where: { tenantId, userId: IsNull(), isSystemDefault: true },
    });

    if (layout) {
      this.logger.debug(`Found system default layout: ${layout.name}`);
    }

    return layout;
  }

  /**
   * Get system default layout for tenant
   */
  async getSystemDefaultLayout(tenantId: string): Promise<DashboardLayout | null> {
    return this.dashboardLayoutRepository.findOne({
      where: { tenantId, userId: IsNull(), isSystemDefault: true },
    });
  }

  /**
   * Save (create or update) a dashboard layout
   */
  async saveLayout(
    input: SaveDashboardLayoutInput,
    tenantId: string,
    userId: string,
  ): Promise<DashboardLayout> {
    // If setting this as default, unset other defaults for this user
    if (input.isDefault) {
      await this.dashboardLayoutRepository.update(
        { tenantId, userId, isDefault: true },
        { isDefault: false },
      );
    }

    if (input.id) {
      // Update existing layout
      const existingLayout = await this.getLayoutById(input.id, tenantId, userId);

      // Update fields
      existingLayout.name = input.name;
      existingLayout.description = input.description;
      existingLayout.widgets = input.widgets;
      existingLayout.isDefault = input.isDefault ?? existingLayout.isDefault;

      const saved = await this.dashboardLayoutRepository.save(existingLayout);
      this.logger.log(`Updated layout: ${saved.name} (${saved.id})`);
      return saved;
    } else {
      // Create new layout
      const newLayout = this.dashboardLayoutRepository.create({
        ...input,
        tenantId,
        userId,
        createdBy: userId,
        isSystemDefault: false,
      });

      const saved = await this.dashboardLayoutRepository.save(newLayout);
      this.logger.log(`Created new layout: ${saved.name} (${saved.id})`);
      return saved;
    }
  }

  /**
   * Create or update system default layout (admin only)
   */
  async saveSystemDefaultLayout(
    input: CreateSystemDefaultLayoutInput,
    tenantId: string,
    userId: string,
  ): Promise<DashboardLayout> {
    // Check if system default already exists
    let systemDefault = await this.getSystemDefaultLayout(tenantId);

    if (systemDefault) {
      // Update existing system default
      systemDefault.name = input.name;
      systemDefault.description = input.description;
      systemDefault.widgets = input.widgets;

      const saved = await this.dashboardLayoutRepository.save(systemDefault);
      this.logger.log(`Updated system default layout: ${saved.name}`);
      return saved;
    } else {
      // Create new system default
      const newLayout = this.dashboardLayoutRepository.create({
        ...input,
        tenantId,
        userId: undefined, // null for system defaults
        createdBy: userId,
        isDefault: false,
        isSystemDefault: true,
      });

      const saved = await this.dashboardLayoutRepository.save(newLayout);
      this.logger.log(`Created system default layout: ${saved.name}`);
      return saved;
    }
  }

  /**
   * Set a layout as user's default
   */
  async setAsDefault(id: string, tenantId: string, userId: string): Promise<DashboardLayout> {
    const layout = await this.getLayoutById(id, tenantId, userId);

    // Unset other defaults for this user
    await this.dashboardLayoutRepository.update(
      { tenantId, userId, isDefault: true },
      { isDefault: false },
    );

    // Set this one as default
    layout.isDefault = true;
    const saved = await this.dashboardLayoutRepository.save(layout);

    this.logger.log(`Set layout ${saved.name} as default for user ${userId}`);
    return saved;
  }

  /**
   * Delete a layout
   */
  async deleteLayout(id: string, tenantId: string, userId: string): Promise<boolean> {
    const layout = await this.getLayoutById(id, tenantId, userId);

    // Cannot delete system defaults through this method
    if (layout.isSystemDefault) {
      throw new ForbiddenException('Cannot delete system default layout');
    }

    await this.dashboardLayoutRepository.remove(layout);
    this.logger.log(`Deleted layout: ${layout.name} (${id})`);
    return true;
  }

  /**
   * Create empty system default layout for new tenant
   * Called when tenant is created
   */
  async createEmptySystemDefault(tenantId: string): Promise<DashboardLayout> {
    const existing = await this.getSystemDefaultLayout(tenantId);
    if (existing) {
      return existing;
    }

    const layout = this.dashboardLayoutRepository.create({
      tenantId,
      userId: undefined,
      name: 'Varsayılan Dashboard',
      description: 'Tenant sistem varsayılanı',
      widgets: [],
      isDefault: false,
      isSystemDefault: true,
    });

    const saved = await this.dashboardLayoutRepository.save(layout);
    this.logger.log(`Created empty system default layout for tenant ${tenantId}`);
    return saved;
  }
}
