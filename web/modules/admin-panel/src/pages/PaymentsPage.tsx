/**
 * Payment Management Page
 * View, record, and refund payments across all tenants
 */

import React, { useState, useEffect, useCallback } from 'react';
import { DataTable, Modal, type DataTableColumn, PageHeader } from '@aquaculture/shared-ui';
import { billingApi, PaymentOverview, PaymentStatus, PaymentMethod } from '../services/adminApi';
import { Search } from 'lucide-react';

// ============================================================================
// Helpers
// ============================================================================

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
  [PaymentStatus.CANCELLED]: 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
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

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [invoiceIdFilter, setInvoiceIdFilter] = useState('');

  // Toast
  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

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
        status: statusFilter !== 'all' ? statusFilter : undefined,
        invoiceId: invoiceIdFilter || undefined,
        limit: 50,
      });

      const mapped = (data.payments || []).map((p: PaymentOverview) => ({
        ...p,
        amount: typeof p.amount === 'string' ? parseFloat(p.amount as unknown as string) : p.amount,
        refundedAmount:
          typeof p.refundedAmount === 'string'
            ? parseFloat(p.refundedAmount as unknown as string)
            : p.refundedAmount || 0,
      }));

      setPayments(mapped);
      setTotalPayments(data.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payments');
      setPayments([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, invoiceIdFilter]);

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
        paymentDate: recordForm.paymentDate
          ? new Date(recordForm.paymentDate).toISOString()
          : undefined,
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

  const closeRefundModal = (): void => {
    setShowRefundModal(false);
    setRefundPayment(null);
  };

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
      showToast(
        `Refund amount exceeds refundable amount (${formatCurrency(maxRefundable)})`,
        'error',
      );
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
      (payment.status === PaymentStatus.SUCCEEDED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED) &&
      payment.amount - (payment.refundedAmount || 0) > 0.01
    );
  };

  // ============================================================================
  // Stats summary
  // ============================================================================

  const succeededPayments = payments.filter(
    (p) => p.status === PaymentStatus.SUCCEEDED || p.status === PaymentStatus.PARTIALLY_REFUNDED,
  );
  const totalSucceeded = succeededPayments.reduce((sum, p) => sum + p.amount, 0);
  const totalRefunded = payments.reduce((sum, p) => sum + (p.refundedAmount || 0), 0);

  // ============================================================================
  // Render
  // ============================================================================

  const paymentColumns: DataTableColumn<PaymentOverview>[] = [
    {
      key: 'transactionId',
      header: 'Transaction',
      render: (_value, payment) => (
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 font-mono">
          {payment.transactionId}
        </div>
      ),
    },
    {
      key: 'invoiceId',
      header: 'Invoice',
      render: (_value, payment) => (
        <div className="text-sm text-blue-600">
          {(payment as PaymentOverview & { invoiceNumber?: string }).invoiceNumber ||
            payment.invoiceId.substring(0, 8) + '...'}
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      render: (_value, payment) => (
        <>
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {formatCurrency(payment.amount, payment.currency)}
          </div>
          {payment.refundedAmount > 0 && (
            <div className="text-xs text-purple-600">
              Refunded: {formatCurrency(payment.refundedAmount, payment.currency)}
            </div>
          )}
        </>
      ),
    },
    {
      key: 'paymentMethod',
      header: 'Method',
      render: (_value, payment) => (
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {methodLabels[payment.paymentMethod] || payment.paymentMethod}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, payment) => (
        <span
          className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${statusColors[payment.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
        >
          {statusLabels[payment.status] || payment.status}
        </span>
      ),
    },
    {
      key: 'paymentDate',
      header: 'Date',
      render: (_value, payment) => (
        <div className="text-sm text-gray-900 dark:text-gray-100">
          {formatDate(payment.paymentDate)}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, payment) => (
        <>
          <button
            type="button"
            onClick={() => setSelectedPayment(payment)}
            className="text-blue-600 hover:text-blue-900 mr-3"
          >
            View
          </button>
          {canRefund(payment) && (
            <button
              type="button"
              onClick={() => openRefundModal(payment)}
              className="text-purple-600 hover:text-purple-900"
            >
              Refund
            </button>
          )}
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Toast */}
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
      <PageHeader
        title="Payments"
        description="Record, track, and manage payments across all tenants"
        actions={
          <button
            onClick={() => setShowRecordModal(true)}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Record Payment
          </button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total Payments</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">
            {totalPayments}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Succeeded Amount</p>
          <p className="text-2xl font-bold text-green-600 mt-1">{formatCurrency(totalSucceeded)}</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Refunded</p>
          <p className="text-2xl font-bold text-purple-600 mt-1">{formatCurrency(totalRefunded)}</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Net Revenue</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">
            {formatCurrency(totalSucceeded - totalRefunded)}
          </p>
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
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <input
                type="text"
                placeholder="Filter by invoice ID..."
                value={invoiceIdFilter}
                onChange={(e) => setInvoiceIdFilter(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              />
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 dark:text-gray-400"
                aria-hidden="true"
              />
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {['all', 'succeeded', 'pending', 'failed', 'refunded'].map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors capitalize ${
                  statusFilter === status
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Payment Table */}
      <DataTable<PaymentOverview>
        data={payments}
        columns={paymentColumns}
        keyExtractor={(payment) => payment.id}
        loading={loading}
        loadingMessage="Loading payments..."
        emptyMessage="No payments found"
        searchable={false}
        sortable={false}
        stickyHeader={false}
      />

      {/* Payment Detail Modal */}
      {selectedPayment && !showRefundModal && (
        <Modal
          isOpen
          onClose={() => setSelectedPayment(null)}
          size="md"
          title="Payment Details"
          bodyClassName="p-6 space-y-4"
          footer={
            <>
              {canRefund(selectedPayment) && (
                <button
                  type="button"
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
                type="button"
                onClick={() => setSelectedPayment(null)}
                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Close
              </button>
            </>
          }
        >
          <div className="flex justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Transaction ID</span>
            <span className="text-sm font-mono font-medium text-gray-900 dark:text-gray-100">
              {selectedPayment.transactionId}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Invoice ID</span>
            <span className="text-sm text-gray-900 dark:text-gray-100">
              {selectedPayment.invoiceId}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Status</span>
            <span
              className={`px-2 py-1 text-xs font-medium rounded-full ${statusColors[selectedPayment.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
            >
              {statusLabels[selectedPayment.status] || selectedPayment.status}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Method</span>
            <span className="text-sm text-gray-900 dark:text-gray-100">
              {methodLabels[selectedPayment.paymentMethod] || selectedPayment.paymentMethod}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Payment Date</span>
            <span className="text-sm text-gray-900 dark:text-gray-100">
              {formatDateTime(selectedPayment.paymentDate)}
            </span>
          </div>
          {selectedPayment.processedAt && (
            <div className="flex justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Processed At</span>
              <span className="text-sm text-gray-900 dark:text-gray-100">
                {formatDateTime(selectedPayment.processedAt)}
              </span>
            </div>
          )}
          {selectedPayment.failureReason && (
            <div className="flex justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Failure Reason</span>
              <span className="text-sm text-red-600">{selectedPayment.failureReason}</span>
            </div>
          )}
          {selectedPayment.notes && (
            <div className="flex justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Notes</span>
              <span className="text-sm text-gray-900 dark:text-gray-100 max-w-[200px] text-right">
                {selectedPayment.notes}
              </span>
            </div>
          )}
          {selectedPayment.createdBy && (
            <div className="flex justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Recorded By</span>
              <span className="text-sm text-gray-900 dark:text-gray-100">
                {selectedPayment.createdBy}
              </span>
            </div>
          )}

          <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4">
            <div className="flex justify-between py-2">
              <span className="text-sm text-gray-600 dark:text-gray-400">Amount</span>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {formatCurrency(selectedPayment.amount, selectedPayment.currency)}
              </span>
            </div>
            {selectedPayment.refundedAmount > 0 && (
              <div className="flex justify-between py-2">
                <span className="text-sm text-gray-600 dark:text-gray-400">Refunded</span>
                <span className="text-sm font-medium text-purple-600">
                  -{formatCurrency(selectedPayment.refundedAmount, selectedPayment.currency)}
                </span>
              </div>
            )}
            <div className="flex justify-between pt-3 border-t border-gray-200 dark:border-gray-700 mt-3">
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Net Amount
              </span>
              <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
                {formatCurrency(
                  selectedPayment.amount - (selectedPayment.refundedAmount || 0),
                  selectedPayment.currency,
                )}
              </span>
            </div>
          </div>

          {/* Refund History */}
          {selectedPayment.refunds && selectedPayment.refunds.length > 0 && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Refund History
              </h3>
              <div className="space-y-2">
                {selectedPayment.refunds.map((refund, idx) => (
                  <div key={idx} className="bg-purple-50 border border-purple-100 rounded-lg p-3">
                    <div className="flex justify-between">
                      <span className="text-sm text-purple-800 font-medium">
                        {formatCurrency(refund.amount, selectedPayment.currency)}
                      </span>
                      <span className="text-xs text-purple-600">
                        {formatDate(refund.refundedAt)}
                      </span>
                    </div>
                    <p className="text-xs text-purple-700 mt-1">{refund.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* Record Payment Modal */}
      {showRecordModal && (
        <Modal
          isOpen
          onClose={() => setShowRecordModal(false)}
          size="sm"
          title="Record Payment"
          showCloseButton={!recordLoading}
          closeOnEscape={!recordLoading}
          closeOnOverlayClick={!recordLoading}
          bodyClassName="p-6 space-y-4"
          footer={
            <>
              <button
                type="button"
                onClick={() => setShowRecordModal(false)}
                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                disabled={recordLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRecordPayment}
                disabled={recordLoading}
                className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {recordLoading ? 'Recording...' : 'Record Payment'}
              </button>
            </>
          }
        >
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Invoice ID <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={recordForm.invoiceId}
              onChange={(e) => setRecordForm({ ...recordForm, invoiceId: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              placeholder="Enter invoice ID (UUID)"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Amount <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">
                $
              </span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={recordForm.amount}
                onChange={(e) => setRecordForm({ ...recordForm, amount: e.target.value })}
                className="w-full pl-7 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                placeholder="0.00"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Payment Method <span className="text-red-500">*</span>
            </label>
            <select
              value={recordForm.paymentMethod}
              onChange={(e) =>
                setRecordForm({ ...recordForm, paymentMethod: e.target.value as PaymentMethod })
              }
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
            >
              {Object.entries(methodLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Payment Date
            </label>
            <input
              type="date"
              value={recordForm.paymentDate}
              onChange={(e) => setRecordForm({ ...recordForm, paymentDate: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Notes
            </label>
            <textarea
              value={recordForm.notes}
              onChange={(e) => setRecordForm({ ...recordForm, notes: e.target.value })}
              rows={2}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              placeholder="Optional notes..."
            />
          </div>
        </Modal>
      )}

      {/* Refund Modal */}
      {showRefundModal && refundPayment && (
        <Modal
          isOpen
          onClose={closeRefundModal}
          size="sm"
          title="Issue Refund"
          description={`Transaction: ${refundPayment.transactionId}`}
          showCloseButton={!refundLoading}
          closeOnEscape={!refundLoading}
          closeOnOverlayClick={!refundLoading}
          bodyClassName="p-6 space-y-4"
          footer={
            <>
              <button
                type="button"
                onClick={closeRefundModal}
                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                disabled={refundLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRefundPayment}
                disabled={refundLoading || !refundForm.reason.trim()}
                className="flex-1 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
              >
                {refundLoading ? 'Processing...' : 'Confirm Refund'}
              </button>
            </>
          }
        >
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
            <div className="flex justify-between text-sm">
              <span className="text-purple-700">Original Amount</span>
              <span className="font-medium text-purple-900">
                {formatCurrency(refundPayment.amount, refundPayment.currency)}
              </span>
            </div>
            {refundPayment.refundedAmount > 0 && (
              <div className="flex justify-between text-sm mt-1">
                <span className="text-purple-700">Already Refunded</span>
                <span className="font-medium text-purple-900">
                  {formatCurrency(refundPayment.refundedAmount, refundPayment.currency)}
                </span>
              </div>
            )}
            <div className="flex justify-between text-sm mt-1 pt-1 border-t border-purple-200">
              <span className="text-purple-700 font-medium">Max Refundable</span>
              <span className="font-bold text-purple-900">
                {formatCurrency(
                  refundPayment.amount - (refundPayment.refundedAmount || 0),
                  refundPayment.currency,
                )}
              </span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Refund Amount <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">
                $
              </span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max={refundPayment.amount - (refundPayment.refundedAmount || 0)}
                value={refundForm.amount}
                onChange={(e) => setRefundForm({ ...refundForm, amount: e.target.value })}
                className="w-full pl-7 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Reason <span className="text-red-500">*</span>
            </label>
            <textarea
              value={refundForm.reason}
              onChange={(e) => setRefundForm({ ...refundForm, reason: e.target.value })}
              rows={3}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-500"
              placeholder="Enter refund reason..."
            />
          </div>
        </Modal>
      )}
    </div>
  );
};

export default PaymentsPage;
