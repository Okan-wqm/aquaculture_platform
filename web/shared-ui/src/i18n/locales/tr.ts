/**
 * Turkish (tr) Locale Messages
 *
 * FE-HIGH-020: Turkish translations for the Aquaculture Platform.
 * This file mirrors the English locale structure. All keys must exist
 * in both locales to ensure complete translation coverage.
 *
 * @see FE-HIGH-020, FE-HIGH-021
 */

import type { MessageKey } from './en';

export const tr: Record<MessageKey, string> = {
  // ── Common / Shared ──
  'common.loading': 'Yükleniyor...',
  'common.save': 'Kaydet',
  'common.cancel': 'İptal',
  'common.confirm': 'Onayla',
  'common.delete': 'Sil',
  'common.edit': 'Düzenle',
  'common.close': 'Kapat',
  'common.back': 'Geri',
  'common.next': 'İleri',
  'common.submit': 'Gönder',
  'common.required': 'Zorunlu',
  'common.optional': 'İsteğe bağlı',
  'common.yes': 'Evet',
  'common.no': 'Hayır',
  'common.error': 'Bir hata oluştu',
  'common.retry': 'Tekrar dene',
  'common.search': 'Ara',
  'common.noResults': 'Sonuç bulunamadı',
  'common.invalidDate': 'Geçersiz tarih',
  'common.showPassword': 'Şifreyi göster',
  'common.hidePassword': 'Şifreyi gizle',
  'common.capsLockOn': 'Caps Lock açık',

  // ── Auth shell (layout chrome) ──
  'auth.needHelp': 'Yardım mı lazım?',
  'auth.support': 'Destek',
  'auth.allRightsReserved': 'Tüm hakları saklıdır.',

  // ── Login Page ──
  'login.title': 'Giriş Yap',
  'login.subtitle': 'Hesabınıza erişin',
  'login.email': 'E-posta',
  'login.emailPlaceholder': 'ornek@email.com',
  'login.password': 'Şifre',
  'login.passwordPlaceholder': '••••••••',
  'login.rememberMe': 'Beni hatırla',
  'login.forgotPassword': 'Şifremi unuttum',
  'login.signIn': 'Giriş Yap',
  'login.mfa.title': 'İki Faktörlü Doğrulama',
  'login.mfa.totpPrompt': 'Kimlik doğrulama uygulamanızdaki 6 haneli kodu girin',
  'login.mfa.recoveryPrompt': 'Kurtarma kodlarınızdan birini girin',
  'login.mfa.verifyCode': 'Kodu Doğrula',
  'login.mfa.verifyRecovery': 'Kurtarma Kodunu Doğrula',
  'login.mfa.useRecovery': 'Kurtarma kodu kullan',
  'login.mfa.useAuthenticator': 'Kimlik doğrulama uygulamasını kullan',
  'login.mfa.backToLogin': 'Girişe dön',
  'login.mfa.codeRequired': 'Doğrulama kodu gereklidir',
  'login.mfa.recoveryRequired': 'Kurtarma kodu gereklidir',
  'login.mfa.invalidCode': 'Kimlik doğrulama uygulamanızdan 6 haneli kod girin',
  'login.mfa.invalidRecovery': 'Kurtarma kodu 6 ile 12 karakter arasında olmalıdır',
  'login.mobile.title': 'AquaMobil',
  'login.mobile.subtitle': 'Mobil saha veri giriş uygulaması',

  // ── Consent Banner ──
  'consent.title': 'Gizlilik Tercihleri',
  'consent.titleOutdated': 'Gizlilik Tercihleriniz Güncellenmeli',
  'consent.description':
    'Lütfen onay tercihlerinizi inceleyin ve ayarlayın. Gizliliğinize saygı duyuyor ve verilerinizin nasıl kullanılacağı konusunda size kontrol veriyoruz.',
  'consent.descriptionOutdated':
    'Gizlilik politikamız güncellendi. Platformu kullanmaya devam etmek için lütfen onay tercihlerinizi inceleyin ve güncelleyin.',
  'consent.acceptAll': 'Tümünü Kabul Et',
  'consent.essentialOnly': 'Yalnızca Zorunlu',
  'consent.customize': 'Tercihleri özelleştir',
  'consent.hideDetails': 'Detayları gizle',
  'consent.savePreferences': 'Tercihleri Kaydet',
  'consent.saving': 'Kaydediliyor...',
  'consent.manageInSettings': 'Ayarlarda Yönet',
  'consent.essential': 'Zorunlu',
  'consent.essentialRequired': 'Gerekli',

  // ── Forgot Password ──
  'forgotPassword.title': 'Şifremi Unuttum',
  'forgotPassword.subtitle': 'E-posta adresinize şifre sıfırlama bağlantısı göndereceğiz',
  'forgotPassword.send': 'Sıfırlama Bağlantısı Gönder',
  'forgotPassword.backToLogin': 'Girişe dön',
  'forgotPassword.success.title': 'E-posta Gönderildi',
  'forgotPassword.success.message': 'Şifre sıfırlama bağlantısı e-posta adresinize gönderildi.',

  // ── Reset Password ──
  'resetPassword.title': 'Yeni Şifre Belirle',
  'resetPassword.subtitle': 'Yeni şifrenizi girin',
  'resetPassword.newPassword': 'Yeni Şifre',
  'resetPassword.confirmPassword': 'Şifre Onayı',
  'resetPassword.submit': 'Şifreyi Sıfırla',
  'resetPassword.success.title': 'Şifre Sıfırlandı',
  'resetPassword.success.message': 'Şifreniz başarıyla sıfırlandı. Giriş sayfasına yönlendiriliyorsunuz...',

  // ── Accept Invitation ──
  'invitation.title': 'Daveti Kabul Et',
  'invitation.subtitle': 'Hesabınızı tamamlayın',
  'invitation.firstName': 'Ad',
  'invitation.lastName': 'Soyad',
  'invitation.password': 'Şifre',
  'invitation.confirmPassword': 'Şifre Onayı',
  'invitation.submit': 'Hesap Oluştur',
  'invitation.validating': 'Davet doğrulanıyor...',
  'invitation.invalid.title': 'Geçersiz Davet',
  'invitation.invalid.expired': 'Davet süresi dolmuş',
  'invitation.invalid.generic': 'Davet bağlantısı geçersiz veya süresi dolmuş',
  'invitation.backToLogin': 'Girişe dön',

  // ── Notifications ──
  'notifications.title': 'Bildirimler',
  'notifications.new': '{count} yeni',
  'notifications.markAllRead': 'Tümünü okundu işaretle',
  'notifications.empty.title': 'Bildirim yok',
  'notifications.empty.subtitle': 'Tümünü okudunuz!',
  'notifications.timeAgo.justNow': 'az önce',
  'notifications.timeAgo.minutes': '{count} dk önce',
  'notifications.timeAgo.hours': '{count} sa önce',
  'notifications.timeAgo.days': '{count} gün önce',

  // ── Validation ──
  'validation.required': 'Bu alan zorunludur',
  'validation.email': 'Lütfen geçerli bir e-posta adresi girin',
  'validation.minLength': 'En az {min} karakter olmalıdır',
  'validation.passwordMismatch': 'Şifreler eşleşmiyor',
};
