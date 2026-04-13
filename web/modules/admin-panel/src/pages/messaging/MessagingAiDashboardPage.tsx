/**
 * Messaging AI Dashboard Page
 *
 * SUPER_ADMIN AI analytics dashboard for the messaging service.
 *
 * All AI analytics metrics (sentiment analysis, knowledge entries,
 * embedding status, model performance, channel usage) require data
 * pipelines that are not yet implemented. This page shows honest
 * "not yet available" states for each section with clear descriptions
 * of what infrastructure is needed.
 *
 * The only real data available is the AI persona list, which is
 * accessible via the dedicated AI Personas page.
 */

import React from 'react';
import { Card, Badge } from '@aquaculture/shared-ui';

// ============================================================================
// NotAvailableSection Component
// ============================================================================

/** Renders a section with an honest "not yet available" explanation. */
const NotAvailableSection: React.FC<{
  title: string;
  description: string;
  requirement: string;
  color?: 'blue' | 'purple' | 'green' | 'yellow';
}> = ({ title, description, requirement, color = 'blue' }) => {
  const colorMap = {
    blue: {
      bg: 'bg-blue-50',
      border: 'border-blue-200',
      icon: 'text-blue-400',
      title: 'text-blue-900',
      text: 'text-blue-700',
      badge: 'bg-blue-100 text-blue-700',
    },
    purple: {
      bg: 'bg-purple-50',
      border: 'border-purple-200',
      icon: 'text-purple-400',
      title: 'text-purple-900',
      text: 'text-purple-700',
      badge: 'bg-purple-100 text-purple-700',
    },
    green: {
      bg: 'bg-green-50',
      border: 'border-green-200',
      icon: 'text-green-400',
      title: 'text-green-900',
      text: 'text-green-700',
      badge: 'bg-green-100 text-green-700',
    },
    yellow: {
      bg: 'bg-yellow-50',
      border: 'border-yellow-200',
      icon: 'text-yellow-400',
      title: 'text-yellow-900',
      text: 'text-yellow-700',
      badge: 'bg-yellow-100 text-yellow-700',
    },
  };

  const c = colorMap[color];

  return (
    <Card className={`${c.bg} ${c.border}`}>
      <div className="p-5">
        <div className="flex items-start gap-3">
          <svg className={`w-5 h-5 ${c.icon} mt-0.5 flex-shrink-0`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <h3 className={`text-sm font-semibold ${c.title}`}>{title}</h3>
            <p className={`text-xs ${c.text} mt-1 leading-relaxed`}>{description}</p>
            <div className="mt-2">
              <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-full ${c.badge}`}>
                Requires: {requirement}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const MessagingAiDashboardPage: React.FC = () => {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">AI Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">
          AI analytics, embeddings, and model performance
        </p>
      </div>

      {/* Status Banner */}
      <Card>
        <div className="p-5">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900">
                AI Analytics Infrastructure Not Yet Available
              </h3>
              <p className="text-sm text-gray-600 mt-1 leading-relaxed">
                The AI analytics dashboard requires real-time data pipelines for
                sentiment analysis, embedding statistics, model performance metrics,
                and per-tenant AI channel usage. These pipelines are planned but not
                yet implemented. Each section below describes the specific
                infrastructure requirement.
              </p>
              <div className="flex gap-2 mt-3">
                <Badge variant="warning">No Backend Endpoints</Badge>
                <Badge variant="info">Data Pipelines Required</Badge>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Top Stats Grid -- All Not Available */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NotAvailableSection
          title="Model Information"
          description="Display the active embedding model name, version, dimension count, and average inference latency. Requires an endpoint in ai-service that exposes loaded model metadata."
          requirement="GET /ai/model-info endpoint"
          color="purple"
        />
        <NotAvailableSection
          title="Embedding Coverage"
          description="Show the percentage of messages that have been embedded, total embedded count vs total message count, and backfill progress. Requires a vector-store statistics query."
          requirement="Vector store metrics pipeline"
          color="blue"
        />
      </div>

      {/* Two-column: Sentiment + Knowledge */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <NotAvailableSection
          title="Sentiment Analysis per Tenant"
          description="Average sentiment scores (-1 to +1 scale) per tenant computed from AI-analyzed message content. Requires a sentiment analysis pipeline that processes messages through an NLP model and aggregates results per tenant."
          requirement="NLP sentiment pipeline + aggregation"
          color="green"
        />
        <NotAvailableSection
          title="Knowledge Entries per Tenant"
          description="Per-tenant breakdown of knowledge base entries by category (water quality, feeding, equipment, etc.). Requires a knowledge management system with categorized entries and a query endpoint for admin aggregation."
          requirement="Knowledge management service"
          color="yellow"
        />
      </div>

      {/* AI Channel Usage */}
      <NotAvailableSection
        title="AI Channel Usage per Tenant"
        description="Table of per-tenant AI channel usage including total chat sessions, active channels, and average AI response time. Requires real-time session tracking and response latency measurement in the messaging-service AI chat bridge."
        requirement="Session tracking + latency metrics in ai-chat-bridge"
        color="purple"
      />

      {/* Architecture Note */}
      <Card className="p-4 bg-blue-50 border-blue-200">
        <h3 className="text-sm font-semibold text-blue-900 mb-1">
          Architecture Note
        </h3>
        <p className="text-xs text-blue-700 leading-relaxed">
          AI analytics require several backend infrastructure components that are
          not yet in place: (1) A vector-store statistics endpoint for embedding
          coverage, (2) An NLP sentiment pipeline with per-tenant aggregation,
          (3) A knowledge management service, and (4) Session/latency tracking
          in the AI chat bridge. For current AI configuration, use the
          <strong> AI Personas</strong> page which connects to the real backend
          persona registry.
        </p>
      </Card>
    </div>
  );
};

export default MessagingAiDashboardPage;
