/**
 * Payment Management Page
 * View, record, and refund payments across all tenants
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  billingApi,
  PaymentOverview,
  PaymentStatus,
  PaymentMethod,
} from '../services/adminApi';
import { useSearchParams } from 'react-router-dom';

import { useFilters } from '../hooks';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Payment list filters. `search` is the operator-facing free-text term
 * (matched against invoice number / transaction id / notes on the backend).
 * `invoiceId` is intentionally NOT part of this UI state — it is an exact-UUID
 * deep-link read from the URL only (APA-087), never typed into the search box.
 */
interface PaymentListFilters extends Record<string, unknown> {
  search: string;
  status: string;
}

const INITIAL_PAYMENT_FILTERS: PaymentListFilters = {
  search: '',
  status: 'all',
};

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

const formatDateTime = (dateStr: string): string => {
  return new Date(dateStr).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const statusColors: Record<string, string> = {
  [PaymentStatus.PENDING]: 'bg-yellow-100 text-yellow-700',
  [PaymentStatus.PROCESSING]: 'bg-blue-100 text-blue-700',
  [PaymentStatus.SUCCEEDED]: 'bg-green-100 text-green-700',
  [PaymentStatus.FAILED]: 'bg-red-100 text-red-700',
  [PaymentStatus.CANCELLED]: 'bg-gray-200 text-gray-500',
  [PaymentStatus.REFUNDED]: 'bg-purple-100 text-purple-700',
  [PaymentStatus.PARTIALLY_REFUNDED]: 'bg-orange-100 text-orange-700',
};

const statusLabels: Record<string, string> = {
  [PaymentStatus.PENDING]: 'Pending',
  [PaymentStatus.PROCESSING]: 'Processing',
  [PaymentStatus.SUCCEEDED]: 'Succeeded',
  [PaymentStatus.FAILED]: 'Failed',
  [PaymentStatus.CANCELLED]: 'Cancelled',
  [PaymentStatus.REFUNDED]: 'Refunded',
  [PaymentStatus.PARTIALLY_REFUNDED]: 'Partial Refund',
};

const methodLabels: Record<string, string> = {
  [PaymentMethod.CREDIT_CARD]: 'Credit Card',
  [PaymentMethod.DEBIT_CARD]: 'Debit Card',
  [PaymentMethod.BANK_TRANSFER]: 'Bank Transfer',
  [PaymentMethod.WIRE_TRANSFER]: 'Wire Transfer',
  [PaymentMethod.ACH]: 'ACH',
  [PaymentMethod.SEPA]: 'SEPA',
  [PaymentMethod.PAYPAL]: 'PayPal',
  [PaymentMethod.CHECK]: 'Check',
  [PaymentMethod.CASH]: 'Cash',
  [PaymentMethod.OTHER]: 'Other',
};

// ============================================================================
// Component
// ============================================================================

const PaymentsPage: React.FC = () => {
  // Data state
  const [payments, setPayments] = useState<PaymentOverview[]>([]);
  const [totalPayments, setTotalPayments] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters — search is debounced so a per-keystroke free-text term does not
  // fire a request (and can never be interpolated as a raw ::uuid) each stroke.
  const { filters, debouncedFilters, setFilter } = useFilters<PaymentListFilters>({
    initialFilters: INITIAL_PAYMENT_FILTERS,
    debounceKeys: ['search'],
  });

  // invoiceId is a read-only exact-UUID deep-link (e.g. arriving from an
  // invoice page link); it is validated by the backend DTO and never sourced
  // from the free-text box.
  const [searchParams] = useSearchParams();
  const deepLinkInvoiceId = searchParams.get('invoiceId') ?? undefined;

  // Toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Record Payment modal
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [recordForm, setRecordForm] = useState({
    invoiceId: '',
    amount: '',
    paymentMethod: PaymentMethod.BANK_TRANSFER as PaymentMethod,
    paymentDate: new Date().toISOString().split('T')[0],
    notes: '',
  });
  const [recordLoading, setRecordLoading] = useState(false);

  // Refund modal
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [refundPayment, setRefundPayment] = useState<PaymentOverview | null>(null);
  const [refundForm, setRefundForm] = useState({
    amount: '',
    reason: '',
  });
  const [refundLoading, setRefundLoading] = useState(false);

  // Detail modal
  const [selectedPayment, setSelectedPayment] = useState<PaymentOverview | null>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // ============================================================================
  // Data Fetching
  // ============================================================================

  const fetchPayments = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const data = await billingApi.getPayments({
        status: debouncedFilters.status !== 'all' ? debouncedFilters.status : undefined,
        search: debouncedFilters.search || undefined,
        invoiceId: deepLinkInvoiceId,
        limit: 50,
      });

      const mapped = (data.payments || []).map((p: PaymentOverview) => ({
        ...p,
        amount: typeof p.amount === 'string' ? parseFloat(p.amount as unknown as string) : p.amount,
        refundedAmount: typeof p.refundedAmount === 'string' ? parseFloat(p.refundedAmount as unknown as string) : (p.refundedAmount || 0),
      }));

      setPayments(mapped);
      setTotalPayments(data.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payments');
      setPayments([]);
    } finally {
      setLoading(false);
    }
  }, [debouncedFilters, deepLinkInvoiceId]);

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);

  // ============================================================================
  // Record Payment
  // ============================================================================

  const handleRecordPayment = async () => {
    const amount = parseFloat(recordForm.amount);
    if (!recordForm.invoiceId.trim()) {
      showToast('Invoice ID is required', 'error');
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      showToast('Please enter a valid payment amount', 'error');
      return;
    }

    setRecordLoading(true);
    try {
      await billingApi.recordPayment({
        invoiceId: recordForm.invoiceId.trim(),
        amount,
        paymentMethod: recordForm.paymentMethod,
        paymentDate: recordForm.paymentDate ? new Date(recordForm.paymentDate).toISOString() : undefined,
        notes: recordForm.notes || undefined,
      });
      showToast('Payment recorded successfully', 'success');
      setShowRecordModal(false);
      setRecordForm({
        invoiceId: '',
        amount: '',
        paymentMethod: PaymentMethod.BANK_TRANSFER,
        paymentDate: new Date().toISOString().split('T')[0],
        notes: '',
      });
      fetchPayments();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to record payment', 'error');
    } finally {
      setRecordLoading(false);
    }
  };

  // ============================================================================
  // Refund Payment
  // ============================================================================

  const openRefundModal = (payment: PaymentOverview) => {
    const maxRefundable = payment.amount - (payment.refundedAmount || 0);
    setRefundPayment(payment);
    setRefundForm({
      amount: String(maxRefundable),
      reason: '',
    });
    setShowRefundModal(true);
  };

  const handleRefundPayment = async () => {
    if (!refundPayment) return;
    const amount = parseFloat(refundForm.amount);
    if (isNaN(amount) || amount <= 0) {
      showToast('Please enter a valid refund amount', 'error');
      return;
    }
    if (!refundForm.reason.trim()) {
      showToast('Refund reason is required', 'error');
      return;
    }
    const maxRefundable = refundPayment.amount - (refundPayment.refundedAmount || 0);
    if (amount > maxRefundable) {
      showToast(`Refund amount exceeds refundable amount (${formatCurrency(maxRefundable)})`, 'error');
      return;
    }

    setRefundLoading(true);
    try {
      await billingApi.refundPayment({
        paymentId: refundPayment.id,
        amount,
        reason: refundForm.reason.trim(),
      });
      showToast('Refund processed successfully', 'success');
      setShowRefundModal(false);
      setRefundPayment(null);
      setRefundForm({ amount: '', reason: '' });
      fetchPayments();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to process refund', 'error');
    } finally {
      setRefundLoading(false);
    }
  };

  const canRefund = (payment: PaymentOverview): boolean => {
    return (
      payment.status === PaymentStatus.SUCCEEDED ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED
    ) && (payment.amount - (payment.refundedAmount || 0)) > 0.01;
  };

  // ============================================================================
  // Stats summary
  // ============================================================================

  const succeededPayments = payments.filter(p => p.status === PaymentStatus.SUCCEEDED || p.status === PaymentStatus.PARTIALLY_REFUNDED);
  const totalSucceeded = succeededPayments.reduce((sum, p) => sum + p.amount, 0);
  const totalRefunded = payments.reduce((sum, p) => sum + (p.refundedAmount || 0), 0);

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-[100] px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all ${
          toast.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' :
          toast.type === 'error' ? 'bg-red-50 text-red-800 border border-red-200' :
          'bg-blue-50 text-blue-800 border border-blue-200'
        }`}>
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Payments</h1>
          <p className="mt-1 text-sm text-gray-500">
            Record, track, and manage payments across all tenants
          </p>
        </div>
        <button
          onClick={() => setShowRecordModal(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          Record Payment
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Total Payments</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totalPayments}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Succeeded Amount</p>
          <p className="text-2xl font-bold text-green-600 mt-1">{formatCurrency(totalSucceeded)}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Refunded</p>
          <p className="text-2xl font-bold text-purple-600 mt-1">{formatCurrency(totalRefunded)}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Net Revenue</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(totalSucceeded - totalRefunded)}</p>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700">{error}</p>
          <button
            onClick={fetchPayments}
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
                placeholder="Search by invoice #, transaction, or notes..."
                value={filters.search}
                onChange={(e) => setFilter('search', e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              />
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {['all', 'succeeded', 'pending', 'failed', 'refunded'].map((status) => (
              <button
                key={status}
                onClick={() => setFilter('status', status)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors capitalize ${
                  filters.status === status
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

      {/* Payment Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 animate-pulse">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-4 py-4 border-b border-gray-100">
                <div className="h-4 bg-gray-200 rounded w-24" />
                <div className="h-4 bg-gray-200 rounded w-32" />
                <div className="flex-1" />
                <div className="h-4 bg-gray-200 rounded w-20" />
                <div className="h-4 bg-gray-200 rounded w-24" />
              </div>
            ))}
          </div>
        ) : payments.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <svg className="mx-auto h-12 w-12 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            <p className="mt-2">No payments found</p>
            <button
              onClick={() => setShowRecordModal(true)}
              className="mt-3 text-blue-600 hover:text-blue-800 text-sm font-medium"
            >
              Record your first payment
            </button>
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Transaction
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Invoice
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Method
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {payments.map((payment) => (
                <tr key={payment.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900 font-mono">
                      {payment.transactionId}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-blue-600">
                      {(payment as PaymentOverview & { invoiceNumber?: string }).invoiceNumber || payment.invoiceId.substring(0, 8) + '...'}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-semibold text-gray-900">
                      {formatCurrency(payment.amount, payment.currency)}
                    </div>
                    {payment.refundedAmount > 0 && (
                      <div className="text-xs text-purple-600">
                        Refunded: {formatCurrency(payment.refundedAmount, payment.currency)}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="text-sm text-gray-700">
                      {methodLabels[payment.paymentMethod] || payment.paymentMethod}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${statusColors[payment.status] || 'bg-gray-100 text-gray-700'}`}>
                      {statusLabels[payment.status] || payment.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">{formatDate(payment.paymentDate)}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => setSelectedPayment(payment)}
                      className="text-blue-600 hover:text-blue-900 mr-3"
                    >
                      View
                    </button>
                    {canRefund(payment) && (
                      <button
                        onClick={() => openRefundModal(payment)}
                        className="text-purple-600 hover:text-purple-900"
                      >
                        Refund
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Payment Detail Modal */}
      {selectedPayment && !showRefundModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Payment Details</h2>
                <button
                  onClick={() => setSelectedPayment(null)}
                  className="text-gray-500 hover:text-gray-600"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Transaction ID</span>
                <span className="text-sm font-mono font-medium text-gray-900">{selectedPayment.transactionId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Invoice ID</span>
                <span className="text-sm text-gray-900">{selectedPayment.invoiceId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Status</span>
                <span className={`px-2 py-1 text-xs font-medium rounded-full ${statusColors[selectedPayment.status] || 'bg-gray-100 text-gray-700'}`}>
                  {statusLabels[selectedPayment.status] || selectedPayment.status}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Method</span>
                <span className="text-sm text-gray-900">{methodLabels[selectedPayment.paymentMethod] || selectedPayment.paymentMethod}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">Payment Date</span>
                <span className="text-sm text-gray-900">{formatDateTime(selectedPayment.paymentDate)}</span>
              </div>
              {selectedPayment.processedAt && (
                <div className="flex justify-between">
                  <span className="text-sm text-gray-500">Processed At</span>
                  <span className="text-sm text-gray-900">{formatDateTime(selectedPayment.processedAt)}</span>
                </div>
              )}
              {selectedPayment.failureReason && (
                <div className="flex justify-between">
                  <span className="text-sm text-gray-500">Failure Reason</span>
                  <span className="text-sm text-red-600">{selectedPayment.failureReason}</span>
                </div>
              )}
              {selectedPayment.notes && (
                <div className="flex justify-between">
                  <span className="text-sm text-gray-500">Notes</span>
                  <span className="text-sm text-gray-900 max-w-[200px] text-right">{selectedPayment.notes}</span>
                </div>
              )}
              {selectedPayment.createdBy && (
                <div className="flex justify-between">
                  <span className="text-sm text-gray-500">Recorded By</span>
                  <span className="text-sm text-gray-900">{selectedPayment.createdBy}</span>
                </div>
              )}

              <div className="border-t border-gray-200 pt-4 mt-4">
                <div className="flex justify-between py-2">
                  <span className="text-sm text-gray-600">Amount</span>
                  <span className="text-sm font-medium text-gray-900">{formatCurrency(selectedPayment.amount, selectedPayment.currency)}</span>
                </div>
                {selectedPayment.refundedAmount > 0 && (
                  <div className="flex justify-between py-2">
                    <span className="text-sm text-gray-600">Refunded</span>
                    <span className="text-sm font-medium text-purple-600">-{formatCurrency(selectedPayment.refundedAmount, selectedPayment.currency)}</span>
                  </div>
                )}
                <div className="flex justify-between pt-3 border-t border-gray-200 mt-3">
                  <span className="text-sm font-semibold text-gray-900">Net Amount</span>
                  <span className="text-sm font-bold text-gray-900">
                    {formatCurrency(selectedPayment.amount - (selectedPayment.refundedAmount || 0), selectedPayment.currency)}
                  </span>
                </div>
              </div>

              {/* Refund History */}
              {selectedPayment.refunds && selectedPayment.refunds.length > 0 && (
                <div className="border-t border-gray-200 pt-4 mt-4">
                  <h3 className="text-sm font-semibold text-gray-900 mb-3">Refund History</h3>
                  <div className="space-y-2">
                    {selectedPayment.refunds.map((refund, idx) => (
                      <div key={idx} className="bg-purple-50 border border-purple-100 rounded-lg p-3">
                        <div className="flex justify-between">
                          <span className="text-sm text-purple-800 font-medium">
                            {formatCurrency(refund.amount, selectedPayment.currency)}
                          </span>
                          <span className="text-xs text-purple-600">{formatDate(refund.refundedAt)}</span>
                        </div>
                        <p className="text-xs text-purple-700 mt-1">{refund.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-gray-200 flex gap-3">
              {canRefund(selectedPayment) && (
                <button
                  onClick={() => {
                    openRefundModal(selectedPayment);
                    setSelectedPayment(null);
                  }}
                  className="flex-1 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors"
                >
                  Issue Refund
                </button>
              )}
              <button
                onClick={() => setSelectedPayment(null)}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Record Payment Modal */}
      {showRecordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Record Payment</h2>
                <button
                  onClick={() => setShowRecordModal(false)}
                  className="text-gray-500 hover:text-gray-600"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Invoice ID <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={recordForm.invoiceId}
                  onChange={(e) => setRecordForm({ ...recordForm, invoiceId: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  placeholder="Enter invoice ID (UUID)"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Amount <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={recordForm.amount}
                    onChange={(e) => setRecordForm({ ...recordForm, amount: e.target.value })}
                    className="w-full pl-7 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Payment Method <span className="text-red-500">*</span>
                </label>
                <select
                  value={recordForm.paymentMethod}
                  onChange={(e) => setRecordForm({ ...recordForm, paymentMethod: e.target.value as PaymentMethod })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                >
                  {Object.entries(methodLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Payment Date
                </label>
                <input
                  type="date"
                  value={recordForm.paymentDate}
                  onChange={(e) => setRecordForm({ ...recordForm, paymentDate: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Notes
                </label>
                <textarea
                  value={recordForm.notes}
                  onChange={(e) => setRecordForm({ ...recordForm, notes: e.target.value })}
                  rows={2}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  placeholder="Optional notes..."
                />
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex gap-3">
              <button
                onClick={() => setShowRecordModal(false)}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                disabled={recordLoading}
              >
                Cancel
              </button>
              <button
                onClick={handleRecordPayment}
                disabled={recordLoading}
                className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {recordLoading ? 'Recording...' : 'Record Payment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Refund Modal */}
      {showRefundModal && refundPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Issue Refund</h2>
              <p className="text-sm text-gray-500 mt-1">
                Transaction: {refundPayment.transactionId}
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                <div className="flex justify-between text-sm">
                  <span className="text-purple-700">Original Amount</span>
                  <span className="font-medium text-purple-900">{formatCurrency(refundPayment.amount, refundPayment.currency)}</span>
                </div>
                {refundPayment.refundedAmount > 0 && (
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-purple-700">Already Refunded</span>
                    <span className="font-medium text-purple-900">{formatCurrency(refundPayment.refundedAmount, refundPayment.currency)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm mt-1 pt-1 border-t border-purple-200">
                  <span className="text-purple-700 font-medium">Max Refundable</span>
                  <span className="font-bold text-purple-900">
                    {formatCurrency(refundPayment.amount - (refundPayment.refundedAmount || 0), refundPayment.currency)}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Refund Amount <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={refundPayment.amount - (refundPayment.refundedAmount || 0)}
                    value={refundForm.amount}
                    onChange={(e) => setRefundForm({ ...refundForm, amount: e.target.value })}
                    className="w-full pl-7 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={refundForm.reason}
                  onChange={(e) => setRefundForm({ ...refundForm, reason: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                  placeholder="Enter refund reason..."
                />
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex gap-3">
              <button
                onClick={() => { setShowRefundModal(false); setRefundPayment(null); }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                disabled={refundLoading}
              >
                Cancel
              </button>
              <button
                onClick={handleRefundPayment}
                disabled={refundLoading || !refundForm.reason.trim()}
                className="flex-1 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
              >
                {refundLoading ? 'Processing...' : 'Confirm Refund'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PaymentsPage;
