/**
 * Announcements Page — platform-wide broadcasts, on the admin data layer
 * (ADMIN-HIGH-121 / ADMIN-HIGH-145).
 *
 * This page publishes messages to every tenant, and it was the quietest page
 * in the panel about whether it had done so.
 *
 * 1. **Four writes failed in total silence.** Publish, cancel, delete and
 *    create each caught their error, wrote `console.error` (banned by
 *    CLAUDE.md), and told the operator NOTHING — then refetched, so the list
 *    re-rendered with the announcement exactly as it was. A refused publish of
 *    a `critical` global maintenance notice was indistinguishable from a
 *    successful one: same click, same repaint, no message. The operator's
 *    belief that every tenant had been notified was the only thing that
 *    changed.
 *
 * 2. **A failed acknowledgment roster rendered as "No activity yet".** The
 *    modal read `data.acknowledgments || []` behind a `console.error`, so an
 *    unreachable endpoint and a genuinely unseen announcement drew the same
 *    sentence — on the one screen that exists to answer "who has read the
 *    notice we required them to read".
 *
 * 3. **A failed stats read removed the header strip**, unannounced, so the
 *    page looked like a build without stats rather than a page with a broken
 *    read.
 *
 * 4. **The "Edit" pencil on a draft opened the statistics modal.** The form
 *    modal already accepts an existing announcement and titles itself "Edit
 *    Announcement"; nothing ever passed it one, and `updateAnnouncement` — an
 *    audited route — had no caller in the panel. The control is now wired to
 *    the endpoint it names, and the form seeds the schedule it is editing so
 *    saving cannot silently clear a publish time.
 *
 * 5. **Delete asked nothing.** A single click on a trash icon destroyed a
 *    platform announcement, on a route the backend marks `@Destructive()`,
 *    while the plan page confirms a mere *deprecate*.
 *
 * 6. **"Schedule" with no date threw.** `new Date('').toISOString()` raises a
 *    RangeError, so the submit button crashed the render tree instead of
 *    refusing.
 *
 * 7. **The list is one capped page and said otherwise.** It asks for 100 rows
 *    and showed them under a header whose "Total" counts the whole table, with
 *    no hint that the two numbers measure different things — and the search box
 *    filters only what was loaded.
 *
 * The contract half of this — three reads with no response schema at all, a
 * create payload derived from the read shape by subtracting a misspelled key,
 * and a filter declaring a query parameter the server has never had — is in
 * `announcement-response.dto.ts` and `services/types/support.ts`.
 */

import React, { useMemo, useState } from 'react';
import {
  Megaphone,
  Plus,
  Search,
  Calendar,
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
  BarChart3,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import {
  supportApi,
  type Announcement,
  type AnnouncementListQuery,
  type AnnouncementStats,
  type AnnouncementStatus,
  type AnnouncementType,
  type CreateAnnouncementInput,
  type PaginatedResult,
} from '../services/adminApi';
import { adminKeys, useAdminMutation, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';

/**
 * How many rows one list request asks for. The endpoint pages, and the search
 * box below filters what arrived rather than querying the server, so this
 * number is stated on screen instead of being mistaken for the total.
 */
const LIST_PAGE_SIZE = 100;

/** Nothing loaded yet — distinct from "the table is empty", which has a total. */
const NO_PAGE_YET: PaginatedResult<Announcement> | undefined = undefined;

/**
 * An ISO instant as a `datetime-local` input wants it.
 *
 * `toISOString().slice(0, 16)` would hand the input a UTC wall-clock reading
 * that the browser then interprets as local time, so editing a scheduled
 * announcement in UTC+03:00 and saving it unchanged would move it three hours
 * earlier.
 */
function toLocalInputValue(iso: string | undefined): string {
  if (!iso) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

/** A `datetime-local` value back as an ISO instant, or undefined if unset. */
function toIsoInstant(localValue: string): string | undefined {
  if (localValue === '') return undefined;
  const instant = new Date(localValue);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

// ============================================================================
// Component
// ============================================================================

export const AnnouncementsPage: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<AnnouncementStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<AnnouncementType | 'all'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [viewingStats, setViewingStats] = useState<Announcement | null>(null);

  // The route's own query type, so a filter name the server does not accept is
  // a compile error rather than a parameter it silently ignores.
  const listQueryParams = useMemo<AnnouncementListQuery>(
    () => ({
      limit: String(LIST_PAGE_SIZE),
      ...(statusFilter === 'all' ? {} : { status: statusFilter }),
      ...(typeFilter === 'all' ? {} : { type: typeFilter }),
    }),
    [statusFilter, typeFilter],
  );

  const listQuery = useAdminQuery<PaginatedResult<Announcement>>(
    adminKeys.announcements.list(listQueryParams),
    ({ signal }) => supportApi.getAnnouncements(listQueryParams, signal),
  );
  const statsQuery = useAdminQuery<AnnouncementStats>(
    adminKeys.announcements.stats(),
    ({ signal }) => supportApi.getAnnouncementStats(signal),
  );

  const page = listQuery.data ?? NO_PAGE_YET;
  const announcements: readonly Announcement[] = page?.data ?? [];
  const stats = statsQuery.data;

  // Every write invalidates the whole announcements subtree: the list rows and
  // the header aggregate both move when one is published, cancelled or deleted.
  const invalidateKeys = [adminKeys.announcements.all()];

  const publishMutation = useAdminMutation(
    (id: string) => supportApi.publishAnnouncement(id),
    { invalidateKeys },
  );
  const cancelMutation = useAdminMutation(
    (id: string) => supportApi.unpublishAnnouncement(id),
    { invalidateKeys },
  );
  const deleteMutation = useAdminMutation(
    (id: string) => supportApi.deleteAnnouncement(id),
    { invalidateKeys },
  );
  const createMutation = useAdminMutation(
    (input: CreateAnnouncementInput) => supportApi.createAnnouncement(input),
    { invalidateKeys, mutationOptions: { onSuccess: () => setShowCreateModal(false) } },
  );
  const updateMutation = useAdminMutation(
    ({ id, input }: { id: string; input: CreateAnnouncementInput }) =>
      supportApi.updateAnnouncement(id, input),
    { invalidateKeys, mutationOptions: { onSuccess: () => setEditing(null) } },
  );

  const reload = (): void => {
    void listQuery.refetch();
    void statsQuery.refetch();
  };

  const filteredAnnouncements = announcements.filter((ann) => {
    if (searchQuery === '') return true;
    const needle = searchQuery.toLowerCase();
    return (
      ann.title.toLowerCase().includes(needle) || ann.content.toLowerCase().includes(needle)
    );
  });

  const getTypeIcon = (type: AnnouncementType): React.ReactElement => {
    switch (type) {
      case 'info': return <Info size={16} className="text-blue-500" />;
      case 'warning': return <AlertTriangle size={16} className="text-yellow-500" />;
      case 'critical': return <AlertCircle size={16} className="text-red-500" />;
      case 'maintenance': return <Wrench size={16} className="text-purple-500" />;
    }
  };

  const getTypeColor = (type: AnnouncementType): string => {
    switch (type) {
      case 'info': return 'bg-blue-100 text-blue-700';
      case 'warning': return 'bg-yellow-100 text-yellow-700';
      case 'critical': return 'bg-red-100 text-red-700';
      case 'maintenance': return 'bg-purple-100 text-purple-700';
    }
  };

  const getStatusColor = (status: AnnouncementStatus): string => {
    switch (status) {
      case 'draft': return 'bg-gray-100 text-gray-700';
      case 'scheduled': return 'bg-blue-100 text-blue-700';
      case 'published': return 'bg-green-100 text-green-700';
      case 'expired': return 'bg-gray-100 text-gray-500';
      case 'cancelled': return 'bg-red-100 text-red-700';
    }
  };

  const formatDate = (dateString: string): string =>
    new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const handleDelete = (announcement: Announcement): void => {
    // The route is `@Destructive()` on the server; a trash icon that needed no
    // confirmation was the only thing standing between a misclick and a
    // permanently removed platform announcement.
    if (
      !confirm(
        `Delete "${announcement.title}" permanently? This cannot be undone.`,
      )
    ) {
      return;
    }
    deleteMutation.mutate(announcement.id);
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
              onClick={reload}
              aria-label="Refresh announcements"
              className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
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

        {/* Stats — absent while the aggregate has not loaded. Its failure is
            named by the notice below, so the strip's absence is never the only
            signal. */}
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
              <div className="text-xl font-semibold text-purple-700">
                {stats.totalViews.toLocaleString()}
              </div>
            </div>
            <div className="bg-indigo-50 rounded-lg p-3">
              <div className="text-sm text-indigo-600">Acknowledged</div>
              <div className="text-xl font-semibold text-indigo-700">
                {stats.totalAcknowledgments.toLocaleString()}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
            <input
              type="text"
              placeholder="Search announcements..."
              aria-label="Search announcements"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <select
            value={statusFilter}
            aria-label="Filter by status"
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
            aria-label="Filter by type"
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

      {/* Every failed read and every refused write is named here, in one place:
          a banner over the rows that did load, or the full-page state when
          nothing did. */}
      <QueryFailureNotice
        errors={[
          listQuery.error,
          statsQuery.error,
          publishMutation.error,
          cancelMutation.error,
          deleteMutation.error,
          createMutation.error,
          updateMutation.error,
        ]}
        hasContent={announcements.length > 0}
        onRetry={reload}
      />

      {listQuery.isPending && (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="animate-spin text-blue-600" size={32} />
        </div>
      )}

      {/* Announcement List */}
      {!listQuery.isPending && !listQuery.isError && page && (
        <div className="flex-1 overflow-y-auto p-6">
          {/* One capped page, said out loud. The header's "Total" counts the
              whole table; this counts what the browser is holding, and the
              search box only filters that. */}
          <p className="text-sm text-gray-500 mb-4">
            Showing {filteredAnnouncements.length} of {page.total}
            {page.total > announcements.length
              ? ` — loaded the first ${announcements.length}; search and filters apply to those`
              : ''}
          </p>
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
                            onClick={() => publishMutation.mutate(announcement.id)}
                            disabled={publishMutation.isPending}
                            className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
                          >
                            <Send size={14} />
                            Publish
                          </button>
                          <button
                            onClick={() => setEditing(announcement)}
                            aria-label={`Edit ${announcement.title}`}
                            className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                          >
                            <Edit3 size={16} />
                          </button>
                          <button
                            onClick={() => handleDelete(announcement)}
                            aria-label={`Delete ${announcement.title}`}
                            disabled={deleteMutation.isPending}
                            className="p-2 text-gray-500 hover:text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50"
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                      {announcement.status === 'scheduled' && (
                        <>
                          <button
                            onClick={() => publishMutation.mutate(announcement.id)}
                            disabled={publishMutation.isPending}
                            className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
                          >
                            <Send size={14} />
                            Publish Now
                          </button>
                          <button
                            onClick={() => cancelMutation.mutate(announcement.id)}
                            disabled={cancelMutation.isPending}
                            className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {announcement.status === 'published' && (
                        <button
                          onClick={() => setViewingStats(announcement)}
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
                <Megaphone size={48} className="mx-auto mb-3 text-gray-500" />
                <p>No announcements found</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <AnnouncementFormModal
          saving={createMutation.isPending}
          onClose={() => setShowCreateModal(false)}
          onSave={(input) => createMutation.mutate(input)}
        />
      )}

      {/* Edit Modal — the pencil's real destination. */}
      {editing && (
        <AnnouncementFormModal
          announcement={editing}
          saving={updateMutation.isPending}
          onClose={() => setEditing(null)}
          onSave={(input) => updateMutation.mutate({ id: editing.id, input })}
        />
      )}

      {/* Stats Modal */}
      {viewingStats && (
        <AnnouncementStatsModal
          announcement={viewingStats}
          onClose={() => setViewingStats(null)}
        />
      )}
    </div>
  );
};

// ============================================================================
// Sub-components
// ============================================================================

interface AnnouncementFormModalProps {
  readonly announcement?: Announcement;
  readonly saving: boolean;
  readonly onClose: () => void;
  readonly onSave: (input: CreateAnnouncementInput) => void;
}

/**
 * The create/edit form.
 *
 * `onSave` takes the ENDPOINT's payload type, not `Partial<Announcement>`: the
 * page used to cast the form's output on its way to the client because the
 * client's create type had been derived from the read shape and still demanded
 * `status`, `acknowledgmentCount` and an acknowledgment roster. With the real
 * contract on both sides, the cast has nothing left to hide.
 */
const AnnouncementFormModal: React.FC<AnnouncementFormModalProps> = ({
  announcement,
  saving,
  onClose,
  onSave,
}) => {
  const [title, setTitle] = useState(announcement?.title ?? '');
  const [content, setContent] = useState(announcement?.content ?? '');
  const [type, setType] = useState<AnnouncementType>(announcement?.type ?? 'info');
  const [isGlobal, setIsGlobal] = useState(announcement?.isGlobal ?? true);
  // Seeded from the announcement being edited: defaulting to 'now' would have
  // sent `publishAt: undefined` on save and silently unscheduled it.
  const [scheduleType, setScheduleType] = useState<'now' | 'scheduled'>(
    announcement?.publishAt ? 'scheduled' : 'now',
  );
  const [publishAt, setPublishAt] = useState(toLocalInputValue(announcement?.publishAt));
  const [expiresAt, setExpiresAt] = useState(toLocalInputValue(announcement?.expiresAt));
  const [requiresAcknowledgment, setRequiresAcknowledgment] = useState(
    announcement?.requiresAcknowledgment ?? false,
  );

  // A schedule needs a date. `new Date('').toISOString()` throws a RangeError,
  // so "Schedule" with an empty picker used to crash the render tree rather
  // than refuse.
  const canSubmit =
    title.trim() !== '' &&
    content.trim() !== '' &&
    (scheduleType === 'now' || publishAt !== '') &&
    !saving;

  const handleSubmit = (): void => {
    if (!canSubmit) return;
    onSave({
      title,
      content,
      type,
      isGlobal,
      publishAt: scheduleType === 'scheduled' ? toIsoInstant(publishAt) : undefined,
      expiresAt: toIsoInstant(expiresAt),
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
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Title */}
          <div>
            <label htmlFor="announcement-title" className="block text-sm font-medium text-gray-700 mb-2">
              Title
            </label>
            <input
              id="announcement-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Enter announcement title..."
            />
          </div>

          {/* Content */}
          <div>
            <label htmlFor="announcement-content" className="block text-sm font-medium text-gray-700 mb-2">
              Content
            </label>
            <textarea
              id="announcement-content"
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
              {(['info', 'warning', 'critical', 'maintenance'] as const).map((t) => (
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
                aria-label="Publish at"
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
                className="w-full mt-3 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            )}
          </div>

          {/* Expiry */}
          <div>
            <label htmlFor="announcement-expiry" className="block text-sm font-medium text-gray-700 mb-2">
              Expiry Date (Optional)
            </label>
            <input
              id="announcement-expiry"
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
            disabled={!canSubmit}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {announcement ? 'Save Changes' : scheduleType === 'scheduled' ? 'Schedule' : 'Save Draft'}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AnnouncementStatsModalProps {
  readonly announcement: Announcement;
  readonly onClose: () => void;
}

/**
 * Who has seen the notice, and who has acknowledged it.
 *
 * The counters come from the ROSTER read rather than the list row: this modal
 * is the authoritative answer, and the row behind it can be minutes old. Until
 * that read returns they are an em dash, because an unknown count is not zero
 * — and a failed read is a named failure, not "No activity yet".
 */
const AnnouncementStatsModal: React.FC<AnnouncementStatsModalProps> = ({
  announcement,
  onClose,
}) => {
  const rosterQuery = useAdminQuery(
    adminKeys.announcements.acknowledgments(announcement.id),
    ({ signal }) => supportApi.getAnnouncementAcknowledgments(announcement.id, signal),
  );
  const roster = rosterQuery.data;
  const acknowledgments = roster?.acknowledgments ?? [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Announcement Statistics</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Announcement Info */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="font-semibold text-gray-900">{announcement.title}</h3>
            <p className="text-sm text-gray-600 mt-1">{announcement.content}</p>
          </div>

          <QueryFailureNotice
            errors={[rosterQuery.error]}
            hasContent={acknowledgments.length > 0}
            onRetry={() => void rosterQuery.refetch()}
          />

          {/* Stats */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-blue-50 rounded-lg p-4 text-center">
              <Eye size={24} className="mx-auto text-blue-600 mb-2" />
              <div className="text-2xl font-bold text-blue-700">
                {roster ? roster.totalViews.toLocaleString() : '—'}
              </div>
              <div className="text-sm text-blue-600">Total Views</div>
            </div>
            {announcement.requiresAcknowledgment && (
              <div className="bg-green-50 rounded-lg p-4 text-center">
                <CheckCircle size={24} className="mx-auto text-green-600 mb-2" />
                <div className="text-2xl font-bold text-green-700">
                  {roster ? roster.totalAcknowledgments.toLocaleString() : '—'}
                </div>
                <div className="text-sm text-green-600">Acknowledged</div>
              </div>
            )}
          </div>

          {/* Acknowledgments List */}
          {announcement.requiresAcknowledgment && (
            <div>
              <h4 className="font-medium text-gray-900 mb-3">Recent Activity</h4>
              {rosterQuery.isPending ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="animate-spin text-blue-600" size={24} />
                </div>
              ) : acknowledgments.length > 0 ? (
                <div className="space-y-2">
                  {acknowledgments.map((ack) => (
                    <div key={ack.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div>
                        {/* `userName` is nullable on the row; rendering it bare
                            drew an empty line where a person should be. */}
                        <div className="font-medium text-gray-900">
                          {ack.userName ?? ack.userId}
                        </div>
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
                // Reached only when the read SUCCEEDED and returned nothing.
                !rosterQuery.isError && (
                  <p className="text-gray-500 text-center py-4">No activity yet</p>
                )
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
