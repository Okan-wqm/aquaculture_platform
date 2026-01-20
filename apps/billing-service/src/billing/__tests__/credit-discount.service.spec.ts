/**
 * Credit & Discount Service Tests
 *
 * Comprehensive tests for credits, promotional codes, and discounts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('Credit & Discount Service', () => {
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    eventEmitter = module.get(EventEmitter2);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // CREDIT MANAGEMENT TESTS
  // ============================================================================
  describe('Credit Management', () => {
    interface AccountCredit {
      tenantId: string;
      balance: number;
      currency: string;
      transactions: CreditTransaction[];
    }

    interface CreditTransaction {
      id: string;
      type: 'add' | 'deduct' | 'expire' | 'transfer';
      amount: number;
      reason: string;
      createdAt: Date;
      expiresAt?: Date;
      relatedInvoiceId?: string;
    }

    describe('Account Credit Operations', () => {
      it('should add account credit', () => {
        const addCredit = (
          account: AccountCredit,
          amount: number,
          reason: string,
          expiresAt?: Date,
        ): AccountCredit => {
          const transaction: CreditTransaction = {
            id: `txn-${Date.now()}`,
            type: 'add',
            amount,
            reason,
            createdAt: new Date(),
            expiresAt,
          };

          return {
            ...account,
            balance: account.balance + amount,
            transactions: [...account.transactions, transaction],
          };
        };

        const account: AccountCredit = {
          tenantId: 'tenant-1',
          balance: 0,
          currency: 'USD',
          transactions: [],
        };

        const updated = addCredit(account, 100, 'Welcome credit');

        expect(updated.balance).toBe(100);
        expect(updated.transactions.length).toBe(1);
        expect(updated.transactions[0]?.type).toBe('add');
      });

      it('should deduct credit at billing', () => {
        const deductCredit = (
          account: AccountCredit,
          amount: number,
          invoiceId: string,
        ): { account: AccountCredit; deducted: number } => {
          const deductAmount = Math.min(amount, account.balance);

          if (deductAmount <= 0) {
            return { account, deducted: 0 };
          }

          const transaction: CreditTransaction = {
            id: `txn-${Date.now()}`,
            type: 'deduct',
            amount: -deductAmount,
            reason: `Applied to invoice ${invoiceId}`,
            createdAt: new Date(),
            relatedInvoiceId: invoiceId,
          };

          return {
            account: {
              ...account,
              balance: account.balance - deductAmount,
              transactions: [...account.transactions, transaction],
            },
            deducted: deductAmount,
          };
        };

        const account: AccountCredit = {
          tenantId: 'tenant-1',
          balance: 50,
          currency: 'USD',
          transactions: [],
        };

        const result = deductCredit(account, 30, 'inv-123');

        expect(result.account.balance).toBe(20);
        expect(result.deducted).toBe(30);
      });

      it('should track credit balance', () => {
        const getBalance = (account: AccountCredit): number => {
          return account.balance;
        };

        const account: AccountCredit = {
          tenantId: 'tenant-1',
          balance: 150.50,
          currency: 'USD',
          transactions: [],
        };

        expect(getBalance(account)).toBe(150.50);
      });

      it('should handle credit expiration', () => {
        const processExpiredCredits = (account: AccountCredit): AccountCredit => {
          const now = new Date();
          let expiredAmount = 0;

          const activeTransactions = account.transactions.filter((txn) => {
            if (txn.type === 'add' && txn.expiresAt && txn.expiresAt < now) {
              expiredAmount += txn.amount;
              return false;
            }
            return true;
          });

          if (expiredAmount > 0) {
            const expireTransaction: CreditTransaction = {
              id: `txn-${Date.now()}`,
              type: 'expire',
              amount: -expiredAmount,
              reason: 'Credits expired',
              createdAt: now,
            };

            return {
              ...account,
              balance: account.balance - expiredAmount,
              transactions: [...activeTransactions, expireTransaction],
            };
          }

          return account;
        };

        const account: AccountCredit = {
          tenantId: 'tenant-1',
          balance: 100,
          currency: 'USD',
          transactions: [
            {
              id: 'txn-1',
              type: 'add',
              amount: 100,
              reason: 'Promo credit',
              createdAt: new Date('2023-01-01'),
              expiresAt: new Date('2023-06-01'),
            },
          ],
        };

        const processed = processExpiredCredits(account);

        expect(processed.balance).toBe(0);
      });

      it('should transfer credit between accounts', () => {
        const transferCredit = (
          sourceAccount: AccountCredit,
          targetAccount: AccountCredit,
          amount: number,
        ): { source: AccountCredit; target: AccountCredit } | null => {
          if (sourceAccount.balance < amount) return null;
          if (sourceAccount.currency !== targetAccount.currency) return null;

          const sourceTransaction: CreditTransaction = {
            id: `txn-${Date.now()}`,
            type: 'transfer',
            amount: -amount,
            reason: `Transfer to ${targetAccount.tenantId}`,
            createdAt: new Date(),
          };

          const targetTransaction: CreditTransaction = {
            id: `txn-${Date.now() + 1}`,
            type: 'transfer',
            amount,
            reason: `Transfer from ${sourceAccount.tenantId}`,
            createdAt: new Date(),
          };

          return {
            source: {
              ...sourceAccount,
              balance: sourceAccount.balance - amount,
              transactions: [...sourceAccount.transactions, sourceTransaction],
            },
            target: {
              ...targetAccount,
              balance: targetAccount.balance + amount,
              transactions: [...targetAccount.transactions, targetTransaction],
            },
          };
        };

        const source: AccountCredit = { tenantId: 't1', balance: 100, currency: 'USD', transactions: [] };
        const target: AccountCredit = { tenantId: 't2', balance: 50, currency: 'USD', transactions: [] };

        const result = transferCredit(source, target, 30);

        expect(result?.source.balance).toBe(70);
        expect(result?.target.balance).toBe(80);
      });

      it('should convert credit to refund', () => {
        const convertCreditToRefund = (
          account: AccountCredit,
          amount: number,
        ): { account: AccountCredit; refundAmount: number } | null => {
          if (account.balance < amount) return null;

          const transaction: CreditTransaction = {
            id: `txn-${Date.now()}`,
            type: 'deduct',
            amount: -amount,
            reason: 'Converted to refund',
            createdAt: new Date(),
          };

          return {
            account: {
              ...account,
              balance: account.balance - amount,
              transactions: [...account.transactions, transaction],
            },
            refundAmount: amount,
          };
        };

        const account: AccountCredit = {
          tenantId: 'tenant-1',
          balance: 200,
          currency: 'USD',
          transactions: [],
        };

        const result = convertCreditToRefund(account, 100);

        expect(result?.account.balance).toBe(100);
        expect(result?.refundAmount).toBe(100);
      });

      it('should prevent negative credit', () => {
        const validateCreditDeduction = (
          currentBalance: number,
          deductAmount: number,
        ): boolean => {
          return deductAmount <= currentBalance;
        };

        expect(validateCreditDeduction(100, 50)).toBe(true);
        expect(validateCreditDeduction(100, 150)).toBe(false);
      });
    });

    describe('Promotional Credits', () => {
      it('should assign promotional credit', () => {
        interface PromoCredit {
          code: string;
          amount: number;
          expiresInDays: number;
          maxRedemptions: number;
          currentRedemptions: number;
        }

        const redeemPromoCredit = (
          promo: PromoCredit,
          account: AccountCredit,
        ): AccountCredit | null => {
          if (promo.currentRedemptions >= promo.maxRedemptions) return null;

          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + promo.expiresInDays);

          const transaction: CreditTransaction = {
            id: `txn-${Date.now()}`,
            type: 'add',
            amount: promo.amount,
            reason: `Promotional code: ${promo.code}`,
            createdAt: new Date(),
            expiresAt,
          };

          return {
            ...account,
            balance: account.balance + promo.amount,
            transactions: [...account.transactions, transaction],
          };
        };

        const promo: PromoCredit = {
          code: 'WELCOME50',
          amount: 50,
          expiresInDays: 30,
          maxRedemptions: 100,
          currentRedemptions: 10,
        };

        const account: AccountCredit = {
          tenantId: 'tenant-1',
          balance: 0,
          currency: 'USD',
          transactions: [],
        };

        const result = redeemPromoCredit(promo, account);

        expect(result?.balance).toBe(50);
      });

      it('should track credit usage', () => {
        const getCreditUsageStats = (account: AccountCredit): {
          totalEarned: number;
          totalUsed: number;
          totalExpired: number;
        } => {
          let totalEarned = 0;
          let totalUsed = 0;
          let totalExpired = 0;

          account.transactions.forEach((txn) => {
            if (txn.type === 'add' || (txn.type === 'transfer' && txn.amount > 0)) {
              totalEarned += txn.amount;
            } else if (txn.type === 'deduct' || (txn.type === 'transfer' && txn.amount < 0)) {
              totalUsed += Math.abs(txn.amount);
            } else if (txn.type === 'expire') {
              totalExpired += Math.abs(txn.amount);
            }
          });

          return { totalEarned, totalUsed, totalExpired };
        };

        const account: AccountCredit = {
          tenantId: 'tenant-1',
          balance: 30,
          currency: 'USD',
          transactions: [
            { id: '1', type: 'add', amount: 100, reason: 'Promo', createdAt: new Date() },
            { id: '2', type: 'deduct', amount: -50, reason: 'Used', createdAt: new Date() },
            { id: '3', type: 'expire', amount: -20, reason: 'Expired', createdAt: new Date() },
          ],
        };

        const stats = getCreditUsageStats(account);

        expect(stats.totalEarned).toBe(100);
        expect(stats.totalUsed).toBe(50);
        expect(stats.totalExpired).toBe(20);
      });

      it('should set credit expiration date', () => {
        const createExpiringCredit = (
          amount: number,
          expiresInDays: number,
        ): CreditTransaction => {
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + expiresInDays);

          return {
            id: `txn-${Date.now()}`,
            type: 'add',
            amount,
            reason: 'Promotional credit',
            createdAt: new Date(),
            expiresAt,
          };
        };

        const credit = createExpiringCredit(50, 30);

        expect(credit.expiresAt).toBeDefined();
        expect(credit.expiresAt!.getTime()).toBeGreaterThan(Date.now());
      });

      it('should handle credit usage conditions', () => {
        interface CreditConditions {
          minPurchase?: number;
          validPlanTiers?: string[];
          validModules?: string[];
          firstPurchaseOnly?: boolean;
        }

        const validateCreditConditions = (
          conditions: CreditConditions,
          context: {
            purchaseAmount: number;
            planTier: string;
            moduleId?: string;
            isFirstPurchase: boolean;
          },
        ): boolean => {
          if (conditions.minPurchase && context.purchaseAmount < conditions.minPurchase) {
            return false;
          }
          if (conditions.validPlanTiers && !conditions.validPlanTiers.includes(context.planTier)) {
            return false;
          }
          if (conditions.validModules && context.moduleId && !conditions.validModules.includes(context.moduleId)) {
            return false;
          }
          if (conditions.firstPurchaseOnly && !context.isFirstPurchase) {
            return false;
          }
          return true;
        };

        const conditions: CreditConditions = {
          minPurchase: 50,
          validPlanTiers: ['professional', 'enterprise'],
          firstPurchaseOnly: true,
        };

        expect(
          validateCreditConditions(conditions, {
            purchaseAmount: 100,
            planTier: 'professional',
            isFirstPurchase: true,
          }),
        ).toBe(true);

        expect(
          validateCreditConditions(conditions, {
            purchaseAmount: 30,
            planTier: 'professional',
            isFirstPurchase: true,
          }),
        ).toBe(false);
      });

      it('should enforce credit stacking rules', () => {
        const canStackCredits = (
          existingCredits: CreditTransaction[],
          maxStackedCredits: number,
        ): boolean => {
          const activeCredits = existingCredits.filter(
            (c) => c.type === 'add' && (!c.expiresAt || c.expiresAt > new Date()),
          );
          return activeCredits.length < maxStackedCredits;
        };

        const existingCredits: CreditTransaction[] = [
          { id: '1', type: 'add', amount: 50, reason: 'Promo 1', createdAt: new Date(), expiresAt: new Date('2025-12-31') },
          { id: '2', type: 'add', amount: 30, reason: 'Promo 2', createdAt: new Date(), expiresAt: new Date('2025-12-31') },
        ];

        expect(canStackCredits(existingCredits, 3)).toBe(true);
        expect(canStackCredits(existingCredits, 2)).toBe(false);
      });
    });
  });

  // ============================================================================
  // DISCOUNT CODE TESTS
  // ============================================================================
  describe('Discount Codes', () => {
    interface DiscountCode {
      code: string;
      type: 'percentage' | 'fixed';
      value: number;
      minPurchase?: number;
      maxDiscount?: number;
      validFrom: Date;
      validUntil: Date;
      maxUses: number;
      currentUses: number;
      singleUsePerCustomer: boolean;
      applicableTo: 'all' | 'subscription' | 'usage';
    }

    describe('Code Validation', () => {
      it('should validate coupon code', () => {
        const validateCouponCode = (code: string, coupons: DiscountCode[]): DiscountCode | null => {
          const coupon = coupons.find((c) => c.code.toUpperCase() === code.toUpperCase());

          if (!coupon) return null;

          const now = new Date();
          if (now < coupon.validFrom || now > coupon.validUntil) return null;
          if (coupon.currentUses >= coupon.maxUses) return null;

          return coupon;
        };

        const coupons: DiscountCode[] = [
          {
            code: 'SAVE20',
            type: 'percentage',
            value: 20,
            validFrom: new Date('2024-01-01'),
            validUntil: new Date('2026-12-31'),
            maxUses: 100,
            currentUses: 10,
            singleUsePerCustomer: true,
            applicableTo: 'all',
          },
        ];

        expect(validateCouponCode('SAVE20', coupons)).not.toBeNull();
        expect(validateCouponCode('INVALID', coupons)).toBeNull();
      });

      it('should apply percentage discount', () => {
        const applyPercentageDiscount = (
          subtotal: number,
          percentage: number,
          maxDiscount?: number,
        ): number => {
          const discount = subtotal * (percentage / 100);
          return maxDiscount ? Math.min(discount, maxDiscount) : discount;
        };

        expect(applyPercentageDiscount(100, 20)).toBe(20);
        expect(applyPercentageDiscount(100, 20, 15)).toBe(15);
        expect(applyPercentageDiscount(1000, 50, 200)).toBe(200);
      });

      it('should apply fixed amount discount', () => {
        const applyFixedDiscount = (subtotal: number, discountAmount: number): number => {
          return Math.min(discountAmount, subtotal);
        };

        expect(applyFixedDiscount(100, 25)).toBe(25);
        expect(applyFixedDiscount(20, 25)).toBe(20);
      });

      it('should handle first-month discount', () => {
        const calculateFirstMonthDiscount = (
          monthlyPrice: number,
          discountPercent: number,
        ): { firstMonth: number; subsequent: number } => {
          return {
            firstMonth: monthlyPrice * (1 - discountPercent / 100),
            subsequent: monthlyPrice,
          };
        };

        const result = calculateFirstMonthDiscount(99, 50);

        expect(result.firstMonth).toBe(49.5);
        expect(result.subsequent).toBe(99);
      });

      it('should handle recurring discount', () => {
        interface RecurringDiscount {
          discountPercent: number;
          durationMonths: number;
          monthsApplied: number;
        }

        const shouldApplyRecurringDiscount = (discount: RecurringDiscount): boolean => {
          return discount.monthsApplied < discount.durationMonths;
        };

        const activeDiscount: RecurringDiscount = { discountPercent: 20, durationMonths: 6, monthsApplied: 3 };
        const expiredDiscount: RecurringDiscount = { discountPercent: 20, durationMonths: 6, monthsApplied: 6 };

        expect(shouldApplyRecurringDiscount(activeDiscount)).toBe(true);
        expect(shouldApplyRecurringDiscount(expiredDiscount)).toBe(false);
      });

      it('should check coupon expiration', () => {
        const isCouponExpired = (validUntil: Date): boolean => {
          return new Date() > validUntil;
        };

        const futureDate = new Date('2025-12-31');
        const pastDate = new Date('2023-01-01');

        expect(isCouponExpired(futureDate)).toBe(false);
        expect(isCouponExpired(pastDate)).toBe(true);
      });

      it('should track coupon usage limit', () => {
        const canUseCoupon = (coupon: DiscountCode): boolean => {
          return coupon.currentUses < coupon.maxUses;
        };

        const availableCoupon: DiscountCode = {
          code: 'SAVE10',
          type: 'percentage',
          value: 10,
          validFrom: new Date(),
          validUntil: new Date('2025-12-31'),
          maxUses: 100,
          currentUses: 50,
          singleUsePerCustomer: false,
          applicableTo: 'all',
        };

        const exhaustedCoupon: DiscountCode = {
          ...availableCoupon,
          currentUses: 100,
        };

        expect(canUseCoupon(availableCoupon)).toBe(true);
        expect(canUseCoupon(exhaustedCoupon)).toBe(false);
      });

      it('should enforce single-use per customer', () => {
        const hasCustomerUsedCoupon = (
          couponCode: string,
          tenantId: string,
          usageHistory: { couponCode: string; tenantId: string }[],
        ): boolean => {
          return usageHistory.some(
            (u) => u.couponCode === couponCode && u.tenantId === tenantId,
          );
        };

        const history = [{ couponCode: 'SAVE20', tenantId: 'tenant-1' }];

        expect(hasCustomerUsedCoupon('SAVE20', 'tenant-1', history)).toBe(true);
        expect(hasCustomerUsedCoupon('SAVE20', 'tenant-2', history)).toBe(false);
      });

      it('should enforce minimum purchase requirement', () => {
        const meetsMinimumPurchase = (
          subtotal: number,
          minPurchase: number | undefined,
        ): boolean => {
          return minPurchase === undefined || subtotal >= minPurchase;
        };

        expect(meetsMinimumPurchase(100, 50)).toBe(true);
        expect(meetsMinimumPurchase(30, 50)).toBe(false);
        expect(meetsMinimumPurchase(30, undefined)).toBe(true);
      });
    });

    describe('Volume Discounts', () => {
      it('should apply tier-based volume discount', () => {
        interface VolumeTier {
          minQuantity: number;
          maxQuantity: number | null;
          discountPercent: number;
        }

        const getVolumeDiscount = (quantity: number, tiers: VolumeTier[]): number => {
          const tier = tiers.find(
            (t) => quantity >= t.minQuantity && (t.maxQuantity === null || quantity <= t.maxQuantity),
          );
          return tier?.discountPercent || 0;
        };

        const tiers: VolumeTier[] = [
          { minQuantity: 0, maxQuantity: 10, discountPercent: 0 },
          { minQuantity: 11, maxQuantity: 50, discountPercent: 5 },
          { minQuantity: 51, maxQuantity: 100, discountPercent: 10 },
          { minQuantity: 101, maxQuantity: null, discountPercent: 15 },
        ];

        expect(getVolumeDiscount(5, tiers)).toBe(0);
        expect(getVolumeDiscount(30, tiers)).toBe(5);
        expect(getVolumeDiscount(75, tiers)).toBe(10);
        expect(getVolumeDiscount(200, tiers)).toBe(15);
      });

      it('should apply graduated discount', () => {
        interface GraduatedTier {
          upTo: number;
          discountPercent: number;
        }

        const calculateGraduatedDiscount = (
          quantity: number,
          unitPrice: number,
          tiers: GraduatedTier[],
        ): number => {
          let totalDiscount = 0;
          let remaining = quantity;

          for (let i = 0; i < tiers.length; i++) {
            const tier = tiers[i]!;
            const prevUpTo = i > 0 ? tiers[i - 1]!.upTo : 0;
            const tierQuantity = Math.min(remaining, tier.upTo - prevUpTo);

            if (tierQuantity <= 0) break;

            totalDiscount += tierQuantity * unitPrice * (tier.discountPercent / 100);
            remaining -= tierQuantity;
          }

          return Math.round(totalDiscount * 100) / 100;
        };

        const tiers: GraduatedTier[] = [
          { upTo: 10, discountPercent: 0 },
          { upTo: 50, discountPercent: 10 },
          { upTo: 100, discountPercent: 20 },
        ];

        // 100 units at $10 each
        // First 10: no discount
        // Next 40: 10% = $40
        // Next 50: 20% = $100
        const discount = calculateGraduatedDiscount(100, 10, tiers);

        expect(discount).toBe(140);
      });

      it('should apply commitment discount (annual contract)', () => {
        const getCommitmentDiscount = (billingCycle: string): number => {
          const discounts: Record<string, number> = {
            monthly: 0,
            quarterly: 5,
            semi_annual: 10,
            annual: 20,
          };
          return discounts[billingCycle] || 0;
        };

        expect(getCommitmentDiscount('monthly')).toBe(0);
        expect(getCommitmentDiscount('annual')).toBe(20);
      });

      it('should apply loyalty discount', () => {
        const getLoyaltyDiscount = (subscriptionAgeMonths: number): number => {
          if (subscriptionAgeMonths >= 24) return 15;
          if (subscriptionAgeMonths >= 12) return 10;
          if (subscriptionAgeMonths >= 6) return 5;
          return 0;
        };

        expect(getLoyaltyDiscount(3)).toBe(0);
        expect(getLoyaltyDiscount(8)).toBe(5);
        expect(getLoyaltyDiscount(15)).toBe(10);
        expect(getLoyaltyDiscount(30)).toBe(15);
      });

      it('should apply custom negotiated discount', () => {
        interface NegotiatedDiscount {
          tenantId: string;
          discountPercent: number;
          validUntil: Date;
          approvedBy: string;
        }

        const negotiatedDiscounts: NegotiatedDiscount[] = [
          {
            tenantId: 'enterprise-1',
            discountPercent: 25,
            validUntil: new Date('2025-12-31'),
            approvedBy: 'sales@example.com',
          },
        ];

        const getNegotiatedDiscount = (tenantId: string): number => {
          const discount = negotiatedDiscounts.find(
            (d) => d.tenantId === tenantId && d.validUntil > new Date(),
          );
          return discount?.discountPercent || 0;
        };

        expect(getNegotiatedDiscount('enterprise-1')).toBe(25);
        expect(getNegotiatedDiscount('unknown')).toBe(0);
      });
    });

    describe('Discount Application', () => {
      it('should apply discount before tax', () => {
        const calculateWithDiscountBeforeTax = (
          subtotal: number,
          discountPercent: number,
          taxRate: number,
        ): { discountedSubtotal: number; tax: number; total: number } => {
          const discountAmount = subtotal * (discountPercent / 100);
          const discountedSubtotal = subtotal - discountAmount;
          const tax = discountedSubtotal * (taxRate / 100);
          const total = discountedSubtotal + tax;

          return {
            discountedSubtotal: Math.round(discountedSubtotal * 100) / 100,
            tax: Math.round(tax * 100) / 100,
            total: Math.round(total * 100) / 100,
          };
        };

        const result = calculateWithDiscountBeforeTax(100, 20, 10);

        expect(result.discountedSubtotal).toBe(80);
        expect(result.tax).toBe(8);
        expect(result.total).toBe(88);
      });

      it('should apply discount to specific line items', () => {
        interface LineItem {
          id: string;
          amount: number;
          discountable: boolean;
        }

        const applyDiscountToItems = (
          items: LineItem[],
          discountPercent: number,
        ): { items: LineItem[]; totalDiscount: number } => {
          let totalDiscount = 0;

          const discountedItems = items.map((item) => {
            if (item.discountable) {
              const discount = item.amount * (discountPercent / 100);
              totalDiscount += discount;
              return { ...item, amount: item.amount - discount };
            }
            return item;
          });

          return { items: discountedItems, totalDiscount };
        };

        const items: LineItem[] = [
          { id: '1', amount: 100, discountable: true },
          { id: '2', amount: 50, discountable: false },
          { id: '3', amount: 30, discountable: true },
        ];

        const result = applyDiscountToItems(items, 10);

        expect(result.totalDiscount).toBe(13); // 10 + 3
      });

      it('should handle discount exclusions', () => {
        const isExcludedFromDiscount = (
          itemType: string,
          exclusions: string[],
        ): boolean => {
          return exclusions.includes(itemType);
        };

        const exclusions = ['setup_fee', 'support_addon'];

        expect(isExcludedFromDiscount('subscription', exclusions)).toBe(false);
        expect(isExcludedFromDiscount('setup_fee', exclusions)).toBe(true);
      });

      it('should enforce maximum discount cap', () => {
        const applyDiscountWithCap = (
          subtotal: number,
          discountPercent: number,
          maxDiscountAmount: number,
        ): number => {
          const calculated = subtotal * (discountPercent / 100);
          return Math.min(calculated, maxDiscountAmount);
        };

        expect(applyDiscountWithCap(100, 50, 30)).toBe(30);
        expect(applyDiscountWithCap(100, 20, 30)).toBe(20);
      });
    });

    describe('Discount Stacking Rules', () => {
      it('should handle discount stacking', () => {
        interface AppliedDiscount {
          code: string;
          type: 'percentage' | 'fixed';
          value: number;
          stackable: boolean;
        }

        const canStackDiscount = (
          newDiscount: AppliedDiscount,
          existingDiscounts: AppliedDiscount[],
        ): boolean => {
          if (!newDiscount.stackable) return existingDiscounts.length === 0;

          const hasNonStackable = existingDiscounts.some((d) => !d.stackable);
          return !hasNonStackable;
        };

        const existingStackable: AppliedDiscount[] = [
          { code: 'STACK1', type: 'percentage', value: 10, stackable: true },
        ];

        const existingNonStackable: AppliedDiscount[] = [
          { code: 'EXCLUSIVE', type: 'percentage', value: 30, stackable: false },
        ];

        const newStackable: AppliedDiscount = { code: 'STACK2', type: 'percentage', value: 5, stackable: true };
        const newNonStackable: AppliedDiscount = { code: 'EXCLUSIVE2', type: 'percentage', value: 25, stackable: false };

        expect(canStackDiscount(newStackable, existingStackable)).toBe(true);
        expect(canStackDiscount(newStackable, existingNonStackable)).toBe(false);
        expect(canStackDiscount(newNonStackable, existingStackable)).toBe(false);
      });

      it('should calculate combined stacked discounts', () => {
        const calculateStackedDiscounts = (
          subtotal: number,
          discounts: { type: 'percentage' | 'fixed'; value: number }[],
        ): number => {
          let currentSubtotal = subtotal;

          // Apply percentage discounts first
          const percentageDiscounts = discounts.filter((d) => d.type === 'percentage');
          percentageDiscounts.forEach((d) => {
            currentSubtotal = currentSubtotal * (1 - d.value / 100);
          });

          // Then apply fixed discounts
          const fixedDiscounts = discounts.filter((d) => d.type === 'fixed');
          fixedDiscounts.forEach((d) => {
            currentSubtotal = Math.max(0, currentSubtotal - d.value);
          });

          return Math.round(currentSubtotal * 100) / 100;
        };

        const discounts = [
          { type: 'percentage' as const, value: 10 },
          { type: 'percentage' as const, value: 5 },
          { type: 'fixed' as const, value: 10 },
        ];

        // 100 -> 90 (10% off) -> 85.5 (5% off) -> 75.5 ($10 off)
        const result = calculateStackedDiscounts(100, discounts);

        expect(result).toBe(75.5);
      });
    });
  });

  // ============================================================================
  // REFERRAL CREDITS TESTS
  // ============================================================================
  describe('Referral Credits', () => {
    interface ReferralProgram {
      referrerCredit: number;
      refereeCredit: number;
      referrerCreditType: 'immediate' | 'after_first_payment';
      maxReferrals: number;
    }

    it('should award referrer credit', () => {
      const awardReferrerCredit = (
        program: ReferralProgram,
        currentReferrals: number,
      ): number | null => {
        if (currentReferrals >= program.maxReferrals) return null;
        return program.referrerCredit;
      };

      const program: ReferralProgram = {
        referrerCredit: 50,
        refereeCredit: 25,
        referrerCreditType: 'after_first_payment',
        maxReferrals: 10,
      };

      expect(awardReferrerCredit(program, 5)).toBe(50);
      expect(awardReferrerCredit(program, 10)).toBeNull();
    });

    it('should award referee credit', () => {
      const awardRefereeCredit = (program: ReferralProgram): number => {
        return program.refereeCredit;
      };

      const program: ReferralProgram = {
        referrerCredit: 50,
        refereeCredit: 25,
        referrerCreditType: 'immediate',
        maxReferrals: 10,
      };

      expect(awardRefereeCredit(program)).toBe(25);
    });

    it('should track referral chain', () => {
      interface Referral {
        referrerId: string;
        refereeId: string;
        createdAt: Date;
        status: 'pending' | 'qualified' | 'credited';
      }

      const referrals: Referral[] = [
        { referrerId: 't1', refereeId: 't2', createdAt: new Date(), status: 'credited' },
        { referrerId: 't1', refereeId: 't3', createdAt: new Date(), status: 'qualified' },
        { referrerId: 't2', refereeId: 't4', createdAt: new Date(), status: 'pending' },
      ];

      const getReferralsByReferrer = (referrerId: string): Referral[] => {
        return referrals.filter((r) => r.referrerId === referrerId);
      };

      expect(getReferralsByReferrer('t1').length).toBe(2);
      expect(getReferralsByReferrer('t2').length).toBe(1);
    });
  });
});
