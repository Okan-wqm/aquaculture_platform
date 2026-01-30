/**
 * LowStockAlertListener
 *
 * Handles inventory low stock events and sends notifications:
 * - Processes low stock alerts for feeds, spare parts, and chemicals
 * - Sends notifications to relevant personnel
 * - Tracks stock alert history
 * - Suggests reorder quantities
 *
 * @module Events/Listeners
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Feed } from '../../feed/entities/feed.entity';
import { SparePart } from '../../maintenance/entities/spare-part.entity';
import {
  EventNames,
  LowStockAlertEventPayload,
  InventoryLowStockEventPayload,
  FeedingLowStockEventPayload,
  FeedingExpiryWarningEventPayload,
} from '../event-types';

/**
 * Stock alert configuration
 */
interface StockAlertConfig {
  criticalThresholdPercent: number;  // Below this is critical
  warningThresholdPercent: number;   // Below this is warning
  reorderDaysBuffer: number;         // Days of stock to maintain
}

const DEFAULT_CONFIG: StockAlertConfig = {
  criticalThresholdPercent: 10,
  warningThresholdPercent: 25,
  reorderDaysBuffer: 14,
};

@Injectable()
export class LowStockAlertListener {
  private readonly logger = new Logger(LowStockAlertListener.name);

  constructor(
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(SparePart)
    private readonly sparePartRepository: Repository<SparePart>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Handle inventory low stock event (spare parts)
   */
  @OnEvent(EventNames.LOW_STOCK_ALERT)
  async handleInventoryLowStock(
    payload: InventoryLowStockEventPayload,
  ): Promise<void> {
    this.logger.warn(
      `[InventoryLowStock] Processing alert for tenant ${payload.tenantId}: ` +
      `${payload.outOfStock.length} out of stock, ${payload.lowStock.length} low stock`,
    );

    try {
      // 1. Process out of stock items (critical)
      await this.processOutOfStockItems(payload);

      // 2. Process low stock items (warning)
      await this.processLowStockItems(payload);

      // 3. Send consolidated notification
      await this.sendInventoryNotification(payload);

      this.logger.log(
        `[InventoryLowStock] Successfully processed alerts for tenant ${payload.tenantId}`,
      );
    } catch (error) {
      this.logger.error(
        `[InventoryLowStock] Failed to process alerts: ${error}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Handle feeding low stock event (feed inventory)
   */
  @OnEvent(EventNames.FEEDING_LOW_STOCK)
  async handleFeedingLowStock(
    payload: FeedingLowStockEventPayload,
  ): Promise<void> {
    this.logger.warn(
      `[FeedingLowStock] ${payload.feeds.length} feeds are low on stock for tenant ${payload.tenantId}`,
    );

    try {
      for (const feed of payload.feeds) {
        const percentRemaining = feed.minStock > 0
          ? (feed.currentStock / feed.minStock) * 100
          : 0;

        const severity = percentRemaining < DEFAULT_CONFIG.criticalThresholdPercent
          ? 'critical'
          : 'warning';

        this.logger.warn(
          `[${severity.toUpperCase()}] Feed ${feed.feedName}: ` +
          `${feed.currentStock}kg remaining (min: ${feed.minStock}kg)`,
        );

        // Emit individual feed alert
        this.eventEmitter.emit('alert.feedLowStock', {
          tenantId: payload.tenantId,
          feedId: feed.feedId,
          feedName: feed.feedName,
          currentStock: feed.currentStock,
          minStock: feed.minStock,
          percentRemaining,
          severity,
        });
      }

      // Calculate suggested reorder quantities
      const reorderSuggestions = await this.calculateFeedReorderQuantities(
        payload.tenantId,
        payload.feeds,
      );

      // Send notification
      this.eventEmitter.emit('notification.send', {
        tenantId: payload.tenantId,
        type: 'feed_low_stock',
        priority: payload.feeds.some((f) => f.currentStock <= 0) ? 'high' : 'normal',
        title: `Low Feed Stock Alert: ${payload.feeds.length} items`,
        message: this.buildFeedAlertMessage(payload.feeds),
        data: {
          feeds: payload.feeds,
          reorderSuggestions,
        },
      });
    } catch (error) {
      this.logger.error(
        `[FeedingLowStock] Failed to process alert: ${error}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Handle feed expiry warning event
   */
  @OnEvent(EventNames.FEEDING_EXPIRY_WARNING)
  async handleFeedingExpiryWarning(
    payload: FeedingExpiryWarningEventPayload,
  ): Promise<void> {
    this.logger.warn(
      `[FeedingExpiryWarning] ${payload.feeds.length} feeds expiring within ` +
      `${payload.daysUntilExpiry} days for tenant ${payload.tenantId}`,
    );

    try {
      for (const feed of payload.feeds) {
        const expiryDate = new Date(feed.expiryDate);
        const daysRemaining = Math.ceil(
          (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        );

        const severity = daysRemaining <= 3 ? 'critical' : 'warning';

        this.logger.warn(
          `[${severity.toUpperCase()}] Feed ${feed.feedName} expires in ${daysRemaining} days ` +
          `(${feed.quantity}kg remaining)`,
        );

        // Emit individual expiry alert
        this.eventEmitter.emit('alert.feedExpiring', {
          tenantId: payload.tenantId,
          feedId: feed.feedId,
          feedName: feed.feedName,
          expiryDate: feed.expiryDate,
          quantity: feed.quantity,
          daysRemaining,
          severity,
        });
      }

      // Send notification
      this.eventEmitter.emit('notification.send', {
        tenantId: payload.tenantId,
        type: 'feed_expiry_warning',
        priority: payload.feeds.some((f) => {
          const days = Math.ceil(
            (new Date(f.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
          );
          return days <= 3;
        }) ? 'high' : 'normal',
        title: `Feed Expiry Warning: ${payload.feeds.length} items`,
        message: `${payload.feeds.length} feed items will expire within ${payload.daysUntilExpiry} days. ` +
          `Total quantity at risk: ${payload.feeds.reduce((sum, f) => sum + f.quantity, 0).toFixed(1)}kg`,
        data: {
          feeds: payload.feeds,
          daysUntilExpiry: payload.daysUntilExpiry,
        },
      });
    } catch (error) {
      this.logger.error(
        `[FeedingExpiryWarning] Failed to process alert: ${error}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Process out of stock items
   */
  private async processOutOfStockItems(
    payload: InventoryLowStockEventPayload,
  ): Promise<void> {
    if (payload.outOfStock.length === 0) return;

    for (const item of payload.outOfStock) {
      this.logger.error(
        `[OUT_OF_STOCK] Part ${item.partNumber}: ${item.name}`,
      );

      // Emit individual critical alert
      this.eventEmitter.emit('alert.inventoryOutOfStock', {
        tenantId: payload.tenantId,
        partId: item.id,
        partNumber: item.partNumber,
        name: item.name,
        category: item.category,
        severity: 'critical',
      });

      // Check if there are pending work orders that need this part
      await this.checkDependentWorkOrders(payload.tenantId, item.id, item.name);
    }
  }

  /**
   * Process low stock items
   */
  private async processLowStockItems(
    payload: InventoryLowStockEventPayload,
  ): Promise<void> {
    if (payload.lowStock.length === 0) return;

    for (const item of payload.lowStock) {
      const percentRemaining = item.minStock > 0
        ? (item.quantity / item.minStock) * 100
        : 0;

      const severity = percentRemaining < DEFAULT_CONFIG.criticalThresholdPercent
        ? 'critical'
        : 'warning';

      this.logger.warn(
        `[LOW_STOCK] Part ${item.partNumber}: ${item.name} - ` +
        `${item.quantity} remaining (min: ${item.minStock})`,
      );

      // Emit individual low stock alert
      this.eventEmitter.emit('alert.inventoryLowStock', {
        tenantId: payload.tenantId,
        partId: item.id,
        partNumber: item.partNumber,
        name: item.name,
        category: item.category,
        quantity: item.quantity,
        minStock: item.minStock,
        percentRemaining,
        severity,
      });
    }
  }

  /**
   * Send consolidated inventory notification
   */
  private async sendInventoryNotification(
    payload: InventoryLowStockEventPayload,
  ): Promise<void> {
    const totalItems = payload.outOfStock.length + payload.lowStock.length;
    if (totalItems === 0) return;

    const priority = payload.outOfStock.length > 0 ? 'high' : 'normal';

    let message = '';
    if (payload.outOfStock.length > 0) {
      message += `${payload.outOfStock.length} items are OUT OF STOCK. `;
    }
    if (payload.lowStock.length > 0) {
      message += `${payload.lowStock.length} items are running low.`;
    }

    this.eventEmitter.emit('notification.send', {
      tenantId: payload.tenantId,
      type: 'inventory_low_stock',
      priority,
      title: `Inventory Alert: ${totalItems} items need attention`,
      message: message.trim(),
      data: {
        outOfStock: payload.outOfStock,
        lowStock: payload.lowStock,
      },
    });

    // Emit procurement suggestion event
    if (payload.outOfStock.length > 0 || payload.lowStock.length > 0) {
      const itemsToReorder = [
        ...payload.outOfStock.map((item) => ({
          id: item.id,
          name: item.name,
          partNumber: item.partNumber,
          currentQuantity: 0,
          suggestedQuantity: 10, // Default suggestion
          priority: 'critical' as const,
        })),
        ...payload.lowStock.map((item) => ({
          id: item.id,
          name: item.name,
          partNumber: item.partNumber,
          currentQuantity: item.quantity,
          suggestedQuantity: item.minStock * 2,
          priority: 'normal' as const,
        })),
      ];

      this.eventEmitter.emit('procurement.reorderSuggested', {
        tenantId: payload.tenantId,
        type: 'spare_parts',
        items: itemsToReorder,
        suggestedAt: new Date(),
      });
    }
  }

  /**
   * Check for work orders that depend on out-of-stock parts
   */
  private async checkDependentWorkOrders(
    tenantId: string,
    partId: string,
    partName: string,
  ): Promise<void> {
    // This would query work orders that list this part in their materials
    // For now, just log the check
    this.logger.debug(
      `Checking for work orders dependent on part ${partId} (${partName})`,
    );

    // In a real implementation, query work orders with this part in usedMaterials
    // and emit alerts for affected work orders
  }

  /**
   * Calculate feed reorder quantities based on consumption
   */
  private async calculateFeedReorderQuantities(
    tenantId: string,
    feeds: FeedingLowStockEventPayload['feeds'],
  ): Promise<Array<{ feedId: string; feedName: string; suggestedQuantity: number }>> {
    const suggestions: Array<{
      feedId: string;
      feedName: string;
      suggestedQuantity: number;
    }> = [];

    for (const feed of feeds) {
      // Simple calculation: reorder enough to reach 3x minimum stock
      const suggestedQuantity = Math.max(
        0,
        feed.minStock * 3 - feed.currentStock,
      );

      suggestions.push({
        feedId: feed.feedId,
        feedName: feed.feedName,
        suggestedQuantity: Math.ceil(suggestedQuantity),
      });
    }

    return suggestions;
  }

  /**
   * Build feed alert message
   */
  private buildFeedAlertMessage(
    feeds: FeedingLowStockEventPayload['feeds'],
  ): string {
    const outOfStock = feeds.filter((f) => f.currentStock <= 0);
    const lowStock = feeds.filter((f) => f.currentStock > 0);

    let message = '';

    if (outOfStock.length > 0) {
      message += `OUT OF STOCK: ${outOfStock.map((f) => f.feedName).join(', ')}. `;
    }

    if (lowStock.length > 0) {
      message += `Low stock: ${lowStock.map((f) => `${f.feedName} (${f.currentStock}/${f.minStock}kg)`).join(', ')}`;
    }

    return message.trim();
  }
}
