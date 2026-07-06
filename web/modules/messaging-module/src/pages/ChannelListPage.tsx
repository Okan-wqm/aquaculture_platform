import { MessageSquare, Sparkles, Users, RefreshCw, AlertCircle } from 'lucide-react';
import React from 'react';
import { useNavigate } from 'react-router-dom';

import { useChannels } from '../hooks/useMessagingData';
import { channelTitle } from '../lib/channelDisplay';
import type { Channel } from '../types/messaging';

function ChannelIcon({ channel }: { channel: Channel }): React.ReactElement {
  if (channel.type === 'AI') return <Sparkles className="h-5 w-5 text-tenant-600" />;
  if (channel.type === 'GROUP') return <Users className="h-5 w-5 text-gray-500" />;
  return <MessageSquare className="h-5 w-5 text-gray-500" />;
}

const ChannelListPage: React.FC = () => {
  const navigate = useNavigate();
  const { data: channels, isLoading, isError } = useChannels();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">Messages</h1>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <RefreshCw className="h-4 w-4 animate-spin" /> Loading channels…
        </div>
      )}
      {isError && (
        <p className="flex items-center gap-1 text-sm text-red-600">
          <AlertCircle className="h-4 w-4" /> Could not load channels.
        </p>
      )}

      {!isLoading && !isError && (channels?.length ?? 0) === 0 && (
        <div className="rounded-lg bg-gray-50 p-8 text-center text-sm text-gray-500">
          No channels yet.
        </div>
      )}

      <div className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white">
        {channels?.map((channel) => (
          <button
            key={channel.id}
            onClick={() => navigate(`/messaging/${channel.id}`)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100">
              <ChannelIcon channel={channel} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-gray-900">
                  {channelTitle(channel)}
                </span>
                {!!channel.unreadCount && channel.unreadCount > 0 && (
                  <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-tenant-600 px-1.5 text-xs font-medium text-white">
                    {channel.unreadCount}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-xs text-gray-400">
                {channel.lastMessage?.content ?? 'No messages yet'}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default ChannelListPage;
