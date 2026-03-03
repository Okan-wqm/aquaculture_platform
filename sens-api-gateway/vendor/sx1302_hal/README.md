# SX1302 HAL — Semtech LoRa Concentrator Hardware Abstraction Layer

Bu dizin, Semtech'in SX1302 konsantrator cipi icin resmi C HAL kutuphanesini icerir.
Lisans ve boyut sebebiyle kaynak kod bu repo'ya dahil edilmemistir.

## Kurulum

Gercek donanim destegi icin Semtech'in resmi HAL reposunu bu dizine klonlayin:

```bash
cd vendor/sx1302_hal
git clone https://github.com/Lora-net/sx1302_hal.git .
```

Veya belirli bir surum icin:

```bash
git clone --branch V2.1.0 https://github.com/Lora-net/sx1302_hal.git .
```

## Dizin Yapisi

Klonlamadan sonra su dizin yapisi olusur:

```
vendor/sx1302_hal/
  libloragw/
    inc/          <- C header dosyalari (bindgen bunlari okur)
      loragw_hal.h    <- Ana HAL API header'i
      loragw_reg.h    <- Register tanimlari
      loragw_spi.h    <- SPI iletisim katmani
    src/          <- C kaynak dosyalari (cc crate bunlari derler)
      loragw_hal.c    <- Ana HAL implementasyonu
      loragw_reg.c    -> Register okuma/yazma
      loragw_spi.c    -> SPI iletisim
      loragw_cal.c    -> PLL/AGC kalibrasyon
```

## Gelistirme Ortami (Simulasyon)

HAL kaynaklari olmadan da proje derlenir. `lorawan` feature aktif degilken
simulasyon modu calisir ve donanim gerektirmez:

```bash
# Simulasyon modu (varsayilan)
cargo build

# Gercek donanim (HAL klonlanmis olmali)
cargo build --features lorawan
```

## Stub Header

`libloragw/inc/loragw_hal.h` dosyasi, bindgen'in kullanacagi minimum
fonksiyon imzalarini icerir. Gercek HAL klonlandiginda bu dosya uzerine
yazilir.

## Desteklenen Gateway Kartlari

- RAK2287 (SX1302 + SX1250, mPCIe)
- Semtech CoreCell (SX1302 referans tasarimi)
- Dragino PG1302 (Raspberry Pi HAT)
- Seeed WM1302 (SPI/USB)
