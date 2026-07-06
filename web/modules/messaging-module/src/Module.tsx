/**
 * Messaging Module Root — panel messaging remote.
 *
 * Layout is the shell's MainLayout; this only defines the page routes mounted
 * under /messaging/*. A module-level auth guard is defense-in-depth: in Module
 * Federation the remote bundle can be instantiated independently of the shell's
 * route guard, so the session is re-checked here.
 */
import { useAuthContext } from '@aquaculture/shared-ui';
import React, { Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

const ChannelListPage = React.lazy(() => import('./pages/ChannelListPage'));
const ChatRoomPage = React.lazy(() => import('./pages/ChatRoomPage'));

const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuthContext();
  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-gray-500">
        Checking session…
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

const MessagingModule: React.FC = () => (
  <RequireAuth>
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center text-sm text-gray-500">
          Loading…
        </div>
      }
    >
      <Routes>
        <Route path="/" element={<ChannelListPage />} />
        <Route path="/:channelId" element={<ChatRoomPage />} />
        <Route path="*" element={<Navigate to="/messaging" replace />} />
      </Routes>
    </Suspense>
  </RequireAuth>
);

export default MessagingModule;
