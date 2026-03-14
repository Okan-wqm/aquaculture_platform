# Grup I - CSV Export Fix Raporu

**Tarih:** 2026-03-14
**Bulgu:** H22 -- CSV export: injection, memory leak, stale filter
**Dosya:** `web/modules/admin-panel/src/pages/AuditLogPage.tsx`

## Tespit Edilen Sorunlar

### 1. CSV Formula Injection (Guvenlik)
- **Sorun:** CSV hucre degerleri hicbir escaping yapilmadan dogrudan `row.join(',')` ile birlestiriliyor. Saldirgan, `=CMD("...")`, `+cmd|'...` gibi formul iceren degerler (ornegin email, entityId) kaydedebilir. Kullanici CSV dosyasini Excel/Sheets'te actigi anda bu formuller calistirilir.
- **Cozum:** `escapeCsvCell()` fonksiyonu eklendi. `=`, `+`, `-`, `@`, `\t`, `\r` ile baslayan hucrelere tek tirnak (`'`) prefix'i ekleniyor ve double-quote ile sariliyor. Virgul, tirnak veya newline iceren hucreler de RFC 4180 uyumlu olarak double-quote ile sariliyor.

### 2. Memory Leak (Performans)
- **Sorun:** `URL.createObjectURL(blob)` ile olusturulan Object URL, `revokeObjectURL` ile serbest birakilmiyor. Her export isleminde bellekte blob referansi kalici olarak tutuluyor. Cok sayida export yapan kullanicilarda tarayici bellek tuketimi artiyor.
- **Cozum:** `link.click()` sonrasinda `URL.revokeObjectURL(url)` cagrisi eklendi.

### 3. Stale Filter -- Search Parametresi Eksik
- **Sorun:** Export fonksiyonunda `filters.action`, `filters.severity`, `filters.entityType`, `filters.tenantId`, `filters.startDate`, `filters.endDate` API'ye gonderiliyor ancak `filters.search` gonderilmiyor. Kullanici arama kutusuna bir terim yazip "Export" dediginde, arama filtresi yok sayiliyor ve tum kayitlar export ediliyor.
- **Cozum:** `if (filters.search) params.search = filters.search;` satiri eklendi. Artik export, UI'da gorunen filtrelenmis veri setiyle uyumlu calisir.

## Yapilan Degisiklikler

### Yeni Fonksiyon: `escapeCsvCell` (satir 135-146)
```typescript
function escapeCsvCell(value: unknown): string {
  const str = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(str)) {
    return `"'${str.replace(/"/g, '""')}"`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
```

### `handleExport` Degisiklikleri (satir 338-374)
- `filters.search` parametresi API query'sine eklendi (satir 346)
- Tum hucre degerleri `escapeCsvCell()` ile sarmalandi (satir 353-361)
- `URL.revokeObjectURL(url)` cagrisi eklendi (satir 370)

## Etki Analizi
- **Guvenlik:** CSV injection saldirilari onlendi
- **Performans:** Object URL memory leak'i giderildi
- **Islevsellik:** Export artik arama filtresiyle uyumlu calisiyor
- **Geriye Uyumluluk:** Mevcut CSV formati korunuyor, ek bir breaking change yok
