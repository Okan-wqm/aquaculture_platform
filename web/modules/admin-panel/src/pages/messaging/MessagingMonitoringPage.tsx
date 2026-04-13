/**
 * Messaging Monitoring Page
 *
 * Enterprise monitoring dashboard for SUPER_ADMIN.
 * The monitoring stats endpoint (GET /messaging/monitoring/stats) intentionally
 * returns 501 because real-time metrics infrastructure is not yet available.
 * This page shows an honest "Not available" state instead of fake zero stats.
 *
 * @see ADR-012 Phase 3
 */

import React from 'react';
import { Card } from '@aquaculture/shared-ui';

// ============================================================================
// Main Component
// ============================================================================

const MessagingMonitoringPage: React.FC = () => {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Monitoring</h1>
          <p className="text-sm text-gray-500 mt-1">
            Real-time overview of the messaging service
          </p>
        </div>
      </div>

      {/* Not Available State */}
      <Card>
        <div className="p-8">
          <div className="flex flex-col items-center justify-center py-12">
            <svg
              className="w-16 h-16 text-gray-300 mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>

            <h2 className="text-lg font-semibold text-gray-700 mb-2">
              Monitoring Dashboard Not Yet Available
            </h2>

            <p className="text-sm text-gray-500 text-center max-w-md mb-6">
              The monitoring dashboard requires real-time metrics infrastructure integration
              (Prometheus/Grafana or equivalent) which is not yet provisioned for the messaging service.
            </p>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 max-w-lg w-full">
              <h3 className="text-sm font-semibold text-amber-800 mb-2">What will be available here:</h3>
              <ul className="text-sm text-amber-700 space-y-1.5">
                <li className="flex items-start gap-2">
                  <span className="text-amber-400 mt-0.5">--</span>
                  Messages per hour / day with trend charts
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-amber-400 mt-0.5">--</span>
                  Active channels, online users, WebSocket connections
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-amber-400 mt-0.5">--</span>
                  Per-tenant messaging breakdown and storage usage
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-amber-400 mt-0.5">--</span>
                  Outbox health: pending events, failed events, publish latency
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-amber-400 mt-0.5">--</span>
                  System alerts and anomaly detection
                </li>
              </ul>
            </div>

            <p className="text-xs text-gray-400 mt-6">
              GET /messaging/monitoring/stats returns HTTP 501 (Not Implemented)
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default MessagingMonitoringPage;
