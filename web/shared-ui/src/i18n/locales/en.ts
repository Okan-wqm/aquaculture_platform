/**
 * English (en) Locale Messages
 *
 * FE-HIGH-020: i18n infrastructure for the Aquaculture Platform.
 * This file contains all English translations for the most critical pages.
 * Full extraction of remaining pages is planned for Sprint 3+.
 *
 * Convention: Keys use dot-notation namespacing: {page}.{section}.{key}
 *
 * @see FE-HIGH-020, FE-HIGH-021
 */

export const en = {
  // ── Common / Shared ──
  'common.loading': 'Loading...',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.close': 'Close',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.submit': 'Submit',
  'common.required': 'Required',
  'common.optional': 'Optional',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.error': 'An error occurred',
  'common.retry': 'Retry',
  'common.search': 'Search',
  'common.noResults': 'No results found',
  'common.invalidDate': 'Invalid date',
  'common.showPassword': 'Show password',
  'common.hidePassword': 'Hide password',
  'common.capsLockOn': 'Caps Lock is on',

  // ── Auth shell (layout chrome) ──
  'auth.needHelp': 'Need help?',
  'auth.support': 'Support',
  'auth.allRightsReserved': 'All rights reserved.',

  // ── Login Page ──
  'login.title': 'Sign In',
  'login.subtitle': 'Access your account',
  'login.email': 'Email',
  'login.emailPlaceholder': 'example@email.com',
  'login.password': 'Password',
  'login.passwordPlaceholder': '••••••••',
  'login.rememberMe': 'Remember me',
  'login.forgotPassword': 'Forgot password?',
  'login.signIn': 'Sign In',
  'login.mfa.title': 'Two-Factor Authentication',
  'login.mfa.totpPrompt': 'Enter the 6-digit code from your authenticator app',
  'login.mfa.recoveryPrompt': 'Enter one of your recovery codes',
  'login.mfa.verifyCode': 'Verify Code',
  'login.mfa.verifyRecovery': 'Verify Recovery Code',
  'login.mfa.useRecovery': 'Use a recovery code',
  'login.mfa.useAuthenticator': 'Use authenticator app',
  'login.mfa.backToLogin': 'Back to login',
  'login.mfa.codeRequired': 'Verification code is required',
  'login.mfa.recoveryRequired': 'Recovery code is required',
  'login.mfa.invalidCode': 'Enter a 6-digit code from your authenticator app',
  'login.mfa.invalidRecovery': 'Recovery code must be between 6 and 12 characters',
  'login.mobile.title': 'AquaMobil',
  'login.mobile.subtitle': 'Mobile field data entry app',

  // ── Consent Banner ──
  'consent.title': 'Privacy Preferences',
  'consent.titleOutdated': 'Your Privacy Preferences Need Updating',
  'consent.description':
    'Please review and set your consent preferences. We respect your privacy and give you control over how your data is used.',
  'consent.descriptionOutdated':
    'Our privacy policy has been updated. Please review and update your consent preferences to continue using the platform.',
  'consent.acceptAll': 'Accept All',
  'consent.essentialOnly': 'Essential Only',
  'consent.customize': 'Customize preferences',
  'consent.hideDetails': 'Hide details',
  'consent.savePreferences': 'Save Preferences',
  'consent.saving': 'Saving...',
  'consent.manageInSettings': 'Manage in Settings',
  'consent.essential': 'Essential',
  'consent.essentialRequired': 'Required',

  // ── Forgot Password ──
  'forgotPassword.title': 'Forgot Password',
  'forgotPassword.subtitle': "We'll send a password reset link to your email",
  'forgotPassword.send': 'Send Reset Link',
  'forgotPassword.backToLogin': 'Back to login',
  'forgotPassword.success.title': 'Email Sent',
  'forgotPassword.success.message': 'Password reset link has been sent to your email address.',

  // ── Reset Password ──
  'resetPassword.title': 'Set New Password',
  'resetPassword.subtitle': 'Enter your new password',
  'resetPassword.newPassword': 'New Password',
  'resetPassword.confirmPassword': 'Confirm Password',
  'resetPassword.submit': 'Reset Password',
  'resetPassword.success.title': 'Password Reset',
  'resetPassword.success.message': 'Your password has been reset successfully. Redirecting to login...',

  // ── Accept Invitation ──
  'invitation.title': 'Accept Invitation',
  'invitation.subtitle': 'Complete your account',
  'invitation.firstName': 'First Name',
  'invitation.lastName': 'Last Name',
  'invitation.password': 'Password',
  'invitation.confirmPassword': 'Confirm Password',
  'invitation.submit': 'Create Account',
  'invitation.validating': 'Validating invitation...',
  'invitation.invalid.title': 'Invalid Invitation',
  'invitation.invalid.expired': 'Invitation has expired',
  'invitation.invalid.generic': 'Invitation link is invalid or expired',
  'invitation.backToLogin': 'Back to login',

  // ── Notifications ──
  'notifications.title': 'Notifications',
  'notifications.new': '{count} new',
  'notifications.markAllRead': 'Mark all as read',
  'notifications.empty.title': 'No notifications',
  'notifications.empty.subtitle': "You're all caught up!",
  'notifications.timeAgo.justNow': 'just now',
  'notifications.timeAgo.minutes': '{count}m ago',
  'notifications.timeAgo.hours': '{count}h ago',
  'notifications.timeAgo.days': '{count}d ago',

  // ── Validation ──
  'validation.required': 'This field is required',
  'validation.email': 'Please enter a valid email address',
  'validation.minLength': 'Must be at least {min} characters',
  'validation.passwordMismatch': 'Passwords do not match',
} as const;

export type MessageKey = keyof typeof en;
