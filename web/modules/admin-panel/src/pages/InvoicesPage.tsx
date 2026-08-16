/**
 * Invoices Management Page
 * View and manage all invoices with mark-paid, void, and download actions
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import CreateInvoiceModal, { type CreateInvoicePayload } from '../components/CreateInvoiceModal';
import { billingApi, InvoiceOverview } from '../services/adminApi';
import {
  createAdminDownloadFilename,
  downloadAdminOwnedBlob,
} from '../services/browser-capabilities';

interface Invoice {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  tenantName: string;
  tenantEmail?: string;
  amount: number;
  amountPaid: number;
  amountDue: number;
  status:
    | 'draft'
    | 'pending'
    | 'sent'
    | 'paid'
    | 'partially_paid'
    | 'overdue'
    | 'void'
    | 'refunded';
  currency: string;
  dueDate: string;
  paidAt?: string | null;
  issueDate: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

interface InvoiceStats {
  totalInvoices: number;
  totalAmount: number;
  totalPaid: number;
  totalPending: number;
  totalOverdue: number;
}

const formatCurrency = (amount: number, currency = 'USD'): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
};

const formatDate = (dateStr: string): string => {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const InvoicesPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const invoiceListRoute = '/admin/billing/invoices';
  const invoiceCreateRoute = '/admin/billing/invoices/new';
  const initialParams = new URLSearchParams(location.search);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [stats, setStats] = useState<InvoiceStats>({
    totalInvoices: 0,
    totalAmount: 0,
    totalPaid: 0,
    totalPending: 0,
    totalOverdue: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState(initialParams.get('search') ?? '');
  const [statusFilter, setStatusFilter] = useState<string>(initialParams.get('status') ?? 'all');
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(location.pathname === invoiceCreateRoute);

  // Toast notification
  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  // Mark as Paid modal
  const [showMarkPaidModal, setShowMarkPaidModal] = useState(false);
  const [markPaidAmount, setMarkPaidAmount] = useState('');
  const [markPaidLoading, setMarkPaidLoading] = useState(false);

  // Void modal
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidLoading, setVoidLoading] = useState(false);

  const showToast = (message: string, type: 'success' | 'error' | 'info'): void => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchInvoices = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const data = await billingApi.getInvoices({
        status: statusFilter !== 'all' ? [statusFilter] : undefined,
        search: searchTerm || undefined,
        limit: 100,
      });

      const mappedInvoices: Invoice[] = (data.invoices || []).map((inv: InvoiceOverview) => ({
        ...inv,
        amount: typeof inv.amount === 'string' ? parseFloat(inv.amount) : inv.amount,
        amountPaid:
          typeof inv.amountPaid === 'string' ? parseFloat(inv.amountPaid) : inv.amountPaid,
        amountDue: typeof inv.amountDue === 'string' ? parseFloat(inv.amountDue) : inv.amountDue,
        status: inv.status as Invoice['status'],
      }));
      setInvoices(mappedInvoices);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setInvoices([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, searchTerm]);

  const fetchStats = useCallback(async () => {
    try {
      const data = await billingApi.getInvoiceStats();
      setStats({
        totalInvoices: data.totalInvoices || 0,
        totalAmount: data.totalAmount || 0,
        totalPaid: data.totalPaid || 0,
        totalPending: data.totalPending || 0,
        totalOverdue: data.totalOverdue || 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoice stats');
    }
  }, []);

  useEffect(() => {
    void fetchInvoices();
    void fetchStats();
  }, [fetchInvoices, fetchStats]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    setSearchTerm(params.get('search') ?? '');
    setStatusFilter(params.get('status') ?? 'all');
    setShowCreateModal(location.pathname === invoiceCreateRoute);
  }, [invoiceCreateRoute, location.pathname, location.search]);

  const updateInvoiceListQuery = useCallback(
    (next: { status?: string; search?: string }) => {
      const params = new URLSearchParams(location.search);
      const nextStatus = next.status ?? statusFilter;
      const nextSearch = next.search ?? searchTerm;

      if (nextStatus && nextStatus !== 'all') {
        params.set('status', nextStatus);
      } else {
        params.delete('status');
      }

      if (nextSearch.trim()) {
        params.set('search', nextSearch.trim());
      } else {
        params.delete('search');
      }

      const query = params.toString();
      navigate(`${invoiceListRoute}${query ? `?${query}` : ''}`, {
        replace: location.pathname === invoiceListRoute,
      });
    },
    [invoiceListRoute, location.pathname, location.search, navigate, searchTerm, statusFilter],
  );

  const handleSearchChange = (value: string): void => {
    setSearchTerm(value);
    updateInvoiceListQuery({ search: value });
  };

  const handleStatusFilterChange = (status: string): void => {
    setStatusFilter(status);
    updateInvoiceListQuery({ status });
  };

  const openCreateInvoice = (): void => {
    navigate(invoiceCreateRoute);
  };

  const closeCreateInvoice = useCallback((): void => {
    setShowCreateModal(false);
    navigate(invoiceListRoute);
  }, [invoiceListRoute, navigate]);

  // --- Action Handlers ---

  const handleMarkAsPaid = async (): Promise<void> => {
    if (!selectedInvoice) return;
    const amount = parseFloat(markPaidAmount);
    if (isNaN(amount) || amount <= 0) {
      showToast('Please enter a valid amount', 'error');
      return;
    }
    if (amount > selectedInvoice.amountDue) {
      showToast(
        `Amount exceeds amount due (${formatCurrency(selectedInvoice.amountDue, selectedInvoice.currency)})`,
        'error',
      );
      return;
    }

    setMarkPaidLoading(true);
    try {
      await billingApi.markInvoicePaid(selectedInvoice.id, amount);
      showToast(`Invoice ${selectedInvoice.invoiceNumber} marked as paid`, 'success');
      setShowMarkPaidModal(false);
      setMarkPaidAmount('');
      setSelectedInvoice(null);
      await Promise.all([fetchInvoices(), fetchStats()]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to mark invoice as paid', 'error');
    } finally {
      setMarkPaidLoading(false);
    }
  };

  const handleVoidInvoice = async (): Promise<void> => {
    if (!selectedInvoice) return;
    if (!voidReason.trim()) {
      showToast('Please provide a reason for voiding', 'error');
      return;
    }

    setVoidLoading(true);
    try {
      await billingApi.voidInvoice(selectedInvoice.id, voidReason.trim());
      showToast(`Invoice ${selectedInvoice.invoiceNumber} voided`, 'success');
      setShowVoidModal(false);
      setVoidReason('');
      setSelectedInvoice(null);
      await Promise.all([fetchInvoices(), fetchStats()]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to void invoice', 'error');
    } finally {
      setVoidLoading(false);
    }
  };

  /**
   * Handles submission from the extracted CreateInvoiceModal component.
   * Delegates to the billing API, then refreshes the invoice list and stats.
   */
  const handleCreateInvoiceSubmit = useCallback(
    async (data: CreateInvoicePayload): Promise<void> => {
      await billingApi.createInvoice(data);
      showToast('Invoice created successfully', 'success');
      closeCreateInvoice();
      await Promise.all([fetchInvoices(), fetchStats()]);
    },
    [closeCreateInvoice, fetchInvoices, fetchStats],
  );

  /**
   * Export invoices to a CSV file.
   * Generates a client-side CSV from the currently loaded invoice list
   * using the Blob API -- no server roundtrip needed since data is
   * already fetched. Falls back with an error toast when there is
   * nothing to export.
   */
  const handleExportCsv = (): void => {
    if (invoices.length === 0) {
      showToast('No invoices to export', 'info');
      return;
    }

    const csvHeaders = [
      'Invoice Number',
      'Tenant',
      'Email',
      'Amount',
      'Amount Paid',
      'Amount Due',
      'Currency',
      'Status',
      'Issue Date',
      'Due Date',
      'Period Start',
      'Period End',
      'Paid At',
    ];

    const csvRows = invoices.map((inv) => [
      inv.invoiceNumber,
      inv.tenantName,
      inv.tenantEmail ?? '',
      String(inv.amount),
      String(inv.amountPaid),
      String(inv.amountDue),
      inv.currency,
      inv.status,
      inv.issueDate,
      inv.dueDate,
      inv.periodStart,
      inv.periodEnd,
      inv.paidAt ?? '',
    ]);

    // Escape values that contain commas, quotes, or newlines
    const escapeCell = (value: string): string => {
      if (/[",\n\r]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    };

    const csvContent = [
      csvHeaders.map(escapeCell).join(','),
      ...csvRows.map((row) => row.map(escapeCell).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    downloadAdminOwnedBlob({
      blob,
      filename: createAdminDownloadFilename(
        `invoices-${new Date().toISOString().split('T')[0]}.csv`,
      ),
    });

    showToast(`Exported ${invoices.length} invoices`, 'success');
  };

  const openMarkPaidModal = (): void => {
    if (selectedInvoice) {
      setMarkPaidAmount(String(selectedInvoice.amountDue));
      setShowMarkPaidModal(true);
    }
  };

  const openVoidModal = (): void => {
    setVoidReason('');
    setShowVoidModal(true);
  };

  const canMarkPaid =
    selectedInvoice && !['paid', 'void', 'refunded', 'draft'].includes(selectedInvoice.status);
  const canVoid = selectedInvoice && !['paid', 'void', 'refunded'].includes(selectedInvoice.status);

  const statusColors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700',
    pending: 'bg-yellow-100 text-yellow-700',
    sent: 'bg-blue-100 text-blue-700',
    paid: 'bg-green-100 text-green-700',
    partially_paid: 'bg-orange-100 text-orange-700',
    overdue: 'bg-red-100 text-red-700',
    void: 'bg-gray-200 text-gray-500',
    refunded: 'bg-purple-100 text-purple-700',
  };

  const statusLabels: Record<string, string> = {
    draft: 'Draft',
    pending: 'Pending',
    sent: 'Sent',
    paid: 'Paid',
    partially_paid: 'Partial',
    overdue: 'Overdue',
    void: 'Void',
    refunded: 'Refunded',
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-[100] px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all ${
            toast.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : toast.type === 'error'
                ? 'bg-red-50 text-red-800 border border-red-200'
                : 'bg-blue-50 text-blue-800 border border-blue-200'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Invoices</h1>
          <p className="mt-1 text-sm text-gray-500">Manage and track all tenant invoices</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExportCsv}
            className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            Export
          </button>
          <button
            onClick={openCreateInvoice}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Create Invoice
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Total Invoices</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{stats.totalInvoices}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Total Amount</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">
            {formatCurrency(stats.totalAmount)}
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Paid</p>
          <p className="text-2xl font-bold text-green-600 mt-1">
            {formatCurrency(stats.totalPaid)}
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Pending</p>
          <p className="text-2xl font-bold text-yellow-600 mt-1">
            {formatCurrency(stats.totalPending)}
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Overdue</p>
          <p className="text-2xl font-bold text-red-600 mt-1">
            {formatCurrency(stats.totalOverdue)}
          </p>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700">{error}</p>
          <button
            onClick={() => {
              void fetchInvoices();
              void fetchStats();
            }}
            className="mt-2 text-red-600 hover:text-red-800 text-sm font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <input
                type="text"
                placeholder="Search invoices..."
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              />
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {['all', 'paid', 'pending', 'overdue', 'void'].map((status) => (
              <button
                key={status}
                onClick={() => handleStatusFilterChange(status)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors capitalize ${
                  statusFilter === status
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Invoice Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 animate-pulse">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-4 py-4 border-b border-gray-100">
                <div className="h-4 bg-gray-200 rounded w-24" />
                <div className="h-4 bg-gray-200 rounded w-40" />
                <div className="flex-1" />
                <div className="h-4 bg-gray-200 rounded w-20" />
                <div className="h-4 bg-gray-200 rounded w-24" />
              </div>
            ))}
          </div>
        ) : invoices.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <svg
              className="mx-auto h-12 w-12 text-gray-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <p className="mt-2">No invoices found</p>
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Invoice
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tenant
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Due Date
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {invoice.invoiceNumber}
                      </div>
                      <div className="text-xs text-gray-500">{formatDate(invoice.createdAt)}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {invoice.tenantName || 'Unknown'}
                      </div>
                      <div className="text-xs text-gray-500">{invoice.tenantEmail || '-'}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-semibold text-gray-900">
                      {formatCurrency(invoice.amount, invoice.currency)}
                    </div>
                    {invoice.amountDue > 0 && invoice.amountDue < invoice.amount && (
                      <div className="text-xs text-orange-600">
                        Due: {formatCurrency(invoice.amountDue, invoice.currency)}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${statusColors[invoice.status] || 'bg-gray-100 text-gray-700'}`}
                    >
                      {statusLabels[invoice.status] || invoice.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">{formatDate(invoice.dueDate)}</div>
                    {invoice.paidAt && (
                      <div className="text-xs text-green-600">
                        Paid: {formatDate(invoice.paidAt)}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => setSelectedInvoice(invoice)}
                      className="text-blue-600 hover:text-blue-900 mr-3"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Invoice Detail Modal */}
      {selectedInvoice && !showMarkPaidModal && !showVoidModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">
                  {selectedInvoice.invoiceNumber}
                </h2>
                <button
                  onClick={() => setSelectedInvoice(null)}
                  className="text-gray-500 hover:text-gray-600"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Tenant</span>
                <span className="text-sm font-medium text-gray-900">
                  {selectedInvoice.tenantName || 'Unknown'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Email</span>
                <span className="text-sm text-gray-900">{selectedInvoice.tenantEmail || '-'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Status</span>
                <span
                  className={`px-2 py-1 text-xs font-medium rounded-full ${statusColors[selectedInvoice.status] || 'bg-gray-100 text-gray-700'}`}
                >
                  {statusLabels[selectedInvoice.status] || selectedInvoice.status}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Issue Date</span>
                <span className="text-sm text-gray-900">
                  {formatDate(selectedInvoice.issueDate)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Due Date</span>
                <span className="text-sm text-gray-900">{formatDate(selectedInvoice.dueDate)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Period</span>
                <span className="text-sm text-gray-900">
                  {formatDate(selectedInvoice.periodStart)} -{' '}
                  {formatDate(selectedInvoice.periodEnd)}
                </span>
              </div>

              <div className="border-t border-gray-200 pt-4 mt-4">
                <div className="flex justify-between py-2">
                  <span className="text-sm text-gray-600">Subtotal</span>
                  <span className="text-sm font-medium text-gray-900">
                    {formatCurrency(selectedInvoice.amount, selectedInvoice.currency)}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-sm text-gray-600">Amount Paid</span>
                  <span className="text-sm font-medium text-green-600">
                    {formatCurrency(selectedInvoice.amountPaid, selectedInvoice.currency)}
                  </span>
                </div>
                <div className="flex justify-between pt-3 border-t border-gray-200 mt-3">
                  <span className="text-sm font-semibold text-gray-900">Amount Due</span>
                  <span className="text-sm font-bold text-gray-900">
                    {formatCurrency(selectedInvoice.amountDue, selectedInvoice.currency)}
                  </span>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 space-y-3">
              {/* Primary Actions */}
              <div className="flex gap-3">
                {canMarkPaid && (
                  <button
                    onClick={openMarkPaidModal}
                    className="flex-1 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
                  >
                    Mark as Paid
                  </button>
                )}
                {canVoid && (
                  <button
                    onClick={openVoidModal}
                    className="flex-1 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
                  >
                    Void Invoice
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mark as Paid Modal */}
      {showMarkPaidModal && selectedInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Mark Invoice as Paid</h2>
              <p className="text-sm text-gray-500 mt-1">
                {selectedInvoice.invoiceNumber} - {selectedInvoice.tenantName}
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Amount Due: {formatCurrency(selectedInvoice.amountDue, selectedInvoice.currency)}
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={selectedInvoice.amountDue}
                    value={markPaidAmount}
                    onChange={(e) => setMarkPaidAmount(e.target.value)}
                    className="w-full pl-7 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-green-500"
                    placeholder="Enter payment amount"
                  />
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex gap-3">
              <button
                onClick={() => {
                  setShowMarkPaidModal(false);
                  setMarkPaidAmount('');
                }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                disabled={markPaidLoading}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  void handleMarkAsPaid();
                }}
                disabled={markPaidLoading}
                className="flex-1 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
              >
                {markPaidLoading ? 'Processing...' : 'Confirm Payment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Void Invoice Modal */}
      {showVoidModal && selectedInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Void Invoice</h2>
              <p className="text-sm text-gray-500 mt-1">
                {selectedInvoice.invoiceNumber} - {selectedInvoice.tenantName}
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm text-red-700">
                  This action cannot be undone. The invoice will be permanently voided.
                </p>
              </div>
              <div>
                <label
                  htmlFor="invoice-void-reason"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Reason for voiding
                </label>
                <textarea
                  id="invoice-void-reason"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-red-500"
                  placeholder="Enter reason for voiding this invoice..."
                />
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex gap-3">
              <button
                onClick={() => {
                  setShowVoidModal(false);
                  setVoidReason('');
                }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                disabled={voidLoading}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  void handleVoidInvoice();
                }}
                disabled={voidLoading || !voidReason.trim()}
                className="flex-1 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {voidLoading ? 'Processing...' : 'Void Invoice'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Invoice Modal -- extracted to separate component for maintainability */}
      {showCreateModal && (
        <CreateInvoiceModal onSubmit={handleCreateInvoiceSubmit} onClose={closeCreateInvoice} />
      )}
    </div>
  );
};

export default InvoicesPage;
