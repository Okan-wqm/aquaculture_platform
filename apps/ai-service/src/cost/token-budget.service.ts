import { Injectable, Logger } from '@nestjs/common';

/**
 * Token budget management using Redis counters.
 * Tracks monthly token usage per tenant and enforces limits.
 *
 * NOTE: Uses in-memory counters as placeholder.
 * Will be replaced with Redis when ioredis is wired up.
 */
@Injectable()
export class TokenBudgetService {
  private readonly logger = new Logger(TokenBudgetService.name);
  // In-memory fallback (replaced with Redis in production)
  private readonly counters = new Map<string, number>();

  private getMonthlyKey(tenantId: string): string {
    const now = new Date();
    return `ai:tokens:${tenantId}:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  async getUsage(tenantId: string): Promise<number> {
    const key = this.getMonthlyKey(tenantId);
    return this.counters.get(key) ?? 0;
  }

  async addUsage(tenantId: string, tokens: number): Promise<number> {
    const key = this.getMonthlyKey(tenantId);
    const current = this.counters.get(key) ?? 0;
    const newValue = current + tokens;
    this.counters.set(key, newValue);
    return newValue;
  }

  async checkBudget(
    tenantId: string,
    budget: number,
  ): Promise<{ allowed: boolean; used: number; remaining: number }> {
    const used = await this.getUsage(tenantId);
    const remaining = Math.max(0, budget - used);
    return {
      allowed: used < budget,
      used,
      remaining,
    };
  }
}
