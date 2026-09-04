# &lt;ARIA adı&gt; — Tanım

Durum: TASLAK. Bu dosya `arias/_template/` kopyalandığında ilk doldurulacak yerdir.
Doldurulmadan `status` alanı `draft` üstüne çıkarılmaz.

## 1. Bu ARIA nedir

Tek cümlede ne yaptığı. Hangi külliyatı gözlemler, kimin için, hangi kararı kolaylaştırır.

## 2. Kapsam

Hangi sorulara cevap verir. Her madde bir yetenek olmalı, bir istek değil.

## 3. Amaç-dışı

Neyi bilerek yapmaz. Bu liste ürün vaadini sınırlar ve `aria.manifest.json` içindeki
`non_goals` ile aynı olmalıdır. Boş bırakılamaz.

## 4. Külliyat

Ne okunur, ne okunmaz, ne dışlanır. Dışlanan kök sessizce atlanmaz, raporlanır (P-3).
Külliyat türü `git_repository` değilse çekirdek boşluğu G-1'in durumu burada belirtilir.

## 5. Kaslar

Bu ARIA'nın etkinleştirdiği kaslar ve her birinin rolü. Bir kasın ayrı paket olmayı hak
etmesi için üç şeyi birden taşıması gerekir: kendi fikstür korpusu, kendi sürüm ritmi ve
onu diğeri olmadan kuran bir tüketici.

## 6. Onay ve insan sınırı

Hangi eylem hangi rolün onayını ister. Hangi çıktı asla otomatik "doğrulanmış" sayılmaz.

## 7. Kabul ölçütleri

Bu ARIA'nın çalıştığını neyin kanıtladığı: fikstür korpusu, eşik değerleri, ölçülen sayı.
