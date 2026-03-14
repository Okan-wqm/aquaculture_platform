# Grup R - Dead Code Temizligi & Erisilebirlik (A11y) Raporu

**Tarih:** 2026-03-14
**Bulgu No:** #42 (LOW - Dead Code), #44 (M19-M21 - A11y)
**Modul:** admin-panel (web/modules/admin-panel)

---

## 1. Dead Code Temizligi (Bulgu #42)

### Dogrulama Yontemi

Her dosya/dizin silinmeden once `grep -r` ile tum `src/pages/` ve `src/` altinda import kontrolu yapildi. Sadece kendi test dosyasindan veya barrel export'tan referans edilen, hicbir sayfadan import edilmeyen dosyalar silindi.

### Silinen Dosyalar

#### 1.1 AlertRuleBuilder Dizini (2455 satir)
| Dosya | Satir | Durum |
|-------|-------|-------|
| `components/AlertRuleBuilder/AlertRuleBuilder.tsx` | 1048 | SILINDI - Hicbir sayfadan import edilmiyor |
| `components/AlertRuleBuilder/index.ts` | 6 | SILINDI |
| `components/AlertRuleBuilder/__tests__/AlertRuleBuilder.spec.tsx` | 1401 | SILINDI - Yalnizca silinen bilesenin testi |

**Dogrulama:** `grep -r "AlertRuleBuilder" src/` -- yalnizca kendi dizinindeki dosyalardan referans.

#### 1.2 Database Bilesen Dizini (3507 satir, QueryEditor HARIC)
| Dosya | Satir | Durum |
|-------|-------|-------|
| `components/database/DataGrid.tsx` | 907 | SILINDI |
| `components/database/RowEditor.tsx` | 760 | SILINDI |
| `components/database/SchemaSelector.tsx` | 531 | SILINDI |
| `components/database/SchemaStatistics.tsx` | 663 | SILINDI |
| `components/database/TableList.tsx` | 646 | SILINDI |

**NOT:** `QueryEditor.tsx` (801 satir) korundu (rapor talimati geregi).
`database/index.ts` guncellendi: yalnizca QueryEditor export'u birakildi.

**Dogrulama:** `grep -r "DataGrid\|RowEditor\|SchemaSelector\|SchemaStatistics\|TableList" src/pages/` -- esleme yok. DatabaseExplorerPage kendi inline RowEditorModal'ini kullaniyor, bilesen dizinindeki RowEditor'u degil.

#### 1.3 UserPermissions Dizini (555 satir)
| Dosya | Satir | Durum |
|-------|-------|-------|
| `components/UserPermissions/InviteUserModal.tsx` | 335 | SILINDI |
| `components/UserPermissions/PermissionCheckboxes.tsx` | 220 | SILINDI |

**Dogrulama:** `grep -r "UserPermissions\|InviteUserModal\|PermissionCheckboxes" src/pages/` -- esleme yok.

#### 1.4 useUserPermissions Hook (199 satir)
| Dosya | Satir | Durum |
|-------|-------|-------|
| `hooks/useUserPermissions.ts` | 199 | SILINDI |

`hooks/index.ts` guncellendi: usePermissionCategories, useTenantUsers, useInviteUser, useUpdateUserPermissions, useUserPermissions export'lari kaldirildi. Aktif kullanilan hook'lar korundu: useAsyncData, usePagination, useFilters.

**Dogrulama:** `grep -r "useUserPermissions\|usePermissionCategories\|useTenantUsers" src/pages/` -- esleme yok.

#### 1.5 Legacy Placeholder Dosyalar (1 satir)
| Dosya | Satir | Durum |
|-------|-------|-------|
| `src/bootstrap.tsx` | 0 | SILINDI - Bos dosya |
| `src/App.tsx` | 0 | SILINDI - Bos dosya |
| `src/routes.tsx` | 1 | SILINDI - Yalnizca yorum: "Routes are defined in Module.tsx directly" |
| `webpack.config.js` | 0 | SILINDI - Bos dosya (Vite kullaniyor) |

### Toplam Silinen Satir: ~6717 satir

---

## 2. Erisilebirlik (A11y) Duzeltmeleri (Bulgu #44)

### 2.1 AdminSidebar.tsx

| Degisiklik | Detay |
|------------|-------|
| `<aside>` -> `<nav aria-label="Admin navigation">` | Semantik navigasyon landmark'i |
| Ic `<nav>` -> `<div role="list">` | Ic ice nav kacinildi |
| Expandable butonlara `aria-expanded` | `hasChildren ? isExpanded : undefined` |
| Aktif link'e `aria-current="page"` | `isActive ? 'page' : undefined` |
| Collapse butonuna `aria-label` | `collapsed ? 'Expand sidebar' : 'Collapse sidebar'` |

### 2.2 AdminLayout.tsx

| Degisiklik | Detay |
|------------|-------|
| Skip-to-content link | `<a href="#main-content">Skip to main content</a>` (sr-only, focus'ta gorunur) |
| `<main>` -> `<main id="main-content">` | Skip link hedefi |
| Mobile menu butonuna `aria-label="Toggle mobile menu"` | Ekran okuyucu icin |
| Desktop collapse butonuna `aria-label="Toggle sidebar"` | Ekran okuyucu icin |
| Notifications butonuna `aria-label="Notifications"` | Ekran okuyucu icin |
| Settings butonuna `aria-label="Settings"` | Ekran okuyucu icin |
| User menu butonuna `aria-label="User menu"` | Ekran okuyucu icin |
| Mobile overlay'e `role="dialog" aria-modal="true" aria-label="Mobile navigation"` | Modal dialog semantigi |
| Mobile overlay backdrop'a `aria-hidden="true"` | Backdrop erisilebilirlik gizleme |
| Close butonuna `aria-label="Close navigation menu"` | Ekran okuyucu icin |
| Focus trap eklendi | Tab/Shift+Tab focusable elemanlar arasinda dongu |
| Escape ile kapatma | `keydown` listener ile Escape tespiti |
| Otomatik focus | Overlay acildiginda close butona focus |

---

## Degisiklik Ozeti

| Kategori | Etkilenen Dosya | Islem |
|----------|----------------|-------|
| Dead Code | 12 dosya | Silindi |
| Dead Code | `hooks/index.ts` | Guncellendi (useUserPermissions export'lari kaldirildi) |
| Dead Code | `components/database/index.ts` | Guncellendi (yalnizca QueryEditor export'u) |
| A11y | `components/AdminSidebar.tsx` | Guncellendi (ARIA attribute'lari) |
| A11y | `components/AdminLayout.tsx` | Guncellendi (skip-link, aria-label'lar, focus trap) |

**Toplam silinen satir:** ~6717
**Gorunumu etkileyen degisiklik:** Yok (yalnizca ARIA attribute'lari ve gorunmez skip-link)
