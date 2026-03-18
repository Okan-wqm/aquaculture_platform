// ============================================================================
// MCP Farm Intelligence Server — İstatistiksel Yardımcı Fonksiyonlar
// ============================================================================
//
// Anomali tespiti ve korelasyon analizi için matematiksel temeller.
// Bu modül, farm-management MCP server'ın analitik yeteneklerinin
// temelini oluşturur.
//
// NASIL ÇALIŞIR:
//   Bu modül saf (pure) fonksiyonlar içerir — yan etkisi yoktur.
//   Her fonksiyon:
//     1. Girdi dizisinin geçerliliğini kontrol eder (boş dizi, tek eleman vb.)
//     2. Matematiksel formülü uygular
//     3. Sıfıra bölme ve edge case'leri güvenle ele alır
//
// Kullanım Alanları:
//   - Anomali Dedektörü: mean, stdDev, zScore, movingAverage
//   - Korelasyon Analizi: pearsonCorrelation, correlationPValue, correlationConfidenceInterval
//   - Trend Analizi: linearRegressionSlope, percentChange
//   - Veri Normalizasyonu: normalize, median
//
// EXTENSIBLE:
//   - Yeni istatistiksel fonksiyonlar buraya eklenebilir
//   - Mevcut fonksiyonlar import edilerek diğer modüllerde kullanılır
//   - Tüm fonksiyonlar immutable'dır — orijinal diziyi değiştirmez
// ============================================================================

// ── Temel İstatistikler ─────────────────────────────────────────

/**
 * Aritmetik ortalama hesaplar.
 *
 * Formül: μ = Σxᵢ / n
 *
 * NASIL ÇALIŞIR:
 *   1. Tüm değerleri topla (reduce ile Σxᵢ)
 *   2. Toplam sayıya böl (n)
 *
 * Edge case'ler:
 *   - Boş dizi → 0 döner (sıfıra bölme koruması)
 *
 * @param values - Sayı dizisi
 * @returns Aritmetik ortalama değeri
 */
export function mean(values: number[]): number {
  // Boş dizi kontrolü — sıfıra bölme koruması
  if (values.length === 0) return 0;

  // Σxᵢ: tüm değerlerin toplamı
  const sum = values.reduce((acc, val) => acc + val, 0);

  // μ = Σxᵢ / n
  return sum / values.length;
}

/**
 * Örneklem standart sapmasını hesaplar.
 *
 * Formül: σ = √(Σ(xᵢ - μ)² / (n - 1))
 *
 * NASIL ÇALIŞIR:
 *   1. Önce aritmetik ortalamayı hesapla (μ)
 *   2. Her değerin ortalamadan farkının karesini al: (xᵢ - μ)²
 *   3. Kare farkları topla: Σ(xᵢ - μ)²
 *   4. (n-1)'e böl (Bessel düzeltmesi — örneklem için n-1 kullanılır)
 *   5. Karekökünü al
 *
 * Neden n-1 (Bessel düzeltmesi)?
 *   Örneklem standart sapması, popülasyon standart sapmasının
 *   yansız (unbiased) tahmincisidir. n yerine (n-1) kullanmak
 *   bu yanlılığı düzeltir.
 *
 * Edge case'ler:
 *   - 0 veya 1 elemanlı dizi → 0 döner (yetersiz veri)
 *
 * @param values - Sayı dizisi (en az 2 eleman önerilir)
 * @returns Örneklem standart sapması
 */
export function stdDev(values: number[]): number {
  // Yetersiz veri kontrolü — standart sapma en az 2 değer gerektirir
  if (values.length <= 1) return 0;

  // Adım 1: Ortalamayı hesapla
  const avg = mean(values);

  // Adım 2-3: Kare farkların toplamı — Σ(xᵢ - μ)²
  const squaredDiffs = values.reduce((acc, val) => {
    const diff = val - avg;      // xᵢ - μ
    return acc + diff * diff;    // (xᵢ - μ)² toplama eklenir
  }, 0);

  // Adım 4-5: Bessel düzeltmeli varyansın karekökü
  // σ = √(Σ(xᵢ - μ)² / (n - 1))
  return Math.sqrt(squaredDiffs / (values.length - 1));
}

/**
 * Z-score hesaplar — bir değerin ortalamadan kaç standart sapma uzakta olduğu.
 *
 * Formül: z = (x - μ) / σ
 *
 * NASIL ÇALIŞIR:
 *   1. Değerden ortalamayı çıkar (x - μ)
 *   2. Standart sapmaya böl (σ)
 *   3. Sonuç: kaç standart sapma uzaklıkta olduğunu gösterir
 *
 * Yorumlama:
 *   |z| < 1  → Normal aralıkta
 *   |z| < 2  → Biraz yüksek/düşük
 *   |z| < 3  → Olağandışı
 *   |z| >= 3 → Anomali (çok nadir)
 *
 * Anomali tespitinde z-score yaygın kullanılır:
 *   |z| > 2 veya |z| > 3 eşiği anomali olarak işaretlenir
 *
 * Edge case'ler:
 *   - stdDev = 0 → 0 döner (tüm değerler aynıysa sapma yoktur)
 *
 * @param value - Test edilecek değer (x)
 * @param meanVal - Ortalama (μ)
 * @param stdDevVal - Standart sapma (σ)
 * @returns Z-score değeri
 */
export function zScore(value: number, meanVal: number, stdDevVal: number): number {
  // Sıfıra bölme koruması — tüm değerler aynıysa sapma 0'dır
  // Bu durumda z-score anlamsızdır, 0 dönülür
  if (stdDevVal === 0) return 0;

  // z = (x - μ) / σ
  return (value - meanVal) / stdDevVal;
}

// ── Hareketli Ortalama ──────────────────────────────────────────

/**
 * Basit hareketli ortalama (SMA — Simple Moving Average) hesaplar.
 *
 * Formül: SMAₜ = (xₜ + xₜ₋₁ + ... + xₜ₋ₖ₊₁) / k  (k = pencere boyutu)
 *
 * NASIL ÇALIŞIR:
 *   1. Dizinin her noktası için son k değerin ortalamasını hesapla
 *   2. İlk (k-1) noktada pencere tam dolmadığı için mevcut değerler kullanılır
 *   3. Sonuç: orijinal diziyle aynı uzunlukta yumuşatılmış dizi
 *
 * Kullanım amacı:
 *   - Gürültülü sensör verilerini düzleştirme
 *   - Kısa vadeli dalgalanmaları filtreleme
 *   - Trend belirleme
 *
 * Örnek (windowSize=3):
 *   Girdi:  [1, 3, 5, 7, 9]
 *   Çıktı:  [1, 2, 3, 5, 7]
 *   İndeks 0: sadece [1] → ort = 1
 *   İndeks 1: [1, 3] → ort = 2
 *   İndeks 2: [1, 3, 5] → ort = 3
 *   İndeks 3: [3, 5, 7] → ort = 5
 *   İndeks 4: [5, 7, 9] → ort = 7
 *
 * Edge case'ler:
 *   - Boş dizi → boş dizi döner
 *   - windowSize <= 0 → her eleman kendi değeri olur (hata koruması)
 *   - windowSize > dizi uzunluğu → tüm mevcut elemanların ortalaması
 *
 * @param values - Zaman serisi verileri
 * @param windowSize - Pencere boyutu (kaç son değer ortalaması alınacak)
 * @returns Hareketli ortalama dizisi (girdişle aynı uzunlukta)
 */
export function movingAverage(values: number[], windowSize: number): number[] {
  // Boş dizi kontrolü
  if (values.length === 0) return [];

  // Pencere boyutu en az 1 olmalı
  const effectiveWindow = Math.max(1, windowSize);

  return values.map((_, index) => {
    // Pencere başlangıç indeksi — negatif olamaz
    const start = Math.max(0, index - effectiveWindow + 1);

    // Pencere içindeki değerler (slice ile alt dizi)
    const window = values.slice(start, index + 1);

    // Penceredeki değerlerin ortalaması
    return mean(window);
  });
}

// ── Korelasyon Analizi ──────────────────────────────────────────

/**
 * Pearson korelasyon katsayısını hesaplar.
 *
 * Formül: r = Σ((xᵢ - x̄)(yᵢ - ȳ)) / √(Σ(xᵢ - x̄)² × Σ(yᵢ - ȳ)²)
 *
 * NASIL ÇALIŞIR:
 *   1. İki dizinin ortalamalarını hesapla (x̄ ve ȳ)
 *   2. Her çift için sapma çarpımını hesapla: (xᵢ - x̄)(yᵢ - ȳ)
 *   3. Sapma çarpımlarının toplamını hesapla: Σ((xᵢ - x̄)(yᵢ - ȳ))
 *   4. Her dizinin kare sapmalar toplamını hesapla: Σ(xᵢ - x̄)² ve Σ(yᵢ - ȳ)²
 *   5. Pay'ı payda'ya böl: r = pay / √(paydaX × paydaY)
 *
 * Yorumlama:
 *   r = +1.0  → Tam pozitif korelasyon (birlikte artarlar)
 *   r = +0.7  → Güçlü pozitif korelasyon
 *   r = +0.3  → Zayıf pozitif korelasyon
 *   r =  0.0  → Korelasyon yok
 *   r = -0.3  → Zayıf negatif korelasyon
 *   r = -0.7  → Güçlü negatif korelasyon
 *   r = -1.0  → Tam negatif korelasyon (biri artarken diğeri azalır)
 *
 * Akvakültürdeki kullanım örnekleri:
 *   - pH ↔ oksijen korelasyonu
 *   - Sıcaklık ↔ yem tüketimi korelasyonu
 *   - Amonyak ↔ ölüm oranı korelasyonu
 *
 * Edge case'ler:
 *   - Diziler farklı uzunlukta → kısa olanın uzunluğu kullanılır
 *   - 0 veya 1 elemanlı diziler → 0 döner (korelasyon anlamsız)
 *   - Sabit dizi (tüm değerler aynı) → payda 0, dolayısıyla 0 döner
 *
 * @param x - Birinci değişken dizisi
 * @param y - İkinci değişken dizisi
 * @returns Pearson r katsayısı (-1 ile +1 arası)
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  // Ortak uzunluk — kısa olan dizi belirler
  const n = Math.min(x.length, y.length);

  // Yetersiz veri kontrolü — korelasyon en az 2 çift gerektirir
  if (n <= 1) return 0;

  // Adım 1: Ortalamaları hesapla
  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);
  const xMean = mean(xSlice);
  const yMean = mean(ySlice);

  // Adım 2-4: Sapma çarpımları ve kare sapmalar
  let numerator = 0;    // Pay: Σ((xᵢ - x̄)(yᵢ - ȳ))
  let denomX = 0;       // Payda X: Σ(xᵢ - x̄)²
  let denomY = 0;       // Payda Y: Σ(yᵢ - ȳ)²

  for (let i = 0; i < n; i++) {
    const dx = xSlice[i]! - xMean;   // xᵢ - x̄ (x sapması)
    const dy = ySlice[i]! - yMean;   // yᵢ - ȳ (y sapması)

    numerator += dx * dy;   // Sapma çarpımlarının toplamı
    denomX += dx * dx;      // X kare sapmalar toplamı
    denomY += dy * dy;      // Y kare sapmalar toplamı
  }

  // Adım 5: Payda hesabı ve sıfıra bölme kontrolü
  const denominator = Math.sqrt(denomX * denomY);

  // Sabit dizi kontrolü — standart sapma 0 ise korelasyon anlamsız
  if (denominator === 0) return 0;

  // r = pay / payda — sonuç -1 ile +1 arasında
  return numerator / denominator;
}

/**
 * Korelasyon katsayısı için p-value yaklaşımı hesaplar.
 *
 * Formül: t = r × √(n - 2) / √(1 - r²)
 *
 * NASIL ÇALIŞIR:
 *   1. t-istatistiğini hesapla (Student's t-dağılımı)
 *   2. t-değerini yaklaşık p-value'ya çevir
 *   3. p-value: korelasyonun tesadüfi olma olasılığı
 *
 * t-dağılımı yaklaşımı:
 *   Büyük örneklem (n > 30) için normal dağılım yaklaşımı kullanılır.
 *   Küçük örneklem için t-dağılımı tablosu daha doğrudur ancak
 *   pratik amaçlar için bu yaklaşım yeterlidir.
 *
 * Yorumlama:
 *   p < 0.001 → Çok güçlü istatistiksel anlamlılık
 *   p < 0.01  → Güçlü istatistiksel anlamlılık
 *   p < 0.05  → İstatistiksel olarak anlamlı
 *   p >= 0.05 → İstatistiksel olarak anlamlı DEĞİL
 *
 * Edge case'ler:
 *   - n <= 2 → 1 döner (yetersiz veri, anlamlılık yok)
 *   - |r| = 1 → 0 döner (tam korelasyon, kesinlikle anlamlı)
 *   - |r| ≈ 1 → sıfıra bölme koruması
 *
 * @param r - Pearson korelasyon katsayısı
 * @param n - Örneklem büyüklüğü (çift sayısı)
 * @returns Yaklaşık p-value (0-1 arası)
 */
export function correlationPValue(r: number, n: number): number {
  // Yetersiz veri — serbestlik derecesi (df) en az 1 olmalı
  // df = n - 2, dolayısıyla n en az 3 olmalı
  if (n <= 2) return 1;

  // Tam korelasyon — kesinlikle anlamlı
  const rAbs = Math.abs(r);
  if (rAbs >= 1) return 0;

  // ── t-istatistiği hesabı ──────────────────────────────────
  // t = r × √(n - 2) / √(1 - r²)
  // Serbestlik derecesi (degrees of freedom): df = n - 2
  const df = n - 2;
  const tStat = rAbs * Math.sqrt(df) / Math.sqrt(1 - r * r);

  // ── p-value yaklaşımı (iki kuyruklu) ──────────────────────
  // Basitleştirilmiş yaklaşım: e^(-0.717 × t - 0.416 × t²)
  // Bu yaklaşım büyük t değerlerinde doğruluğu azalır ancak
  // pratik kullanım için (anlamlı/anlamsız kararı) yeterlidir.
  //
  // Daha doğru bir yaklaşım:
  // Regularized incomplete beta function kullanılır ama
  // bu karmaşıklık pratik ihtiyacın ötesindedir.
  //
  // Alternatif basit yaklaşım: t-dağılımı kuyruğu
  // P ≈ 2 × (1 - Φ(t)) normal yaklaşımı (büyük df için)
  // Φ: standart normal CDF
  const p = 2 * tDistributionTail(tStat, df);

  // p-value 0 ile 1 arasında sınırlandırılır
  return Math.max(0, Math.min(1, p));
}

/**
 * t-dağılımı kuyruk olasılığı yaklaşımı (dahili yardımcı).
 *
 * Büyük df değerleri için normal dağılım yaklaşımı kullanır.
 * Küçük df için düzeltme uygular.
 *
 * @param t - t-istatistiği (pozitif)
 * @param df - Serbestlik derecesi
 * @returns Tek kuyruk olasılığı
 */
function tDistributionTail(t: number, df: number): number {
  // Basitleştirilmiş yaklaşım:
  // df >= 30 → standart normal yaklaşımı
  // df < 30 → düzeltilmiş normal yaklaşımı
  //
  // Normal CDF yaklaşımı (Abramowitz & Stegun 26.2.17):
  // Φ(x) ≈ 1 - φ(x)(b₁t + b₂t² + b₃t³)
  // burada t = 1/(1 + 0.2316419x), φ(x) = normal PDF

  // df düzeltmesi: küçük df'lerde kuyruğu kalınlaştır
  const adjustedT = t * Math.sqrt(df / (df + t * t / 3));

  // Standart normal kuyruk yaklaşımı
  // erfc yaklaşımı: P(X > x) ≈ (1/2) × erfc(x / √2)
  return 0.5 * erfc(adjustedT / Math.SQRT2);
}

/**
 * Tamamlayıcı hata fonksiyonu (erfc) yaklaşımı (dahili yardımcı).
 *
 * erfc(x) = 1 - erf(x) = (2/√π) × ∫ₓ^∞ e^(-t²) dt
 *
 * Abramowitz & Stegun yaklaşımı (formül 7.1.26) kullanılır.
 * Maksimum hata: |ε(x)| ≤ 1.5 × 10⁻⁷
 *
 * @param x - Girdi değeri
 * @returns erfc(x) yaklaşımı
 */
export function erfc(x: number): number {
  // Negatif değerler için: erfc(-x) = 2 - erfc(x)
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);

  // Abramowitz & Stegun katsayıları (7.1.26)
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * absX);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;

  // erfc(x) ≈ (a₁t + a₂t² + a₃t³ + a₄t⁴ + a₅t⁵) × e^(-x²)
  const erfcVal = (a1 * t + a2 * t2 + a3 * t3 + a4 * t4 + a5 * t5)
    * Math.exp(-absX * absX);

  // Negatif x için düzeltme
  return sign >= 0 ? erfcVal : 2 - erfcVal;
}

/**
 * Pearson korelasyon katsayısı için %95 güven aralığı hesaplar.
 *
 * Fisher z-transform yaklaşımı kullanılır.
 *
 * Formül:
 *   z = arctanh(r) = 0.5 × ln((1+r)/(1-r))  (Fisher z-dönüşümü)
 *   SE = 1 / √(n - 3)                         (standart hata)
 *   z_alt = z - 1.96 × SE                     (%95 alt sınır, z uzayında)
 *   z_üst = z + 1.96 × SE                     (%95 üst sınır, z uzayında)
 *   r_alt = tanh(z_alt)                        (r uzayına geri dönüşüm)
 *   r_üst = tanh(z_üst)                        (r uzayına geri dönüşüm)
 *
 * NASIL ÇALIŞIR:
 *   1. r'yi Fisher z-uzayına dönüştür (arctanh)
 *      → z-uzayında korelasyon yaklaşık normal dağılır
 *   2. z-uzayında güven aralığını hesapla (z ± 1.96×SE)
 *      → 1.96 = standart normal dağılımın %97.5 kantili (%95 iki kuyruklu)
 *   3. Güven aralığı sınırlarını r-uzayına geri dönüştür (tanh)
 *   4. Sonuç: [lower, upper] → gerçek korelasyonun %95 olasılıkla düştüğü aralık
 *
 * Neden Fisher z-transform?
 *   Pearson r normal dağılmaz (özellikle |r| > 0.5 iken).
 *   Fisher z-dönüşümü r'yi yaklaşık normal dağılan bir değişkene çevirir,
 *   böylece standart güven aralığı formülleri uygulanabilir.
 *
 * Edge case'ler:
 *   - n <= 3 → güven aralığı hesaplanamaz, [-1, 1] döner
 *   - |r| = 1 → arctanh tanımsız, r'yi ±0.999 ile sınırla
 *
 * @param r - Pearson korelasyon katsayısı (-1 ile +1 arası)
 * @param n - Örneklem büyüklüğü (çift sayısı)
 * @returns %95 güven aralığı { lower, upper }
 */
export function correlationConfidenceInterval(
  r: number,
  n: number,
): { lower: number; upper: number } {
  // Yetersiz veri — güven aralığı hesaplanamaz
  // SE = 1/√(n-3) → n=3 iken sıfıra bölme, n<3 iken negatif kök
  if (n <= 3) {
    return { lower: -1, upper: 1 };
  }

  // |r| = 1 olduğunda arctanh tanımsız → ±0.999 ile sınırla
  const clampedR = Math.max(-0.999, Math.min(0.999, r));

  // Adım 1: Fisher z-dönüşümü — arctanh(r)
  // z = 0.5 × ln((1 + r) / (1 - r))
  const fisherZ = Math.atanh(clampedR);

  // Adım 2: Standart hata — SE = 1 / √(n - 3)
  const se = 1 / Math.sqrt(n - 3);

  // Adım 3: %95 güven aralığı (z-uzayında)
  // 1.96 = standart normal dağılımın %97.5 kantili
  const zLower = fisherZ - 1.96 * se;
  const zUpper = fisherZ + 1.96 * se;

  // Adım 4: r-uzayına geri dönüşüm — tanh(z)
  return {
    lower: Math.tanh(zLower),
    upper: Math.tanh(zUpper),
  };
}

// ── Regresyon ve Trend ──────────────────────────────────────────

/**
 * Basit lineer regresyon eğimini (slope) hesaplar.
 *
 * Formül: slope = Σ((xᵢ - x̄)(yᵢ - ȳ)) / Σ(xᵢ - x̄)²
 *
 * NASIL ÇALIŞIR:
 *   1. x ve y dizilerinin ortalamalarını hesapla
 *   2. Pay: her çiftin sapma çarpımlarının toplamı → Σ((xᵢ - x̄)(yᵢ - ȳ))
 *   3. Payda: x kare sapmalar toplamı → Σ(xᵢ - x̄)²
 *   4. Eğim = pay / payda
 *
 * Yorumlama:
 *   slope > 0 → Y, X arttıkça artar (pozitif trend)
 *   slope = 0 → Trend yok (yatay çizgi)
 *   slope < 0 → Y, X arttıkça azalır (negatif trend)
 *
 * Akvakültürdeki kullanım:
 *   x = zaman (gün/saat), y = ölçüm değeri
 *   slope → birim zamandaki değişim hızı (trend yönü ve şiddeti)
 *
 * Edge case'ler:
 *   - Diziler farklı uzunlukta → kısa olanın uzunluğu kullanılır
 *   - 0 veya 1 eleman → 0 döner
 *   - x sabitse (tüm x aynı) → payda 0, 0 döner
 *
 * @param x - Bağımsız değişken dizisi (örn: zaman)
 * @param y - Bağımlı değişken dizisi (örn: sıcaklık)
 * @returns Regresyon eğimi
 */
export function linearRegressionSlope(x: number[], y: number[]): number {
  // Ortak uzunluk
  const n = Math.min(x.length, y.length);

  // Yetersiz veri kontrolü
  if (n <= 1) return 0;

  // Ortalamaları hesapla
  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);
  const xMean = mean(xSlice);
  const yMean = mean(ySlice);

  // Pay ve payda hesabı
  let numerator = 0;   // Σ((xᵢ - x̄)(yᵢ - ȳ))
  let denominator = 0;  // Σ(xᵢ - x̄)²

  for (let i = 0; i < n; i++) {
    const dx = xSlice[i]! - xMean;
    const dy = ySlice[i]! - yMean;
    numerator += dx * dy;
    denominator += dx * dx;
  }

  // Sıfıra bölme koruması (x sabitse payda = 0)
  if (denominator === 0) return 0;

  return numerator / denominator;
}

/**
 * İki değer arasındaki yüzde değişimi hesaplar.
 *
 * Formül: %Δ = ((yeni - eski) / |eski|) × 100
 *
 * NASIL ÇALIŞIR:
 *   1. Farkı hesapla: yeni - eski
 *   2. Eski değerin mutlak değerine böl: / |eski|
 *   3. 100 ile çarp (yüzdeye çevir)
 *
 * Yorumlama:
 *   +50  → %50 artış
 *   -25  → %25 azalış
 *   0    → Değişim yok
 *   +100 → 2 katına çıkmış
 *
 * Edge case'ler:
 *   - eski = 0, yeni = 0 → 0 döner (değişim yok)
 *   - eski = 0, yeni ≠ 0 → Infinity problemi, bunun yerine 100 veya -100 döner
 *
 * @param oldValue - Önceki değer (referans)
 * @param newValue - Yeni değer
 * @returns Yüzde değişim
 */
export function percentChange(oldValue: number, newValue: number): number {
  // Her iki değer de sıfırsa değişim yok
  if (oldValue === 0 && newValue === 0) return 0;

  // Eski değer sıfırsa sonsuzluk problemi
  // Pratik çözüm: yönü koruyarak %100 veya -%100 dön
  if (oldValue === 0) {
    return newValue > 0 ? 100 : -100;
  }

  // Normal hesaplama: ((yeni - eski) / |eski|) × 100
  // |eski| kullanılır ki negatif eski değerler yönü tersine çevirmesin
  return ((newValue - oldValue) / Math.abs(oldValue)) * 100;
}

// ── Yardımcı İstatistikler ──────────────────────────────────────

/**
 * Medyanı (ortanca değer) hesaplar.
 *
 * NASIL ÇALIŞIR:
 *   1. Diziyi küçükten büyüğe sırala (orijinali değiştirmez)
 *   2. Eleman sayısı tekse → ortadaki değer
 *   3. Eleman sayısı çiftse → ortadaki iki değerin ortalaması
 *
 * Neden medyan kullanılır?
 *   Ortalama (mean) aşırı değerlerden (outlier) etkilenir.
 *   Medyan aşırı değerlere dayanıklıdır (robust).
 *   Örnek: [1, 2, 3, 4, 100] → mean=22, median=3
 *
 * Edge case'ler:
 *   - Boş dizi → 0 döner
 *   - Tek eleman → o elemanın kendisi
 *
 * @param values - Sayı dizisi (sırasız olabilir)
 * @returns Medyan değeri
 */
export function median(values: number[]): number {
  // Boş dizi kontrolü
  if (values.length === 0) return 0;

  // Sıralama — orijinal diziyi korumak için kopyasını sırala
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  // Çift eleman sayısı → ortadaki ikisinin ortalaması
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  // Tek eleman sayısı → ortadaki değer
  return sorted[mid]!;
}

/**
 * Min-max normalizasyonu uygular.
 *
 * Formül: norm = (x - min) / (max - min) → [0, 1] aralığına eşler
 *
 * NASIL ÇALIŞIR:
 *   1. Değerden minimum'u çıkar (sıfır noktasına taşı)
 *   2. Aralık genişliğine böl (0-1 ölçeğine dönüştür)
 *   3. Sonuç: 0.0 (minimum) ile 1.0 (maksimum) arasında
 *
 * Kullanım amacı:
 *   Farklı ölçeklerdeki değerleri karşılaştırılabilir hale getirme.
 *   Örnek: pH (0-14) ve sıcaklık (15-35°C) → ikisi de 0-1 arasında
 *
 * Edge case'ler:
 *   - min = max → 0 döner (aralık genişliği 0, normalizasyon anlamsız)
 *   - x < min veya x > max → 0'dan küçük veya 1'den büyük olabilir
 *     (bu fonksiyon clamping yapmaz — kasıtlıdır)
 *
 * @param value - Normalize edilecek değer
 * @param min - Aralık minimum'u
 * @param max - Aralık maksimum'u
 * @returns Normalize edilmiş değer (tipik olarak 0-1 arası)
 */
export function normalize(value: number, min: number, max: number): number {
  // Aralık genişliği 0 ise normalizasyon anlamsız
  const range = max - min;
  if (range === 0) return 0;

  // (x - min) / (max - min)
  return (value - min) / range;
}
