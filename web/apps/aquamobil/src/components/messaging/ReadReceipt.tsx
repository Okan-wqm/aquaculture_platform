import { Clock, Check, CheckCheck } from 'lucide-react';
import React from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read';

interface ReadReceiptProps {
  /** Current delivery/read status of the message. */
  status: DeliveryStatus;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ReadReceipt -- WhatsApp-style delivery status icons.
 *
 * WHY React.memo: This is a pure presentational component rendered inside
 * every own-message bubble. Memoising avoids re-rendering hundreds of
 * receipt icons when the message list scrolls or a single message updates.
 *
 * WHY the on-accent ink rather than the ink ramp: a receipt only ever renders
 * inside an OWN bubble, which v4 fills with the accent. The pre-v4 classes were
 * a mid grey and the old brand blue — and the blue was the bubble's OWN
 * background colour, so "read" was invisible exactly when it mattered.
 * In-flight states are dimmed and `read` is full strength, which is the whole
 * distinction the control has to carry.
 */
const RECEIPT_PENDING = 'text-acc-on opacity-60 shrink-0';

export const ReadReceipt = React.memo(function ReadReceipt({ status }: ReadReceiptProps) {
  switch (status) {
    case 'pending':
      return <Clock size={12} className={RECEIPT_PENDING} aria-label="Sending" />;
    case 'sent':
      return <Check size={12} className={RECEIPT_PENDING} aria-label="Sent" />;
    case 'delivered':
      return <CheckCheck size={12} className={RECEIPT_PENDING} aria-label="Delivered" />;
    case 'read':
      return <CheckCheck size={12} className="text-acc-on shrink-0" aria-label="Read" />;
  }
});
