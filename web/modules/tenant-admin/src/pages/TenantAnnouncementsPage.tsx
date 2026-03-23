/**
 * Tenant Announcements Page
 *
 * View platform announcements for TenantAdmin.
 * - View published announcements
 * - Acknowledge announcements when required
 * - Filter by type and read status
 *
 * Data layer: GraphQL via graphqlRequest (announcement resolver).
 *
 * Note: TenantAdmin cannot:
 * - Create or edit platform announcements (only tenant-level)
 * - See draft/scheduled/cancelled announcements
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Megaphone,
  Search,
  Calendar,
  Clock,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Wrench,
  Info,
  Bell,
  X,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { graphqlRequest } from '../services/tenant-api.service';
import {
  MY_ANNOUNCEMENTS_QUERY,
  VIEW_ANNOUNCEMENT_MUTATION,
  ACKNOWLEDGE_ANNOUNCEMENT_MUTATION,
} from '../graphql';
import { logError } from '../utils/error-handling';

// ============================================================================
// Types (aligned with backend GraphQL DTOs)
// ============================================================================

type AnnouncementType = 'info' | 'warning' | 'critical' | 'maintenance';
type AnnouncementStatus = 'draft' | 'scheduled' | 'published' | 'expired' | 'cancelled';
type AnnouncementScope = 'platform' | 'tenant';

interface AnnouncementListItem {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  status: AnnouncementStatus;
  scope: AnnouncementScope;
  isGlobal: boolean;
  publishAt: string | null;
  expiresAt: string | null;
  requiresAcknowledgment: boolean;
  viewCount: number;
  acknowledgmentCount: number;
  createdByName: string;
  createdAt: string;
  isActive: boolean;
  hasViewed?: boolean;
  hasAcknowledged?: boolean;
}

// Helper to map announcement types for display
type DisplayAnnouncementType = 'info' | 'warning' | 'error' | 'maintenance';

const mapTypeForDisplay = (type: AnnouncementType): DisplayAnnouncementType => {
  if (type === 'critical') return 'error';
  return type as DisplayAnnouncementType;
};

// ============================================================================
// Component
// ============================================================================

export const TenantAnnouncementsPage: React.FC = () => {
  const [announcements, setAnnouncements] = useState<AnnouncementListItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<DisplayAnnouncementType | 'all'>('all');
  const [readFilter, setReadFilter] = useState<'all' | 'unread' | 'requires_ack'>('all');
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<AnnouncementListItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch announcements from GraphQL
  const fetchAnnouncements = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const result = await graphqlRequest<{ myAnnouncements: AnnouncementListItem[] }>(
        MY_ANNOUNCEMENTS_QUERY,
        {
          // Only show published announcements for tenant admin
          status: 'published' as AnnouncementStatus,
        },
      );

      setAnnouncements(result.myAnnouncements || []);
    } catch (err) {
      logError('TenantAnnouncementsPage.fetchAnnouncements', err);
      setError(err instanceof Error ? err.message : 'Failed to load announcements');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAnnouncements();
  }, [fetchAnnouncements]);

  // Stats
  const unreadCount = announcements.filter((a) => !a.hasViewed).length;
  const pendingAckCount = announcements.filter((a) => a.requiresAcknowledgment && !a.hasAcknowledged).length;

  const filteredAnnouncements = announcements.filter((ann) => {
    if (
      searchQuery &&
      !ann.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !ann.content.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false;
    }
    if (typeFilter !== 'all' && mapTypeForDisplay(ann.type) !== typeFilter) return false;
    if (readFilter === 'unread' && ann.hasViewed) return false;
    if (readFilter === 'requires_ack' && (!ann.requiresAcknowledgment || ann.hasAcknowledged)) return false;
    return true;
  });

  const getTypeIcon = (type: AnnouncementType) => {
    const displayType = mapTypeForDisplay(type);
    switch (displayType) {
      case 'info':
        return <Info size={18} className="text-blue-500" />;
      case 'warning':
        return <AlertTriangle size={18} className="text-yellow-500" />;
      case 'error':
        return <AlertCircle size={18} className="text-red-500" />;
      case 'maintenance':
        return <Wrench size={18} className="text-purple-500" />;
      default:
        return <Info size={18} className="text-blue-500" />;
    }
  };

  const getTypeColor = (type: AnnouncementType) => {
    const displayType = mapTypeForDisplay(type);
    switch (displayType) {
      case 'info':
        return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'warning':
        return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'error':
        return 'bg-red-100 text-red-700 border-red-200';
      case 'maintenance':
        return 'bg-purple-100 text-purple-700 border-purple-200';
      default:
        return 'bg-gray-100 text-gray-700 border-gray-200';
    }
  };

  const getTypeBgColor = (type: AnnouncementType) => {
    const displayType = mapTypeForDisplay(type);
    switch (displayType) {
      case 'info':
        return 'border-l-blue-500';
      case 'warning':
        return 'border-l-yellow-500';
      case 'error':
        return 'border-l-red-500';
      case 'maintenance':
        return 'border-l-purple-500';
      default:
        return 'border-l-gray-500';
    }
  };

  const getTypeLabel = (type: AnnouncementType): string => {
    switch (type) {
      case 'info': return 'Info';
      case 'warning': return 'Warning';
      case 'critical': return 'Critical';
      case 'maintenance': return 'Maintenance';
      default: return type;
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = diff / (1000 * 60 * 60);

    if (hours < 1) return `${Math.round(diff / (1000 * 60))} minutes ago`;
    if (hours < 24) return `${Math.round(hours)} hours ago`;
    if (hours < 48) return 'Yesterday';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date);
  };

  const handleViewAnnouncement = async (announcement: AnnouncementListItem) => {
    // Mark as viewed via GraphQL
    if (!announcement.hasViewed) {
      // Optimistic update
      setAnnouncements(prev =>
        prev.map((a) => (a.id === announcement.id ? { ...a, hasViewed: true } : a))
      );

      try {
        await graphqlRequest<{ viewAnnouncement: { id: string } }>(
          VIEW_ANNOUNCEMENT_MUTATION,
          { id: announcement.id },
        );
      } catch (err) {
        logError('TenantAnnouncementsPage.viewAnnouncement', err);
      }
    }
    setSelectedAnnouncement({ ...announcement, hasViewed: true });
  };

  const handleAcknowledge = async (announcementId: string) => {
    // Optimistic update
    setAnnouncements(prev =>
      prev.map((a) =>
        a.id === announcementId
          ? { ...a, hasAcknowledged: true }
          : a
      )
    );

    if (selectedAnnouncement?.id === announcementId) {
      setSelectedAnnouncement({
        ...selectedAnnouncement,
        hasAcknowledged: true,
      });
    }

    try {
      await graphqlRequest<{ acknowledgeAnnouncement: { id: string; acknowledgedAt: string } }>(
        ACKNOWLEDGE_ANNOUNCEMENT_MUTATION,
        { id: announcementId },
      );
    } catch (err) {
      logError('TenantAnnouncementsPage.acknowledgeAnnouncement', err);
    }
  };

  const handleMarkAllRead = async () => {
    // Optimistic update
    setAnnouncements(prev => prev.map((a) => ({ ...a, hasViewed: true })));

    // Mark all unviewed announcements as viewed via GraphQL
    const unviewedAnnouncements = announcements.filter(a => !a.hasViewed);
    try {
      await Promise.all(
        unviewedAnnouncements.map(a =>
          graphqlRequest<{ viewAnnouncement: { id: string } }>(
            VIEW_ANNOUNCEMENT_MUTATION,
            { id: a.id },
          )
        )
      );
    } catch (err) {
      logError('TenantAnnouncementsPage.markAllRead', err);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Announcements</h1>
            <p className="text-gray-500 mt-1">Platform updates and important notices</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={fetchAnnouncements}
              disabled={loading}
              className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-tenant-600 hover:bg-tenant-50 rounded-lg transition-colors"
              >
                <CheckCircle className="w-4 h-4" />
                Mark all as read
              </button>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mt-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-500">Total</span>
            </div>
            <div className="text-xl font-semibold text-gray-900 mt-1">{announcements.length}</div>
          </div>
          <div className="bg-blue-50 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-blue-500" />
              <span className="text-sm text-blue-600">Unread</span>
            </div>
            <div className="text-xl font-semibold text-blue-700 mt-1">{unreadCount}</div>
          </div>
          <div className="bg-orange-50 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-orange-500" />
              <span className="text-sm text-orange-600">Pending Acknowledgment</span>
            </div>
            <div className="text-xl font-semibold text-orange-700 mt-1">{pendingAckCount}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-500" />
              <span className="text-sm text-green-600">Acknowledged</span>
            </div>
            <div className="text-xl font-semibold text-green-700 mt-1">
              {announcements.filter((a) => a.hasAcknowledged).length}
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
            <input
              type="text"
              placeholder="Search announcements..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-tenant-500 focus:border-tenant-500"
            />
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as DisplayAnnouncementType | 'all')}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-tenant-500"
          >
            <option value="all">All Types</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Critical</option>
            <option value="maintenance">Maintenance</option>
          </select>
          <select
            value={readFilter}
            onChange={(e) => setReadFilter(e.target.value as 'all' | 'unread' | 'requires_ack')}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-tenant-500"
          >
            <option value="all">All Announcements</option>
            <option value="unread">Unread Only</option>
            <option value="requires_ack">Needs Acknowledgment</option>
          </select>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Announcement List */}
        <div
          className={`${selectedAnnouncement ? 'w-1/2' : 'w-full'} flex flex-col border-r border-gray-200 bg-white overflow-y-auto`}
        >
          {/* Error Message */}
          {error && (
            <div className="p-4 bg-red-50 border-b border-red-100">
              <div className="flex items-center gap-2 text-red-700">
                <AlertCircle size={18} />
                <span className="text-sm">{error}</span>
                <button
                  onClick={fetchAnnouncements}
                  className="ml-auto text-sm underline hover:no-underline"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-tenant-600" />
            </div>
          ) : filteredAnnouncements.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              <div className="text-center">
                <Megaphone size={48} className="mx-auto mb-3 text-gray-500" />
                <p className="font-medium">No announcements found</p>
                <p className="text-sm mt-1">Try adjusting your filters</p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filteredAnnouncements.map((announcement) => (
                <div
                  key={announcement.id}
                  onClick={() => handleViewAnnouncement(announcement)}
                  className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors border-l-4 ${getTypeBgColor(announcement.type)} ${
                    selectedAnnouncement?.id === announcement.id ? 'bg-tenant-50' : ''
                  } ${!announcement.hasViewed ? 'bg-blue-50/50' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">{getTypeIcon(announcement.type)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3
                          className={`font-medium ${!announcement.hasViewed ? 'text-gray-900' : 'text-gray-700'}`}
                        >
                          {announcement.title}
                        </h3>
                        {!announcement.hasViewed && (
                          <span className="px-1.5 py-0.5 text-xs font-medium bg-blue-500 text-white rounded">
                            NEW
                          </span>
                        )}
                        {announcement.requiresAcknowledgment && !announcement.hasAcknowledged && (
                          <span className="px-1.5 py-0.5 text-xs font-medium bg-orange-500 text-white rounded">
                            ACK REQUIRED
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500 mt-1 line-clamp-2">{announcement.content}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <Clock size={12} />
                          {formatDate(announcement.publishAt || announcement.createdAt)}
                        </span>
                        <span>by {announcement.createdByName}</span>
                        <span className={`px-2 py-0.5 rounded ${getTypeColor(announcement.type)}`}>
                          {getTypeLabel(announcement.type)}
                        </span>
                      </div>
                    </div>
                    {announcement.hasAcknowledged && (
                      <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Announcement Detail */}
        {selectedAnnouncement && (
          <div className="w-1/2 flex flex-col bg-gray-50">
            {/* Detail Header */}
            <div className="bg-white border-b border-gray-200 px-6 py-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="mt-1">{getTypeIcon(selectedAnnouncement.type)}</div>
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">
                      {selectedAnnouncement.title}
                    </h2>
                    <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
                      <span className="flex items-center gap-1">
                        <Calendar size={14} />
                        {formatDate(selectedAnnouncement.publishAt || selectedAnnouncement.createdAt)}
                      </span>
                      <span>by {selectedAnnouncement.createdByName}</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedAnnouncement(null)}
                  className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Type Badge */}
              <div className="mt-3">
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border ${getTypeColor(selectedAnnouncement.type)}`}
                >
                  {getTypeIcon(selectedAnnouncement.type)}
                  {getTypeLabel(selectedAnnouncement.type)}
                </span>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                {/* SEC-008: Announcement content is plain text only. React JSX text
                    nodes prevent HTML/script injection. Do NOT switch to
                    dangerouslySetInnerHTML without running the value through
                    DOMPurify first — doing so would introduce a direct XSS path. */}
                <p className="text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {selectedAnnouncement.content}
                </p>
              </div>

              {/* Expiry Info */}
              {selectedAnnouncement.expiresAt && (
                <div className="mt-4 p-3 bg-yellow-50 rounded-lg border border-yellow-100">
                  <div className="flex items-center gap-2 text-sm text-yellow-700">
                    <Clock size={14} />
                    <span>
                      Expires: {new Intl.DateTimeFormat(undefined, {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                      }).format(new Date(selectedAnnouncement.expiresAt))}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Acknowledgment Section */}
            {selectedAnnouncement.requiresAcknowledgment && (
              <div className="bg-white border-t border-gray-200 px-6 py-4">
                {selectedAnnouncement.hasAcknowledged ? (
                  <div className="flex items-center justify-center gap-2 p-3 bg-green-50 rounded-lg text-green-700">
                    <CheckCircle size={18} />
                    <span className="text-sm font-medium">
                      You have acknowledged this announcement
                    </span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-orange-700">
                      <AlertCircle size={16} />
                      <span>This announcement requires your acknowledgment</span>
                    </div>
                    <button
                      onClick={() => handleAcknowledge(selectedAnnouncement.id)}
                      className="w-full px-4 py-2.5 bg-tenant-600 text-white rounded-lg hover:bg-tenant-700 font-medium transition-colors flex items-center justify-center gap-2"
                    >
                      <CheckCircle size={18} />
                      I have read and understand this announcement
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TenantAnnouncementsPage;
