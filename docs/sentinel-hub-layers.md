# Sentinel Hub Custom Layers - Aquaculture Water Quality

Bu evalscript'leri Sentinel Hub Dashboard'da Configuration Instance'a ekleyin.

**Dashboard URL:** https://shapps.dataspace.copernicus.eu/
**Instance ID:** b6b8c826-6c34-44e0-a511-994ba64fcabe

---

## 1. CHLOROPHYLL (Klorofil-a)

**Layer Name:** `CHLOROPHYLL`

```javascript
//VERSION=3
function setup() {
  return {
    input: ["B03", "B04", "B05", "dataMask"],
    output: { bands: 4 }
  };
}

function evaluatePixel(sample) {
  // Chlorophyll-a estimation using red-edge bands
  let chl = 14.039 + 86.115 * (sample.B05 / Math.max(sample.B04, 0.001))
            - 194.325 * (sample.B04 / Math.max(sample.B03, 0.001));
  chl = Math.max(0, chl);

  // Color mapping
  let r, g, b;
  if (chl < 5) {
    r = 0.1; g = 0.3; b = 0.8;  // Düşük - Mavi
  } else if (chl < 10) {
    r = 0.2; g = 0.6; b = 0.8;  // Orta-düşük - Açık mavi
  } else if (chl < 20) {
    r = 0.3; g = 0.8; b = 0.3;  // Orta - Yeşil
  } else if (chl < 50) {
    r = 0.8; g = 0.8; b = 0.2;  // Yüksek - Sarı
  } else if (chl < 100) {
    r = 0.9; g = 0.5; b = 0.1;  // Çok yüksek - Turuncu
  } else {
    r = 0.9; g = 0.2; b = 0.2;  // Aşırı - Kırmızı
  }

  return [r, g, b, sample.dataMask];
}
```

---

## 2. CYANOBACTERIA (Siyanobakteri / HAB)

**Layer Name:** `CYANOBACTERIA`

```javascript
//VERSION=3
function setup() {
  return {
    input: ["B02", "B03", "B04", "B05", "dataMask"],
    output: { bands: 4 }
  };
}

function evaluatePixel(sample) {
  // Cyanobacteria Index using phycocyanin absorption
  let cya = 115530.31 * Math.pow(
    (sample.B03 * sample.B04) / Math.max(sample.B02, 0.001),
    2.38
  );

  // Color mapping (cells/mL)
  let r, g, b;
  if (cya < 10000) {
    r = 0.1; g = 0.4; b = 0.8;  // Düşük - Mavi
  } else if (cya < 50000) {
    r = 0.3; g = 0.7; b = 0.4;  // Orta - Yeşil
  } else if (cya < 100000) {
    r = 0.9; g = 0.9; b = 0.2;  // Yüksek - Sarı
  } else if (cya < 500000) {
    r = 0.9; g = 0.5; b = 0.1;  // Çok yüksek - Turuncu
  } else {
    r = 0.9; g = 0.1; b = 0.1;  // Tehlikeli - Kırmızı
  }

  return [r, g, b, sample.dataMask];
}
```

---

## 3. TURBIDITY (Bulanıklık)

**Layer Name:** `TURBIDITY`

```javascript
//VERSION=3
function setup() {
  return {
    input: ["B01", "B03", "B04", "dataMask"],
    output: { bands: 4 }
  };
}

function evaluatePixel(sample) {
  // Turbidity estimation (NTU)
  let turb = 8.93 * (sample.B03 / Math.max(sample.B01, 0.001)) - 6.39;
  turb = Math.max(0, turb);

  // Color mapping
  let r, g, b;
  if (turb < 5) {
    r = 0.1; g = 0.5; b = 0.9;  // Temiz - Mavi
  } else if (turb < 10) {
    r = 0.3; g = 0.7; b = 0.8;  // Düşük - Açık mavi
  } else if (turb < 25) {
    r = 0.5; g = 0.8; b = 0.5;  // Orta - Yeşil
  } else if (turb < 50) {
    r = 0.8; g = 0.7; b = 0.3;  // Yüksek - Sarı
  } else if (turb < 100) {
    r = 0.8; g = 0.5; b = 0.2;  // Çok yüksek - Turuncu
  } else {
    r = 0.6; g = 0.4; b = 0.3;  // Aşırı - Kahverengi
  }

  return [r, g, b, sample.dataMask];
}
```

---

## 4. CDOM (Çözünmüş Organik Madde)

**Layer Name:** `CDOM`

```javascript
//VERSION=3
function setup() {
  return {
    input: ["B02", "B03", "B04", "dataMask"],
    output: { bands: 4 }
  };
}

function evaluatePixel(sample) {
  // CDOM index
  let cdom = (sample.B04 - sample.B02) / Math.max(sample.B03, 0.001);

  // Color mapping
  let r, g, b;
  if (cdom < 0.1) {
    r = 0.2; g = 0.6; b = 0.9;  // Düşük - Mavi
  } else if (cdom < 0.3) {
    r = 0.4; g = 0.7; b = 0.6;  // Orta-düşük - Camgöbeği
  } else if (cdom < 0.5) {
    r = 0.6; g = 0.6; b = 0.3;  // Orta - Zeytin
  } else {
    r = 0.5; g = 0.3; b = 0.1;  // Yüksek - Kahverengi
  }

  return [r, g, b, sample.dataMask];
}
```

---

## 5. TSS (Askıda Katı Madde)

**Layer Name:** `TSS`

```javascript
//VERSION=3
function setup() {
  return {
    input: ["B02", "B03", "B04", "dataMask"],
    output: { bands: 4 }
  };
}

function evaluatePixel(sample) {
  // TSS estimation (mg/L)
  let tss = 1.89 * Math.pow(sample.B04 / Math.max(sample.B02, 0.001), 1.17);

  // Color mapping
  let r, g, b;
  if (tss < 10) {
    r = 0.1; g = 0.4; b = 0.8;  // Temiz - Mavi
  } else if (tss < 25) {
    r = 0.3; g = 0.6; b = 0.7;  // Düşük - Açık mavi
  } else if (tss < 50) {
    r = 0.5; g = 0.7; b = 0.4;  // Orta - Yeşil
  } else if (tss < 100) {
    r = 0.7; g = 0.6; b = 0.3;  // Yüksek - Sarı
  } else {
    r = 0.6; g = 0.4; b = 0.2;  // Çok yüksek - Kahverengi
  }

  return [r, g, b, sample.dataMask];
}
```

---

## Kurulum Adımları

1. https://shapps.dataspace.copernicus.eu/ adresine git
2. Sol menüden **Configuration Utility** seç
3. Instance'ı seç: `wqmtest` (b6b8c826-6c34-44e0-a511-994ba64fcabe)
4. **Layers** sekmesine git
5. Her katman için:
   - **Add Layer** tıkla
   - Layer Name'i yukarıdaki gibi gir (CHLOROPHYLL, CYANOBACTERIA, vb.)
   - Evalscript'i yapıştır
   - **Save** tıkla
6. Tüm katmanları ekledikten sonra **Save Configuration** tıkla

---

## Layer Mapping (Frontend)

Frontend'de kullanılan mapping:

| Frontend Layer | WMTS Layer Name |
|----------------|-----------------|
| TRUE-COLOR | TRUE_COLOR |
| CHLOROPHYLL | CHLOROPHYLL |
| CYANOBACTERIA | CYANOBACTERIA |
| TURBIDITY | TURBIDITY |
| CDOM | CDOM |
| TSS | TSS |
| NDVI | NDVI |
| MOISTURE | MOISTURE_INDEX |
