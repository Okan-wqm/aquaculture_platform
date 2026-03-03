/*
 * loragw_hal.h — SX1302 HAL Stub Header
 *
 * Bu dosya, bindgen'in Rust FFI binding uretmesi icin gerekli minimum
 * fonksiyon imzalarini ve veri yapilarini icerir.
 *
 * GERCEK HEADER ICIN: Semtech'in sx1302_hal reposunu vendor/sx1302_hal
 * dizinine klonlayin. Bu stub, klonlama yapilana kadar derleme hatalari
 * olusmasini onler.
 *
 * Kaynak: https://github.com/Lora-net/sx1302_hal
 * Lisans: Semtech Revised BSD License
 */

#ifndef _LORAGW_HAL_H
#define _LORAGW_HAL_H

#include <stdint.h>
#include <stdbool.h>

/* --- SABITLER --- */

/* Maksimum paket boyutu (LoRa PHY: 255 byte) */
#define LGW_PKT_FIFO_SIZE   16
#define LGW_MAX_PKT_SIZE    256

/* RF kanal sayisi */
#define LGW_RF_CHAIN_NB     2
#define LGW_IF_CHAIN_NB     10
#define LGW_MULTI_NB        8

/* Modulation types */
#define LGW_MOD_LORA        0x10
#define LGW_MOD_FSK         0x20

/* --- VERI YAPILARI --- */

/**
 * Alinan paket yapisi.
 * lgw_receive() bu yapinin bir dizisini doldurur.
 *
 * SX1302, her alinan paket icin su bilgileri saglar:
 * - Payload (ham LoRa PHY katmani verisi, sifrelenmis)
 * - RSSI (alinan sinyal gucu, dBm cinsinden)
 * - SNR (sinyal-gurultu orani, dB cinsinden)
 * - Frekans (tam alim frekansi, Hz)
 * - Zaman damgasi (SX1302 dahili sayacinin degeri, mikrosaniye)
 * - Spreading factor, bandwidth, coderate (demodulasyon parametreleri)
 */
struct lgw_pkt_rx_s {
    uint32_t    freq_hz;        /* Alim frekansi (Hz) */
    uint8_t     if_chain;       /* IF kanal numarasi (0-9) */
    uint8_t     status;         /* Paket durumu (CRC OK, vb.) */
    uint32_t    count_us;       /* Dahili zaman damgasi (us) */
    uint8_t     rf_chain;       /* RF zincir numarasi (0 veya 1) */
    uint8_t     modulation;     /* Modulasyon tipi (LoRa=0x10, FSK=0x20) */
    uint8_t     bandwidth;      /* Bant genisligi kodu */
    uint32_t    datarate;       /* SF (LoRa) veya bit rate (FSK) */
    uint8_t     coderate;       /* LoRa coding rate (1=4/5, 2=4/6, 3=4/7, 4=4/8) */
    float       rssi;           /* RSSI (dBm) — tipik: -120 ile -30 arasi */
    float       snr;            /* SNR (dB) — tipik: -20 ile +15 arasi */
    uint16_t    size;           /* Payload boyutu (byte) */
    uint8_t     payload[256];   /* Ham payload verisi */
};

/**
 * Gonderilecek paket yapisi.
 * lgw_send() bu yapiyi alir ve TX FIFO'ya yazar.
 *
 * Class A downlink icin:
 * - tx_mode = TIMESTAMPED, count_us = RX penceresi zamani
 * - SX1302 dahili zamanlayici ile mikrosaniye hassasiyetinde gonderir
 */
struct lgw_pkt_tx_s {
    uint32_t    freq_hz;        /* Gonderim frekansi (Hz) */
    uint8_t     tx_mode;        /* 0=IMMEDIATE, 1=TIMESTAMPED, 2=ON_GPS */
    uint32_t    count_us;       /* Zamanlanmis gonderim icin hedef zaman (us) */
    uint8_t     rf_chain;       /* RF zincir (0 veya 1) */
    int8_t      rf_power;       /* TX gucu (dBm) — EU868: max +16, US915: max +26 */
    uint8_t     modulation;     /* Modulasyon tipi */
    uint8_t     bandwidth;      /* Bant genisligi kodu */
    uint32_t    datarate;       /* Spreading factor veya bit rate */
    uint8_t     coderate;       /* LoRa coding rate */
    bool        invert_pol;     /* Polarite inversiyon (downlink=true) */
    uint8_t     preamble;       /* Preamble uzunlugu (sembol) */
    bool        no_crc;         /* CRC devre disi */
    bool        no_header;      /* Implicit header modu */
    uint16_t    size;           /* Payload boyutu */
    uint8_t     payload[256];   /* Gonderilecek payload */
};

/* --- FONKSIYON IMZALARI --- */

/**
 * SX1302 konsantratorunu baslat.
 *
 * Bu fonksiyon su islemleri yapar:
 * 1. SPI baglantisini acar ve dogrular
 * 2. SX1302 chip ID'yi kontrol eder
 * 3. AGC firmware'ini dahili DSP'ye yukler (~4KB)
 * 4. ARB (arbiter) firmware'ini yukler
 * 5. Her kanal icin PLL kalibrasyonu yapar
 * 6. RX modunu baslatir (8 kanal esanli dinleme)
 *
 * @return 0 basari, -1 hata
 */
int lgw_start(void);

/**
 * SX1302'yi durdur ve SPI'yi kapat.
 *
 * TX ortasinda cagrilmamali — RF regulator zarar gorebilir.
 * Drop trait'inde otomatik olarak cagrilir.
 *
 * @return 0 basari, -1 hata
 */
int lgw_stop(void);

/**
 * Alinan paketleri oku.
 *
 * SX1302'nin dahili FIFO'sundan hazir paketleri alir.
 * Esanli 8 kanalda, farkli SF'lerde alinan tum paketler dahildir.
 * Non-blocking: paket yoksa nb_pkt=0 doner.
 *
 * @param max_pkt   Okunacak maksimum paket sayisi (genelde 16)
 * @param pkt_data  Paketlerin yazilacagi dizi (arayan tarafindan alinir)
 * @return Okunan paket sayisi (>=0), hata durumunda negatif
 */
int lgw_receive(uint8_t max_pkt, struct lgw_pkt_rx_s *pkt_data);

/**
 * Paket gonder.
 *
 * TX FIFO'ya bir paket ekler. SX1302, tx_mode'a gore:
 * - IMMEDIATE: Hemen gonderir
 * - TIMESTAMPED: count_us zamaninda gonderir (Class A RX penceresi)
 * - ON_GPS: GPS PPS sinyaline senkronize gonderir (Class B beacon)
 *
 * @param pkt_data  Gonderilecek paket verisi
 * @return 0 basari, -1 hata (TX kuyrugu dolu olabilir)
 */
int lgw_send(const struct lgw_pkt_tx_s *pkt_data);

/**
 * SX1302 dahili sicaklik sensorunu oku.
 *
 * +/- 1 derece C hassasiyetinde.
 * Calisma araligi: -40 ile +85 C.
 *
 * @param temperature  Okunan sicaklik degeri (C)
 * @return 0 basari, -1 hata
 */
int lgw_get_temperature(float *temperature);

#endif /* _LORAGW_HAL_H */
