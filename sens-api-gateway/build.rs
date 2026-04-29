// build.rs — LoRaWAN SX1302 HAL derleme betigi
//
// Semtech sx1302_hal C kutuphanesini statik olarak derler ve bindgen ile Rust FFI
// binding uretir. Sadece `lorawan` feature aktifken calisir.
//
// NEDEN C FFI GEREKLI?
// ====================
// Semtech SX1302 konsantrator cipi icin resmi HAL (Hardware Abstraction Layer)
// ~15.000 satirlik C kodundan olusur. Bu kod su kritik islemleri yapar:
//
// 1. AGC (Automatic Gain Control) firmware yukleme — SX1302 icindeki DSP'ye
//    binary firmware blob'u SPI uzerinden yukler. Bu firmware demodulasyon
//    hassasiyetini kontrol eder.
//
// 2. PLL (Phase-Locked Loop) kalibrasyon — Her kanal icin frekans sentezleyici
//    kalibrasyonu yapar. Yanlis kalibrasyon paket kayiplarina yol acar.
//
// 3. 8-kanal esanli demodulasyon — SX1302, 8 farkli LoRa kanalinda ayni anda
//    48 paralel demodulasyon yapabilir. Bu, tek bir gateway ile 2000+ cihazi
//    desteklemeyi saglar.
//
// 4. Zaman damgasi senkronizasyonu — GPS PPS sinyali ile nanosaniye
//    hassasiyetinde zaman damgasi senkronizasyonu (Class B beacon icin zorunlu).
//
// Bu C kodunu Rust'a port etmek pratik degildir cunku:
// - Semtech'in firmware blob'lari binary formatindadir
// - Register haritasi NDA altindadir ve surekli guncellenir
// - Sertifikasyon (FCC/ETSI) mevcut C implementasyonuna baglidir
//
// Bu yuzden FFI ile C HAL'i sarmalliyoruz (wrap).

fn main() {
    #[cfg(feature = "lorawan")]
    build_sx1302_hal();
}

#[cfg(feature = "lorawan")]
fn build_sx1302_hal() {
    use std::env;
    use std::path::PathBuf;

    let vendor_dir = PathBuf::from("vendor/sx1302_hal");

    // =========================================================================
    // 1. ADIM: C kaynak dosyalarini derle
    // =========================================================================
    // Semtech HAL'inin libloragw dizinindeki tum .c dosyalarini derliyoruz.
    // cc crate'i, cross-compilation icin dogru C derleyiciyi otomatik secer
    // (ornegin aarch64-linux-gnu-gcc RPi4 icin).

    let loragw_src = vendor_dir.join("libloragw/src");
    let loragw_inc = vendor_dir.join("libloragw/inc");

    // libloragw C kaynaklarini topla
    let c_sources: Vec<PathBuf> = glob::glob(
        loragw_src
            .join("*.c")
            .to_str()
            .expect("vendor/sx1302_hal/libloragw/src/*.c yolu gecersiz"),
    )
    .expect("C kaynak dosyalari bulunamadi")
    .filter_map(|entry| entry.ok())
    .collect();

    if c_sources.is_empty() {
        // Vendor dizini henuz klonlanmamis — derleme uyarisi ver ama hata verme.
        // Bu, CI/CD ortaminda lorawan feature'i olmadan da derleme yapilabilmesini saglar.
        println!(
            "cargo:warning=SX1302 HAL kaynak dosyalari bulunamadi: {}",
            loragw_src.display()
        );
        println!(
            "cargo:warning=Gercek donanim destegi icin vendor/sx1302_hal dizinine \
             Semtech HAL'ini klonlayin."
        );
        println!("cargo:warning=Bkz: vendor/sx1302_hal/README.md");
        return;
    }

    // cc ile statik kutuphane olustur
    // SX1302 HAL, SPI uzerinden register okuma/yazma yapar.
    // -DLINUX flag'i, HAL'in Linux SPI aygit surucusunu (/dev/spidev*) kullanmasini saglar.
    let mut build = cc::Build::new();
    build
        .include(&loragw_inc)
        .define("LINUX", None)
        // Derleyici uyarilarini bastir — Semtech kodu eski C99 stili kullaniyor
        .flag_if_supported("-Wno-unused-parameter")
        .flag_if_supported("-Wno-sign-compare")
        .flag_if_supported("-Wno-pointer-sign");

    for source in &c_sources {
        build.file(source);
    }

    build.compile("loragw");

    // =========================================================================
    // 2. ADIM: bindgen ile Rust FFI binding uret
    // =========================================================================
    // bindgen, loragw_hal.h header dosyasindan otomatik olarak Rust FFI tanimlari uretir.
    // Bu sayede C struct'lari, enum'lari ve fonksiyon imzalari Rust tarafinda kullanilabilir.
    //
    // Onemli: Sadece lgw_* fonksiyonlarini allowlist'e aliyoruz. Tum HAL'i
    // export etmek gereksiz bagimlilik yaratir.

    let bindings = bindgen::Builder::default()
        .header(
            loragw_inc
                .join("loragw_hal.h")
                .to_str()
                .expect("Header yolu gecersiz"),
        )
        .clang_arg(format!("-I{}", loragw_inc.display()))
        // Sadece loragw public API'sini dahil et
        .allowlist_function("lgw_.*")
        .allowlist_type("lgw_.*")
        .allowlist_var("LGW_.*")
        // Rust enum olustur (C enum yerine)
        .rustified_enum("lgw_.*")
        // Dokumantasyon yorumlarini dahil et
        .generate_comments(true)
        .generate()
        .expect("bindgen FFI binding uretimi basarisiz");

    // Binding dosyasini OUT_DIR'e yaz
    let out_path = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR tanimli degil"));
    bindings
        .write_to_file(out_path.join("sx1302_bindings.rs"))
        .expect("FFI binding dosyasi yazilamadi");

    // =========================================================================
    // 3. ADIM: Cargo'ya yeniden derleme kosullarini bildir
    // =========================================================================
    // Vendor dizinindeki herhangi bir dosya degistiginde yeniden derle.
    println!("cargo:rerun-if-changed=vendor/sx1302_hal/");
}
