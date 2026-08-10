export { useAuth, AuthProvider } from './useAuth';
export { useTheme } from './useTheme';
export { useDensity } from './useDensity';
export type { ThemePreference, ResolvedTheme, UseThemeReturn } from './useTheme';
export type { Density, UseDensityReturn } from './useDensity';
export { useOfflineQueue, OfflineProvider } from './useOfflineQueue';
export { useNetworkStatus } from './useNetworkStatus';
export {
  useMediaQuery,
  useIsBoardViewport,
  BOARD_MEDIA_QUERY,
  BOARD_WIDE_MEDIA_QUERY,
} from './useViewport';
export { useTanks } from './useTanks';
export { useReportDeadlines, type ReportDeadline } from './useReportDeadlines';
export { useWebAuthn, isWebAuthnSupported, hasLocalCredentials } from './useWebAuthn';
export {
  useAiDashboardInsights,
  useTankRiskAssessment,
  useBatchGrowthPrediction,
  useFeedingAdvice,
} from './useAiInsights';

// Messaging hooks (ADR-012)
export { useChannels } from './useChannels';
export { useMessages } from './useMessages';
export { useMessageSocket } from './useMessageSocket';
export { useSendMessage } from './useSendMessage';
export { useTypingIndicator } from './useTypingIndicator';
export { useChannelMembers } from './useChannelMembers';
export { useChannelDetail } from './useChannelDetail';
export { useChannelActions } from './useChannelActions';
export { useCreateChannel } from './useCreateChannel';
export { useTenantUsers } from './useTenantUsers';
export { useUnreadCount } from './useUnreadCount';
export { useMediaUpload } from './useMediaUpload';
export { useVoiceRecorder } from './useVoiceRecorder';
export type { VoiceRecorderState } from './useVoiceRecorder';
export { useAiChat } from './useAiChat';
export { useAiConsent } from './useAiConsent';
