/**
 * Announcements Page
 *
 * Platform duyuru sistemi - global ve hedefli duyurular.
 * Scheduling, acknowledgment tracking, announcement types.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Megaphone,
  Plus,
  Search,
  Filter,
  Calendar,
  Clock,
  Eye,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Wrench,
  Info,
  Send,
  Edit3,
  Trash2,
  X,
  Globe,
  Target,
  Users,
  BarChart3,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { supportApi } from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

type AnnouncementType = 'info' | 'warning' | 'critical' | 'maintenance';
type AnnouncementStatus = 'draft' | 'scheduled' | 'published' | 'expired' | 'cancelled';

interface Announcement {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  status: AnnouncementStatus;
  isGlobal: boolean;
  targetCriteria?: AnnouncementTarget;
  publishAt?: string;
  expiresAt?: string;
  requiresAcknowledgment: boolean;
  viewCount: number;
  acknowledgmentCount: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

interface AnnouncementTarget {
  tenantIds?: string[];
  excludeTenantIds?: string[];
  plans?: string[];
  modules?: string[];
  regions?: string[];
}

interface AnnouncementStats {
  total: number;
  published: number;
  scheduled: number;
  draft: number;
  expired: number;
  totalViews: number;
  totalAcknowledgments: number;
  byType: Record<AnnouncementType, number>;
}

// ============================================================================
// Component
// ============================================================================

export const AnnouncementsPage: React.FC = () => {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [stats, setStats] = useState<AnnouncementStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<AnnouncementStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<AnnouncementType | 'all'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<Announcement | null>(null);

  // Fetch announcements from API
  const fetchAnnouncements = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params: Record<string, unknown> = { limit: 100 };
      if (statusFilter !== 'all') params.status = statusFilter;
      if (typeFilter !== 'all') params.type = typeFilter;

      const result = await supportApi.getAnnouncements(params);
      setAnnouncements(result.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setAnnouncements([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  // Fetch stats from API
  const fetchStats = useCallback(async () => {
    try {
      // Note: stats endpoint may not exist in supportApi, keeping direct fetch as fallback
      const response = await fetch('/api/support/announcements/stats', {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('access_token')}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setStats(data);
      }
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, []);

  useEffect(() => {
    fetchAnnouncements();
    fetchStats();
  }, [fetchAnnouncements, fetchStats]);

  const filteredAnnouncements = announcements.filter(ann => {
    if (searchQuery && !ann.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !ann.content.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    return true;
  });

  const getTypeIcon = (type: AnnouncementType) => {
    switch (type) {
      case 'info': return <Info size={16} className="text-blue-500" />;
      case 'warning': return <AlertTriangle size={16} className="text-yellow-500" />;
      case 'critical': return <AlertCircle size={16} className="text-red-500" />;
      case 'maintenance': return <Wrench size={16} className="text-purple-500" />;
    }
  };

  const getTypeColor = (type: AnnouncementType) => {
    switch (type) {
      case 'info': return 'bg-blue-100 text-blue-700';
      case 'warning': return 'bg-yellow-100 text-yellow-700';
      case 'critical': return 'bg-red-100 text-red-700';
      case 'maintenance': return 'bg-purple-100 text-purple-700';
    }
  };

  const getStatusColor = (status: AnnouncementStatus) => {
    switch (status) {
      case 'draft': return 'bg-gray-100 text-gray-700';
      case 'scheduled': return 'bg-blue-100 text-blue-700';
      case 'published': return 'bg-green-100 text-green-700';
      case 'expired': return 'bg-gray-100 text-gray-500';
      case 'cancelled': return 'bg-red-100 text-red-700';
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handlePublish = async (id: string) => {
    try {
      await supportApi.publishAnnouncement(id);
      fetchAnnouncements();
      fetchStats();
    } catch (err) {
      console.error('Failed to publish:', err);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await supportApi.unpublishAnnouncement(id);
      fetchAnnouncements();
      fetchStats();
    } catch (err) {
      console.error('Failed to cancel:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await supportApi.deleteAnnouncement(id);
      fetchAnnouncements();
      fetchStats();
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  };

  const handleCreateAnnouncement = async (data: Partial<Announcement>) => {
    try {
      await supportApi.createAnnouncement(data as Parameters<typeof supportApi.createAnnouncement>[0]);
      setShowCreateModal(false);
      fetchAnnouncements();
      fetchStats();
    } catch (err) {
      console.error('Failed to create announcement:', err);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Announcements</h1>
            <p className="text-gray-500 mt-1">Broadcast messages to all tenants</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { fetchAnnouncements(); fetchStats(); }}
              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
            >
              <RefreshCw size={18} />
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Plus size={18} />
              Create Announcement
            </button>
          </div>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-7 gap-4 mt-4">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-sm text-gray-500">Total</div>
              <div className="text-xl font-semibold text-gray-900">{stats.total}</div>
            </div>
            <div className="bg-green-50 rounded-lg p-3">
              <div className="text-sm text-green-600">Published</div>
              <div className="text-xl font-semibold text-green-700">{stats.published}</div>
            </div>
            <div className="bg-blue-50 rounded-lg p-3">
              <div className="text-sm text-blue-600">Scheduled</div>
              <div className="text-xl font-semibold text-blue-700">{stats.scheduled}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-sm text-gray-500">Draft</div>
              <div className="text-xl font-semibold text-gray-900">{stats.draft}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-sm text-gray-500">Expired</div>
              <div className="text-xl font-semibold text-gray-600">{stats.expired}</div>
            </div>
            <div className="bg-purple-50 rounded-lg p-3">
              <div className="text-sm text-purple-600">Total Views</div>
              <div className="text-xl font-semibold text-purple-700">{stats.totalViews.toLocaleString()}</div>
            </div>
            <div className="bg-indigo-50 rounded-lg p-3">
              <div className="text-sm text-indigo-600">Acknowledged</div>
              <div className="text-xl font-semibold text-indigo-700">{stats.totalAcknowledgments.toLocaleString()}</div>
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              placeholder="Search announcements..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as AnnouncementStatus | 'all')}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Status</option>
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="published">Published</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as AnnouncementType | 'all')}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Types</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </div>
      </div>

      {/* Loading/Error States */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="animate-spin text-blue-600" size={32} />
        </div>
      )}

      {error && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <AlertCircle className="mx-auto text-red-500 mb-2" size={32} />
            <p className="text-red-600">{error}</p>
            <button
              onClick={fetchAnnouncements}
              className="mt-2 px-4 py-2 text-sm text-blue-600 hover:text-blue-700"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Announcement List */}
      {!loading && !error && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-4">
            {filteredAnnouncements.map((announcement) => (
              <div
                key={announcement.id}
                className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="mt-1">{getTypeIcon(announcement.type)}</div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-semibold text-gray-900">
                            {announcement.title}
                          </h3>
                          <span className={`px-2 py-0.5 text-xs rounded-full ${getStatusColor(announcement.status)}`}>
                            {announcement.status}
                          </span>
                          <span className={`px-2 py-0.5 text-xs rounded-full ${getTypeColor(announcement.type)}`}>
                            {announcement.type}
                          </span>
                        </div>
                        <p className="text-gray-600 mt-1 line-clamp-2">{announcement.content}</p>

                        {/* Meta Info */}
                        <div className="flex items-center gap-4 mt-3 text-sm text-gray-500">
                          {announcement.isGlobal ? (
                            <span className="flex items-center gap-1">
                              <Globe size={14} />
                              All Tenants
                            </span>
                          ) : (
                            <span className="flex items-center gap-1">
                              <Target size={14} />
                              Targeted
                            </span>
                          )}
                          {announcement.publishAt && (
                            <span className="flex items-center gap-1">
                              <Calendar size={14} />
                              {formatDate(announcement.publishAt)}
                            </span>
                          )}
                          {announcement.requiresAcknowledgment && (
                            <span className="flex items-center gap-1 text-purple-600">
                              <CheckCircle size={14} />
                              Requires Ack
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Eye size={14} />
                            {announcement.viewCount} views
                          </span>
                          {announcement.requiresAcknowledgment && (
                            <span className="flex items-center gap-1">
                              <CheckCircle size={14} />
                              {announcement.acknowledgmentCount} acknowledged
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      {announcement.status === 'draft' && (
                        <>
                          <button
                            onClick={() => handlePublish(announcement.id)}
                            className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-green-600 rounded-lg hover:bg-green-700"
                          >
                            <Send size={14} />
                            Publish
                          </button>
                          <button
                            onClick={() => setSelectedAnnouncement(announcement)}
                            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                          >
                            <Edit3 size={16} />
                          </button>
                          <button
                            onClick={() => handleDelete(announcement.id)}
                            className="p-2 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50"
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                      {announcement.status === 'scheduled' && (
                        <>
                          <button
                            onClick={() => handlePublish(announcement.id)}
                            className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-green-600 rounded-lg hover:bg-green-700"
                          >
                            <Send size={14} />
                            Publish Now
                          </button>
                          <button
                            onClick={() => handleCancel(announcement.id)}
                            className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {announcement.status === 'published' && (
                        <button
                          onClick={() => setSelectedAnnouncement(announcement)}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                        >
                          <BarChart3 size={14} />
                          View Stats
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {filteredAnnouncements.length === 0 && (
              <div className="text-center py-12 text-gray-500">
                <Megaphone size={48} className="mx-auto mb-3 text-gray-300" />
                <p>No announcements found</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      {showCreateModal && (
        <AnnouncementFormModal
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreateAnnouncement}
        />
      )}

      {/* Stats Modal */}
      {selectedAnnouncement && (
        <AnnouncementStatsModal
          announcement={selectedAnnouncement}
          onClose={() => setSelectedAnnouncement(null)}
        />
      )}
    </div>
  );
};

// ============================================================================
// Sub-components
// ============================================================================

interface AnnouncementFormModalProps {
  announcement?: Announcement;
  onClose: () => void;
  onSave: (data: Partial<Announcement>) => void;
}

const AnnouncementFormModal: React.FC<AnnouncementFormModalProps> = ({
  announcement,
  onClose,
  onSave,
}) => {
  const [title, setTitle] = useState(announcement?.title || '');
  const [content, setContent] = useState(announcement?.content || '');
  const [type, setType] = useState<AnnouncementType>(announcement?.type || 'info');
  const [isGlobal, setIsGlobal] = useState(announcement?.isGlobal ?? true);
  const [scheduleType, setScheduleType] = useState<'now' | 'scheduled'>('now');
  const [publishAt, setPublishAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [requiresAcknowledgment, setRequiresAcknowledgment] = useState(announcement?.requiresAcknowledgment ?? false);

  const handleSubmit = () => {
    onSave({
      title,
      content,
      type,
      isGlobal,
      publishAt: scheduleType === 'scheduled' ? new Date(publishAt).toISOString() : undefined,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      requiresAcknowledgment,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            {announcement ? 'Edit Announcement' : 'Create Announcement'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Enter announcement title..."
            />
          </div>

          {/* Content */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Enter announcement content..."
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Type</label>
            <div className="grid grid-cols-4 gap-3">
              {(['info', 'warning', 'critical', 'maintenance'] as AnnouncementType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`flex items-center justify-center gap-2 px-4 py-2 rounded-lg border transition-colors ${
                    type === t
                      ? t === 'info' ? 'bg-blue-100 border-blue-300 text-blue-700'
                      : t === 'warning' ? 'bg-yellow-100 border-yellow-300 text-yellow-700'
                      : t === 'critical' ? 'bg-red-100 border-red-300 text-red-700'
                      : 'bg-purple-100 border-purple-300 text-purple-700'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {t === 'info' && <Info size={16} />}
                  {t === 'warning' && <AlertTriangle size={16} />}
                  {t === 'critical' && <AlertCircle size={16} />}
                  {t === 'maintenance' && <Wrench size={16} />}
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Target */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Target Audience</label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setIsGlobal(true)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border ${
                  isGlobal ? 'bg-blue-100 border-blue-300 text-blue-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                <Globe size={18} />
                All Tenants
              </button>
              <button
                type="button"
                onClick={() => setIsGlobal(false)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border ${
                  !isGlobal ? 'bg-blue-100 border-blue-300 text-blue-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                <Target size={18} />
                Targeted
              </button>
            </div>
          </div>

          {/* Scheduling */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Publishing</label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setScheduleType('now')}
                className={`flex-1 px-4 py-2 rounded-lg border ${
                  scheduleType === 'now' ? 'bg-blue-100 border-blue-300 text-blue-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                Save as Draft
              </button>
              <button
                type="button"
                onClick={() => setScheduleType('scheduled')}
                className={`flex-1 px-4 py-2 rounded-lg border ${
                  scheduleType === 'scheduled' ? 'bg-blue-100 border-blue-300 text-blue-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                Schedule
              </button>
            </div>
            {scheduleType === 'scheduled' && (
              <input
                type="datetime-local"
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
                className="w-full mt-3 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            )}
          </div>

          {/* Expiry */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Expiry Date (Optional)
            </label>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Options */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="requiresAck"
              checked={requiresAcknowledgment}
              onChange={(e) => setRequiresAcknowledgment(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
            />
            <label htmlFor="requiresAck" className="text-sm text-gray-700">
              Require acknowledgment from users
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title || !content}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {scheduleType === 'scheduled' ? 'Schedule' : 'Save Draft'}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AnnouncementStatsModalProps {
  announcement: Announcement;
  onClose: () => void;
}

const AnnouncementStatsModal: React.FC<AnnouncementStatsModalProps> = ({
  announcement,
  onClose,
}) => {
  const [acknowledgments, setAcknowledgments] = useState<Array<{
    userId: string;
    userName: string;
    tenantId: string;
    viewedAt: string;
    acknowledgedAt: string | null;
  }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAcknowledgments = async () => {
      try {
        const response = await fetch(`/api/support/announcements/${announcement.id}/acknowledgments`);
        if (response.ok) {
          const data = await response.json();
          setAcknowledgments(data.acknowledgments || []);
        }
      } catch (err) {
        console.error('Failed to fetch acknowledgments:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchAcknowledgments();
  }, [announcement.id]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Announcement Statistics</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Announcement Info */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="font-semibold text-gray-900">{announcement.title}</h3>
            <p className="text-sm text-gray-600 mt-1">{announcement.content}</p>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-blue-50 rounded-lg p-4 text-center">
              <Eye size={24} className="mx-auto text-blue-600 mb-2" />
              <div className="text-2xl font-bold text-blue-700">{announcement.viewCount}</div>
              <div className="text-sm text-blue-600">Total Views</div>
            </div>
            {announcement.requiresAcknowledgment && (
              <div className="bg-green-50 rounded-lg p-4 text-center">
                <CheckCircle size={24} className="mx-auto text-green-600 mb-2" />
                <div className="text-2xl font-bold text-green-700">{announcement.acknowledgmentCount}</div>
                <div className="text-sm text-green-600">Acknowledged</div>
              </div>
            )}
          </div>

          {/* Acknowledgments List */}
          {announcement.requiresAcknowledgment && (
            <div>
              <h4 className="font-medium text-gray-900 mb-3">Recent Activity</h4>
              {loading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="animate-spin text-blue-600" size={24} />
                </div>
              ) : acknowledgments.length > 0 ? (
                <div className="space-y-2">
                  {acknowledgments.map((ack) => (
                    <div key={ack.userId} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div>
                        <div className="font-medium text-gray-900">{ack.userName}</div>
                        <div className="text-sm text-gray-500">Tenant: {ack.tenantId}</div>
                      </div>
                      <div className="text-right">
                        {ack.acknowledgedAt ? (
                          <span className="flex items-center gap-1 text-green-600 text-sm">
                            <CheckCircle size={14} />
                            Acknowledged
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-gray-500 text-sm">
                            <Eye size={14} />
                            Viewed only
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-4">No activity yet</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default AnnouncementsPage;
