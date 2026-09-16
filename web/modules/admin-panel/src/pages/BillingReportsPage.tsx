/**
 * Billing Reports — the platform's money totals, and the currency they were
 * printed in without having one (ADMIN-HIGH-121 / ADMIN-HIGH-146).
 *
 * 1. **Every money card was stamped `$`.** `formatCurrency` hardcoded
 *    `currency: 'USD'`, and `InvoiceStats.totalAmount` is
 *    `COALESCE(SUM(total), 0) FROM billing.invoices` with **no `GROUP BY
 *    currency`** — the same payload carries a `byCurrency` breakdown, which is
 *    the endpoint saying outright that the table is multi-currency. So on any
 *    platform with one EUR invoice, four cards and an exported CSV read
 *    `$1,234,567.89` for a figure that is not an amount of dollars, or of
 *    anything else. The number now carries the currency the data actually has,
 *    or an em dash and the real per-currency breakdown when there is more than
 *    one.
 *
 * 2. **"Payments With Refunds" was a 100-row subtotal beside a true total.**
 *    It fetched `getPayments({ status: 'succeeded', limit: 100 })` and counted
 *    the rows whose `refundedAmount` was above zero — so the card sat next to
 *    "Successful Payments", which is the endpoint's `total`, and reported a
 *    count out of the first hundred. The `status: 'succeeded'` filter also
 *    excluded every FULLY refunded payment, whose status is `refunded`: the
 *    card counted partial refunds only and called them refunds. The server has
 *    computed both numbers exactly since ADMIN-HIGH-138 —
 *    `PaymentStats.refunded` and `.succeeded` — so the browser stops counting
 *    and the hundred-row fetch is gone.
 *
 * 3. **Five `?? 0` fallbacks on fields the contract declares required.** Dead
 *    defensive code, and had one ever been absent it would have printed a
 *    fabricated zero into a billing report.
 *
 * 4. **The CSV named no currency and no scope.** "Total amount,1234567.89" in
 *    a file an operator sends on is unattributable; both are columns now.
 */

import React from 'react';
import { Link } from 'react-router-dom';

import { billingApi } from '../services/api/billing';
import {
  SubscriptionStatus,
  type InvoiceStats,
  type PaymentStats,
  type SubscriptionOverview,
} from '../services/types/billing';
import { saveBlob } from '../services/blob-client';
import { adminKeys, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';
import { formatCurrencyAmount, formatDecimalAmount } from '../utils/money';

/**
 * One active-subscription probe: the page needs the count, not the rows, and
 * the list endpoint's `total` is that count exactly.
 */
const ACTIVE_SUBSCRIPTION_PROBE: {
  status: SubscriptionStatus[];
  limit: number;
  offset: number;
} = {
  status: [SubscriptionStatus.ACTIVE],
  limit: 1,
  offset: 0,
};

/**
 * The currency the invoice totals are denominated in — or `null` when that
 * question has no single answer.
 *
 * `totalAmount` / `totalPaid` / `totalPending` / `totalOverdue` are all
 * `SUM(total)` over the whole `billing.invoices` table with no currency
 * grouping. Such a sum is a monetary quantity only when the table holds
 * exactly ONE currency; with two it is the addition of unlike units, and no
 * symbol makes it true. `byCurrency` comes from `GROUP BY currency` on the same
 * request, so its keys are exactly the currencies present.
 */
function soleInvoiceCurrency(byCurrency: Record<string, number>): string | null {
  const codes = Object.keys(byCurrency);
  return codes.length === 1 ? (codes[0] ?? null) : null;
}

/** How a cross-currency total is written down when it cannot be one number. */
function mixedCurrencyLabel(byCurrency: Record<string, number>): string {
  return Object.keys(byCurrency).sort().join(', ');
}

const BillingReportsPage: React.FC = () => {
  const invoiceStatsQuery = useAdminQuery<InvoiceStats>(
    adminKeys.billing.invoiceStats(),
    ({ signal }) => billingApi.getInvoiceStats(signal),
  );
  const paymentStatsQuery = useAdminQuery<PaymentStats>(
    adminKeys.billing.paymentStats(),
    ({ signal }) => billingApi.getPaymentStats(signal),
  );
  const activeSubscriptionsQuery = useAdminQuery<{
    subscriptions: SubscriptionOverview[];
    total: number;
  }>(adminKeys.billing.subscriptions(ACTIVE_SUBSCRIPTION_PROBE), ({ signal }) =>
    billingApi.getSubscriptions(ACTIVE_SUBSCRIPTION_PROBE, signal),
  );

  const invoices = invoiceStatsQuery.data;
  const payments = paymentStatsQuery.data;
  const activeSubscriptions = activeSubscriptionsQuery.data;

  const currency = invoices ? soleInvoiceCurrency(invoices.byCurrency) : null;

  const reload = (): void => {
    void invoiceStatsQuery.refetch();
    void paymentStatsQuery.refetch();
    void activeSubscriptionsQuery.refetch();
  };

  /** A money figure, in the currency it is actually in — or nothing. */
  const money = (amount: number): string =>
    currency === null ? '—' : formatCurrencyAmount(String(amount), currency);

  const loading =
    invoiceStatsQuery.isPending ||
    paymentStatsQuery.isPending ||
    activeSubscriptionsQuery.isPending;

  // The export offers only what the page could state. A row whose currency is
  // unknown carries the codes it is mixed across, never a symbol.
  const exportable = invoices !== undefined && payments !== undefined;

  const exportCsv = (): void => {
    if (!invoices || !payments) return;

    const moneyCurrency = currency ?? `mixed: ${mixedCurrencyLabel(invoices.byCurrency)}`;
    const rows: string[][] = [
      ['Metric', 'Value', 'Currency'],
      ['Total invoices', String(invoices.totalInvoices), ''],
      ['Total amount', String(invoices.totalAmount), moneyCurrency],
      ['Total paid', String(invoices.totalPaid), moneyCurrency],
      ['Total pending', String(invoices.totalPending), moneyCurrency],
      ['Total overdue', String(invoices.totalOverdue), moneyCurrency],
      ['Active subscriptions', String(activeSubscriptions?.total ?? ''), ''],
      ['Successful payments', String(payments.succeeded), ''],
      ['Payments with refunds', String(payments.refunded), ''],
      ...Object.entries(invoices.byCurrency)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, amount]) => [`Invoiced in ${code}`, String(amount), code]),
    ];

    saveBlob(
      new Blob([rows.map((row) => row.join(',')).join('\n')], {
        type: 'text/csv;charset=utf-8;',
      }),
      `billing-report-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Billing Reports</h1>
          <p className="mt-1 text-sm text-gray-500">
            Platform-level billing totals, all time, compiled from the invoice, subscription and
            payment aggregates.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/admin/billing"
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back to Billing
          </Link>
          <button
            onClick={exportCsv}
            disabled={!exportable}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      <QueryFailureNotice
        errors={[
          invoiceStatsQuery.error,
          paymentStatsQuery.error,
          activeSubscriptionsQuery.error,
        ]}
        hasContent={invoices !== undefined || payments !== undefined}
        onRetry={reload}
      />

      {invoices && currency === null && Object.keys(invoices.byCurrency).length > 1 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-800">
            Invoices are raised in {mixedCurrencyLabel(invoices.byCurrency)}. The invoice totals
            below are sums across all of them, so they are not an amount in any one currency and
            are shown as “—”. The per-currency figures are the real ones:
          </p>
          <ul className="mt-2 space-y-1 text-sm text-amber-900">
            {Object.entries(invoices.byCurrency)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([code, amount]) => (
                <li key={code}>
                  {code}: {formatCurrencyAmount(String(amount), code)}
                </li>
              ))}
          </ul>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="h-28 animate-pulse rounded-xl border border-gray-200 bg-white p-4"
            >
              <div className="h-4 w-24 rounded bg-gray-200" />
              <div className="mt-4 h-8 w-32 rounded bg-gray-200" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {invoices && (
            <>
              <ReportCard
                label="Total Invoices"
                value={formatDecimalAmount(String(invoices.totalInvoices), 0)}
              />
              <ReportCard label="Total Amount" value={money(invoices.totalAmount)} />
              <ReportCard label="Paid" value={money(invoices.totalPaid)} />
              <ReportCard label="Pending" value={money(invoices.totalPending)} />
              <ReportCard label="Overdue" value={money(invoices.totalOverdue)} tone="danger" />
            </>
          )}
          {activeSubscriptions && (
            <ReportCard
              label="Active Subscriptions"
              value={formatDecimalAmount(String(activeSubscriptions.total), 0)}
            />
          )}
          {payments && (
            <>
              {/* Both from `/billing/payments/stats`, so both count every
                  payment rather than the first page of them. */}
              <ReportCard
                label="Successful Payments"
                value={formatDecimalAmount(String(payments.succeeded), 0)}
              />
              <ReportCard
                label="Payments With Refunds"
                value={formatDecimalAmount(String(payments.refunded), 0)}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
};

interface ReportCardProps {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'default' | 'danger';
}

const ReportCard: React.FC<ReportCardProps> = ({ label, value, tone = 'default' }) => (
  <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
    <p className="text-sm text-gray-500">{label}</p>
    <p
      className={`mt-2 text-2xl font-bold ${tone === 'danger' ? 'text-red-600' : 'text-gray-900'}`}
    >
      {value}
    </p>
  </div>
);

export default BillingReportsPage;
