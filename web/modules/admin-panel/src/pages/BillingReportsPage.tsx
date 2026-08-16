import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { billingApi } from '../services/api/billing';
import { SubscriptionStatus } from '../services/types/billing';
import {
  createAdminDownloadFilename,
  downloadAdminOwnedBlob,
} from '../services/browser-capabilities';

interface BillingReportSummary {
  totalInvoices: number;
  totalAmount: number;
  totalPaid: number;
  totalPending: number;
  totalOverdue: number;
  activeSubscriptions: number;
  successfulPayments: number;
  refundedPayments: number;
}

const formatCurrency = (amount: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);

const BillingReportsPage: React.FC = () => {
  const [summary, setSummary] = useState<BillingReportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReport = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [invoiceStats, subscriptions, payments] = await Promise.all([
        billingApi.getInvoiceStats(),
        billingApi.getSubscriptions({ status: [SubscriptionStatus.ACTIVE], limit: 1, offset: 0 }),
        billingApi.getPayments({ status: ['succeeded'], limit: 100, offset: 0 }),
      ]);

      setSummary({
        totalInvoices: invoiceStats.totalInvoices ?? 0,
        totalAmount: invoiceStats.totalAmount ?? 0,
        totalPaid: invoiceStats.totalPaid ?? 0,
        totalPending: invoiceStats.totalPending ?? 0,
        totalOverdue: invoiceStats.totalOverdue ?? 0,
        activeSubscriptions: subscriptions.total ?? 0,
        successfulPayments: payments.total ?? 0,
        refundedPayments: payments.payments.filter(
          (payment) => Number(payment.refundedAmount ?? 0) > 0,
        ).length,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load billing report');
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const exportCsv = (): void => {
    if (!summary) return;

    const rows = [
      ['Metric', 'Value'],
      ['Total invoices', String(summary.totalInvoices)],
      ['Total amount', String(summary.totalAmount)],
      ['Total paid', String(summary.totalPaid)],
      ['Total pending', String(summary.totalPending)],
      ['Total overdue', String(summary.totalOverdue)],
      ['Active subscriptions', String(summary.activeSubscriptions)],
      ['Successful payments', String(summary.successfulPayments)],
      ['Payments with refunds', String(summary.refundedPayments)],
    ];

    const blob = new Blob([rows.map((row) => row.join(',')).join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    downloadAdminOwnedBlob({
      blob,
      filename: createAdminDownloadFilename(
        `billing-report-${new Date().toISOString().slice(0, 10)}.csv`,
      ),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Billing Reports</h1>
          <p className="mt-1 text-sm text-gray-500">
            Platform-level billing totals compiled from invoice, subscription, and payment APIs.
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
            disabled={!summary}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => {
              void loadReport();
            }}
            className="mt-2 text-sm font-medium text-red-700 hover:text-red-900"
          >
            Retry
          </button>
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
      ) : summary ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ReportCard label="Total Invoices" value={String(summary.totalInvoices)} />
          <ReportCard label="Total Amount" value={formatCurrency(summary.totalAmount)} />
          <ReportCard label="Paid" value={formatCurrency(summary.totalPaid)} />
          <ReportCard label="Pending" value={formatCurrency(summary.totalPending)} />
          <ReportCard label="Overdue" value={formatCurrency(summary.totalOverdue)} tone="danger" />
          <ReportCard label="Active Subscriptions" value={String(summary.activeSubscriptions)} />
          <ReportCard label="Successful Payments" value={String(summary.successfulPayments)} />
          <ReportCard label="Payments With Refunds" value={String(summary.refundedPayments)} />
        </div>
      ) : null}
    </div>
  );
};

interface ReportCardProps {
  label: string;
  value: string;
  tone?: 'default' | 'danger';
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
