/**
 * Messaging AI Dashboard Page
 *
 * SUPER_ADMIN AI analytics dashboard for the messaging service.
 * Shows sentiment overview, knowledge entries, embedding status,
 * model info, and AI channel usage per tenant.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

interface TenantSentiment {
  tenantId: string;
  tenantName: string;
  avgSentiment: number; // -1 to 1 scale
  messageCount: number;
}

interface TenantKnowledge {
  tenantId: string;
  tenantName: string;
  totalEntries: number;
  categories: Record<string, number>;
}

interface EmbeddingStatus {
  totalMessages: number;
  embeddedMessages: number;
  backfillProgress: number; // 0-100
  isBackfilling: boolean;
}

interface ModelInfo {
  modelName: string;
  modelVersion: string;
  dimensions: number;
  avgInferenceMs: number;
}

interface AiChannelUsage {
  tenantId: string;
  tenantName: string;
  totalSessions: number;
  avgResponseTimeMs: number;
  activeChannels: number;
}

// ============================================================================
// Mock Data (TODO: Replace with admin API calls)
// ============================================================================

const MOCK_SENTIMENTS: TenantSentiment[] = [];
const MOCK_KNOWLEDGE: TenantKnowledge[] = [];

const MOCK_EMBEDDING: EmbeddingStatus = {
  totalMessages: 0,
  embeddedMessages: 0,
  backfillProgress: 0,
  isBackfilling: false,
};

const MOCK_MODEL: ModelInfo = {
  modelName: 'text-embedding-3-small',
  modelVersion: '2024-02',
  dimensions: 1536,
  avgInferenceMs: 45,
};

const MOCK_USAGE: AiChannelUsage[] = [];

// ============================================================================
// StatCard Component
// ============================================================================

const StatCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple';
}> = ({ title, value, subtitle, color = 'blue' }) => {
  const colorMap = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
  };

  return (
    <div className={`rounded-xl border p-5 ${colorMap[color]}`}>
      <p className="text-sm font-medium opacity-80">{title}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
      {subtitle && <p className="text-xs mt-1 opacity-60">{subtitle}</p>}
    </div>
  );
};

// ============================================================================
// SentimentBar Component
// ============================================================================

/** Renders a single horizontal bar for sentiment (-1 to 1 scale). */
const SentimentBar: React.FC<{ tenant: TenantSentiment }> = ({ tenant }) => {
  // Map -1..1 to 0..100 for positioning
  const normalized = ((tenant.avgSentiment + 1) / 2) * 100;
  const barColor =
    tenant.avgSentiment > 0.2
      ? 'bg-green-500'
      : tenant.avgSentiment < -0.2
        ? 'bg-red-500'
        : 'bg-yellow-500';

  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-xs text-gray-600 w-28 truncate text-right">{tenant.tenantName}</span>
      <div className="flex-1 relative h-5 bg-gray-100 rounded-full overflow-hidden">
        {/* Center line */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-300 z-10" />
        {/* Sentiment bar */}
        <div
          className={`absolute top-0 h-full rounded-full ${barColor} transition-all duration-500`}
          style={{
            left: tenant.avgSentiment >= 0 ? '50%' : `${normalized}%`,
            width: `${Math.abs(tenant.avgSentiment) * 50}%`,
          }}
        />
      </div>
      <span className="text-xs text-gray-500 w-10 text-right">
        {tenant.avgSentiment > 0 ? '+' : ''}
        {tenant.avgSentiment.toFixed(2)}
      </span>
    </div>
  );
};

// ============================================================================
// ProgressBar Component
// ============================================================================

const ProgressBar: React.FC<{ progress: number; color?: string }> = ({
  progress,
  color = 'bg-blue-500',
}) => (
  <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
    <div
      className={`h-full rounded-full ${color} transition-all duration-700`}
      style={{ width: `${Math.min(progress, 100)}%` }}
    />
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

const MessagingAiDashboardPage: React.FC = () => {
  const [sentiments, setSentiments] = useState<TenantSentiment[]>(MOCK_SENTIMENTS);
  const [knowledge, setKnowledge] = useState<TenantKnowledge[]>(MOCK_KNOWLEDGE);
  const [embedding, setEmbedding] = useState<EmbeddingStatus>(MOCK_EMBEDDING);
  const [model, setModel] = useState<ModelInfo>(MOCK_MODEL);
  const [usage, setUsage] = useState<AiChannelUsage[]>(MOCK_USAGE);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // TODO: Replace with actual admin API calls
      // const [sentRes, knowledgeRes, embedRes, modelRes, usageRes] = await Promise.all([
      //   adminApi.get('/admin/messaging/ai/sentiments'),
      //   adminApi.get('/admin/messaging/ai/knowledge'),
      //   adminApi.get('/admin/messaging/ai/embedding-status'),
      //   adminApi.get('/admin/messaging/ai/model-info'),
      //   adminApi.get('/admin/messaging/ai/channel-usage'),
      // ]);
      // setSentiments(sentRes.data);
      // setKnowledge(knowledgeRes.data);
      // setEmbedding(embedRes.data);
      // setModel(modelRes.data);
      // setUsage(usageRes.data);

      setSentiments(MOCK_SENTIMENTS);
      setKnowledge(MOCK_KNOWLEDGE);
      setEmbedding(MOCK_EMBEDDING);
      setModel(MOCK_MODEL);
      setUsage(MOCK_USAGE);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch AI dashboard data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const embeddingPercent =
    embedding.totalMessages > 0
      ? Math.round((embedding.embeddedMessages / embedding.totalMessages) * 100)
      : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            AI analytics, embeddings, and model performance
          </p>
        </div>
        <Button
          onClick={() => void fetchData()}
          disabled={loading}
          variant="secondary"
          size="sm"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {/* Top Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Model"
          value={model.modelName}
          subtitle={`v${model.modelVersion}`}
          color="purple"
        />
        <StatCard
          title="Dimensions"
          value={model.dimensions.toLocaleString()}
          color="blue"
        />
        <StatCard
          title="Avg Inference"
          value={`${model.avgInferenceMs}ms`}
          color="green"
        />
        <StatCard
          title="Embedding Coverage"
          value={`${embeddingPercent}%`}
          subtitle={`${embedding.embeddedMessages.toLocaleString()} / ${embedding.totalMessages.toLocaleString()}`}
          color={embeddingPercent >= 80 ? 'green' : embeddingPercent >= 50 ? 'yellow' : 'red'}
        />
      </div>

      {/* Embedding Status */}
      <Card>
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700">Embedding Backfill Progress</h3>
            {embedding.isBackfilling && (
              <Badge variant="warning">Backfilling...</Badge>
            )}
          </div>
          <ProgressBar
            progress={embedding.backfillProgress}
            color={embedding.backfillProgress >= 100 ? 'bg-green-500' : 'bg-blue-500'}
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-gray-500">
              {embedding.embeddedMessages.toLocaleString()} embedded
            </span>
            <span className="text-xs text-gray-500">
              {embedding.totalMessages.toLocaleString()} total
            </span>
          </div>
        </div>
      </Card>

      {/* Two-column: Sentiment + Knowledge */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sentiment Overview */}
        <Card>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">
              Average Sentiment per Tenant
            </h3>
            {sentiments.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <p className="text-sm text-gray-400">No sentiment data available yet.</p>
              </div>
            ) : (
              <div className="space-y-1">
                {/* Scale labels */}
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-[10px] text-gray-400 w-28 text-right">Tenant</span>
                  <div className="flex-1 flex justify-between">
                    <span className="text-[10px] text-red-400">Negative</span>
                    <span className="text-[10px] text-gray-400">Neutral</span>
                    <span className="text-[10px] text-green-400">Positive</span>
                  </div>
                  <span className="w-10" />
                </div>
                {sentiments.map((t) => (
                  <SentimentBar key={t.tenantId} tenant={t} />
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Knowledge Entries */}
        <Card>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">
              Knowledge Entries per Tenant
            </h3>
            {knowledge.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <p className="text-sm text-gray-400">No knowledge entries yet.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {knowledge.map((k) => (
                  <div
                    key={k.tenantId}
                    className="p-3 rounded-lg bg-gray-50 border border-gray-100"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-900">{k.tenantName}</span>
                      <Badge variant="info">{k.totalEntries} entries</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(k.categories).map(([cat, count]) => (
                        <span
                          key={cat}
                          className="px-2 py-0.5 text-[10px] font-medium bg-gray-200 text-gray-600 rounded-full"
                        >
                          {cat}: {count}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* AI Channel Usage */}
      <Card>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">AI Channel Usage per Tenant</h3>
          {usage.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                <p className="text-sm text-gray-500">No AI channel usage data yet.</p>
                <p className="text-xs text-gray-400 mt-1">
                  Usage data will appear once tenants start using AI channels.
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total Sessions</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Active Channels</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Response Time</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {usage.map((u) => (
                    <tr key={u.tenantId} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{u.tenantName}</p>
                        <p className="text-xs text-gray-400 font-mono">{u.tenantId.slice(0, 8)}...</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">
                        {u.totalSessions.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">
                        {u.activeChannels}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Badge variant={u.avgResponseTimeMs < 3000 ? 'success' : u.avgResponseTimeMs < 5000 ? 'warning' : 'error'}>
                          {(u.avgResponseTimeMs / 1000).toFixed(1)}s
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

export default MessagingAiDashboardPage;
