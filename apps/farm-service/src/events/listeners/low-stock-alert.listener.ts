/**
 * LowStockAlertListener
 *
 * Handles inventory low stock events and sends notifications:
 * - Processes the governed spare-parts low-stock event
 * - Sends notifications to relevant personnel
 * - Tracks stock alert history
 * - Suggests reorder quantities
 *
 * @module Events/Listeners
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { EventNames, InventoryLowStockEventPayload } from '../event-types';

/**
 * Stock alert configuration
 */
const CRITICAL_THRESHOLD_PERCENT = 10;

@Injectable()
export class LowStockAlertListener {
  private readonly logger = new Logger(LowStockAlertListener.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  /**
   * Handle inventory low stock event (spare parts)
   */
  @OnEvent(EventNames.LOW_STOCK_ALERT)
  async handleInventoryLowStock(payload: InventoryLowStockEventPayload): Promise<void> {
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
   * Process out of stock items
   */
  private async processOutOfStockItems(payload: InventoryLowStockEventPayload): Promise<void> {
    if (payload.outOfStock.length === 0) return;

    for (const item of payload.outOfStock) {
      this.logger.error(`[OUT_OF_STOCK] Part ${item.partNumber}: ${item.name}`);

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
  private async processLowStockItems(payload: InventoryLowStockEventPayload): Promise<void> {
    if (payload.lowStock.length === 0) return;

    for (const item of payload.lowStock) {
      const percentRemaining = item.minStock > 0 ? (item.quantity / item.minStock) * 100 : 0;

      const severity = percentRemaining < CRITICAL_THRESHOLD_PERCENT ? 'critical' : 'warning';

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
  private async sendInventoryNotification(payload: InventoryLowStockEventPayload): Promise<void> {
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
    this.logger.debug(`Checking for work orders dependent on part ${partId} (${partName})`);

    // In a real implementation, query work orders with this part in usedMaterials
    // and emit alerts for affected work orders
  }
}
