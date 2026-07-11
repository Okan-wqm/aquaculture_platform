//! Sinirli (bounded) LoRaWAN downlink kuyrugu
//!
//! Class A cihazlara downlink yalnizca bir uplink sonrasi RX1/RX2
//! pencerelerinde gonderilebilir. Bir cihaz aylarca uplink gondermezse,
//! ona adreslenen downlink'ler suresiz birikir. Duz bir `VecDeque` bu
//! birikimi hicbir sekilde sinirlamaz — aylar boyunca calisan bir edge
//! agent'inda bu, sinirsiz bellek buyumesine (OOM) yol acar.
//!
//! Bu modul, sinirsiz buyumeyi **yapisal olarak imkansiz** kilan bir tip
//! saglar (make-it-impossible, Tier-1). Kuyrugun tek erisim yolu bu tipin
//! metodlaridir; her `enqueue`:
//!
//! 1. TTL suresi dolmus girisleri budar (`DEFAULT_DOWNLINK_TTL`),
//! 2. hedef DevAddr icin derinlik sinirini uygular
//!    (`MAX_DOWNLINK_PER_DEV_ADDR`, en yeniyi reddet),
//! 3. global sert siniri uygular (`MAX_DOWNLINK_QUEUE`, en eskiyi cikar).
//!
//! Sinirlar tipe gomulu oldugundan, cagiran taraf `push_back`'e dogrudan
//! erisemez ve siniri atlayamaz. Zaman kaynagi metodlara `Instant` olarak
//! enjekte edilir; bu, budama/TTL davranisinin deterministik test
//! edilebilmesini saglar.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::mac::DownlinkItem;
use super::types::DevAddr;

/// Global sert kuyruk siniri — tum DevAddr'ler toplaminda en fazla bu kadar
/// downlink bekleyebilir. Asildiginda en eski giris cikarilir (evict-oldest).
///
/// 256 giris * (~256 byte payload + baglam) ~= birkac yuz KB — 2-cekirdekli
/// ARM edge donanimi icin ihmal edilebilir, ancak sinirsiz buyumeyi keser.
pub const MAX_DOWNLINK_QUEUE: usize = 256;

/// Tek bir DevAddr icin en fazla bekleyen downlink sayisi. Asildiginda yeni
/// gelen reddedilir (reject-newest) — tek bir cihaz kuyrugun tamamini
/// tuketemez (noisy-neighbor korumasi).
pub const MAX_DOWNLINK_PER_DEV_ADDR: usize = 8;

/// Bir downlink'in kuyrukta kalabilecegi azami sure. Bu sure gecince giris
/// bayat kabul edilir ve budanir. 24 saat: Class A cihazlar tipik olarak
/// gunde en az bir kez uplink gonderir; bundan uzun sureli bir downlink
/// muhtemelen artik alakasizdir.
pub const DEFAULT_DOWNLINK_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Kuyruga giris denemesinin sonucu.
///
/// Cagiran taraf bu sonucu telemetri/geri-basinc kararlari icin kullanir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueOutcome {
    /// Giris kabul edildi, hicbir sey cikarilmadi.
    Accepted,
    /// Giris kabul edildi ancak global sinir doldugundan en eski
    /// bekleyen downlink cikarildi.
    AcceptedEvictedOldest,
    /// Giris reddedildi — hedef DevAddr icin derinlik siniri dolu.
    RejectedDevAddrFull,
}

impl EnqueueOutcome {
    /// Giris kuyruga alindiysa `true` (kabul veya kabul+cikar).
    pub fn accepted(self) -> bool {
        matches!(self, Self::Accepted | Self::AcceptedEvictedOldest)
    }
}

/// Kuyruktaki tek bir bekleyen downlink — giris zamani ile birlikte.
///
/// Giris zamani TTL budamasi icin saklanir.
#[derive(Debug, Clone)]
struct Queued {
    enqueued_at: Instant,
    item: DownlinkItem,
}

/// Sinirli downlink kuyrugu.
///
/// Sinirsiz buyume yapisal olarak imkansizdir: ic `VecDeque` gizlidir ve
/// tek yazma yolu, her cagrida sinirlari uygulayan `enqueue`'dur.
#[derive(Debug)]
pub struct BoundedDownlinkQueue {
    queue: VecDeque<Queued>,
    max_total: usize,
    max_per_dev_addr: usize,
    ttl: Duration,
}

impl Default for BoundedDownlinkQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl BoundedDownlinkQueue {
    /// Varsayilan sinirlarla yeni bir kuyruk olusturur.
    pub fn new() -> Self {
        Self::with_limits(
            MAX_DOWNLINK_QUEUE,
            MAX_DOWNLINK_PER_DEV_ADDR,
            DEFAULT_DOWNLINK_TTL,
        )
    }

    /// Ozel sinirlarla yeni bir kuyruk olusturur.
    ///
    /// `max_total` ve `max_per_dev_addr` en az 1 olacak sekilde kelepcelenir;
    /// 0 sinir, hicbir downlink'in asla kuyruga alinamamasi anlamina gelir ki
    /// bu bir yapilandirma hatasidir, dolayisiyla en dusuk anlamli deger 1'dir.
    pub fn with_limits(max_total: usize, max_per_dev_addr: usize, ttl: Duration) -> Self {
        Self {
            queue: VecDeque::new(),
            max_total: max_total.max(1),
            max_per_dev_addr: max_per_dev_addr.max(1),
            ttl,
        }
    }

    /// Kuyruktaki toplam bekleyen downlink sayisi.
    pub fn len(&self) -> usize {
        self.queue.len()
    }

    /// Kuyruk bos mu?
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// Bir downlink'i kuyruga ekler (gercek zamanli).
    ///
    /// Sinirlari `Instant::now()` referans alarak uygular. Deterministik
    /// testler icin `enqueue_at` kullanin.
    pub fn enqueue(&mut self, item: DownlinkItem) -> EnqueueOutcome {
        self.enqueue_at(item, Instant::now())
    }

    /// `enqueue`'nun deterministik cekirdegi — zaman referansi enjekte edilir.
    ///
    /// Sinir uygulama sirasi:
    /// 1. TTL suresi dolmus girisleri buda,
    /// 2. hedef DevAddr derinligi doluysa reddet (reject-newest),
    /// 3. global sinir doluysa en eskiyi cikar (evict-oldest),
    /// 4. girisi ekle.
    pub fn enqueue_at(&mut self, item: DownlinkItem, now: Instant) -> EnqueueOutcome {
        self.prune_expired(now);

        let dev_addr = item.dev_addr;
        let per_dev_addr = self
            .queue
            .iter()
            .filter(|q| q.item.dev_addr == dev_addr)
            .count();
        if per_dev_addr >= self.max_per_dev_addr {
            return EnqueueOutcome::RejectedDevAddrFull;
        }

        let mut evicted = false;
        if self.queue.len() >= self.max_total {
            // En eski girisi cikar — global sert sinir asilamaz.
            self.queue.pop_front();
            evicted = true;
        }

        self.queue.push_back(Queued {
            enqueued_at: now,
            item,
        });

        if evicted {
            EnqueueOutcome::AcceptedEvictedOldest
        } else {
            EnqueueOutcome::Accepted
        }
    }

    /// Verilen DevAddr icin bekleyen ilk (FIFO) downlink'i cikarip dondurur.
    ///
    /// Cikarmadan once TTL suresi dolmus girisleri budar; boylece bayat bir
    /// downlink asla gonderilmez. Bekleyen yoksa `None` doner.
    pub fn take_for_dev_addr(&mut self, dev_addr: &DevAddr) -> Option<DownlinkItem> {
        self.take_for_dev_addr_at(dev_addr, Instant::now())
    }

    /// `take_for_dev_addr`'in deterministik cekirdegi — zaman enjekte edilir.
    pub fn take_for_dev_addr_at(
        &mut self,
        dev_addr: &DevAddr,
        now: Instant,
    ) -> Option<DownlinkItem> {
        self.prune_expired(now);

        let idx = self
            .queue
            .iter()
            .position(|q| q.item.dev_addr == *dev_addr)?;
        // idx az once ayni VecDeque uzerinde position() ile alindi ve
        // arada mutasyon olmadi; remove() daima Some doner. map ile
        // acilir — unwrap yok.
        self.queue.remove(idx).map(|q| q.item)
    }

    /// TTL suresi dolmus tum girisleri kuyruktan cikarir.
    ///
    /// Giris zamani `now`'dan `ttl`'den daha eski olan her giris budanir.
    /// `enqueue_at` ve `take_for_dev_addr_at` icinde otomatik cagrilir;
    /// ayrica periyodik bakim icin dogrudan cagrilabilir.
    pub fn prune_expired(&mut self, now: Instant) -> usize {
        let ttl = self.ttl;
        let before = self.queue.len();
        self.queue
            .retain(|q| now.duration_since(q.enqueued_at) < ttl);
        before - self.queue.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(dev_addr: [u8; 4], marker: u8) -> DownlinkItem {
        DownlinkItem {
            dev_addr: DevAddr(dev_addr),
            payload: vec![marker],
            f_port: 1,
            confirmed: false,
            priority: 0,
        }
    }

    #[test]
    fn accepts_within_limits() {
        let mut q = BoundedDownlinkQueue::new();
        assert_eq!(q.enqueue(item([0, 0, 0, 1], 1)), EnqueueOutcome::Accepted);
        assert_eq!(q.len(), 1);
        assert!(!q.is_empty());
    }

    #[test]
    fn per_dev_addr_cap_rejects_newest() {
        let mut q = BoundedDownlinkQueue::with_limits(256, 3, DEFAULT_DOWNLINK_TTL);
        let addr = [0, 0, 0, 7];
        for i in 0..3 {
            assert_eq!(q.enqueue(item(addr, i)), EnqueueOutcome::Accepted);
        }
        // 4. giris reddedilir — DevAddr derinligi dolu.
        assert_eq!(
            q.enqueue(item(addr, 99)),
            EnqueueOutcome::RejectedDevAddrFull
        );
        assert_eq!(q.len(), 3);
        // Reddedilen giris kuyruga girmemistir — ilk uc marker korunur.
        assert_eq!(
            q.take_for_dev_addr(&DevAddr(addr)).unwrap().payload,
            vec![0]
        );
    }

    #[test]
    fn per_dev_addr_cap_is_independent_across_addrs() {
        let mut q = BoundedDownlinkQueue::with_limits(256, 2, DEFAULT_DOWNLINK_TTL);
        let a = [0, 0, 0, 1];
        let b = [0, 0, 0, 2];
        assert!(q.enqueue(item(a, 0)).accepted());
        assert!(q.enqueue(item(a, 1)).accepted());
        assert_eq!(q.enqueue(item(a, 2)), EnqueueOutcome::RejectedDevAddrFull);
        // Farkli DevAddr, ayni siniri bagimsiz tasir.
        assert!(q.enqueue(item(b, 0)).accepted());
        assert!(q.enqueue(item(b, 1)).accepted());
        assert_eq!(q.enqueue(item(b, 2)), EnqueueOutcome::RejectedDevAddrFull);
    }

    #[test]
    fn global_cap_evicts_oldest() {
        // Global sinir 3, DevAddr sinirini yuksek tut ki global sinir tetiklensin.
        let mut q = BoundedDownlinkQueue::with_limits(3, 100, DEFAULT_DOWNLINK_TTL);
        for i in 0..3 {
            assert_eq!(q.enqueue(item([0, 0, 0, i], i)), EnqueueOutcome::Accepted);
        }
        assert_eq!(q.len(), 3);
        // 4. giris global siniri asar — en eski (marker 0) cikarilir.
        assert_eq!(
            q.enqueue(item([0, 0, 0, 9], 9)),
            EnqueueOutcome::AcceptedEvictedOldest
        );
        assert_eq!(q.len(), 3);
        // En eski DevAddr artik kuyrukta yok.
        assert!(q.take_for_dev_addr(&DevAddr([0, 0, 0, 0])).is_none());
        // En yeni giris mevcut.
        assert_eq!(
            q.take_for_dev_addr(&DevAddr([0, 0, 0, 9])).unwrap().payload,
            vec![9]
        );
    }

    #[test]
    fn take_returns_fifo_within_dev_addr() {
        let mut q = BoundedDownlinkQueue::new();
        let addr = [0, 0, 0, 5];
        q.enqueue(item(addr, 10));
        q.enqueue(item(addr, 20));
        assert_eq!(
            q.take_for_dev_addr(&DevAddr(addr)).unwrap().payload,
            vec![10]
        );
        assert_eq!(
            q.take_for_dev_addr(&DevAddr(addr)).unwrap().payload,
            vec![20]
        );
        assert!(q.take_for_dev_addr(&DevAddr(addr)).is_none());
    }

    #[test]
    fn take_missing_dev_addr_returns_none() {
        let mut q = BoundedDownlinkQueue::new();
        q.enqueue(item([0, 0, 0, 1], 0));
        assert!(q.take_for_dev_addr(&DevAddr([9, 9, 9, 9])).is_none());
    }

    #[test]
    fn ttl_prunes_stale_entries_on_enqueue() {
        let mut q = BoundedDownlinkQueue::with_limits(256, 8, Duration::from_secs(60));
        let t0 = Instant::now();
        q.enqueue_at(item([0, 0, 0, 1], 0), t0);
        assert_eq!(q.len(), 1);
        // 61 saniye sonra yeni bir giris — eski giris TTL ile budanir.
        let t1 = t0 + Duration::from_secs(61);
        q.enqueue_at(item([0, 0, 0, 2], 1), t1);
        assert_eq!(q.len(), 1);
        assert!(q.take_for_dev_addr(&DevAddr([0, 0, 0, 1])).is_none());
    }

    #[test]
    fn ttl_prunes_stale_entries_on_take() {
        let mut q = BoundedDownlinkQueue::with_limits(256, 8, Duration::from_secs(60));
        let t0 = Instant::now();
        q.enqueue_at(item([0, 0, 0, 1], 0), t0);
        let t1 = t0 + Duration::from_secs(61);
        // Alma zamaninda TTL dolmus — bayat downlink gonderilmez.
        assert!(q.take_for_dev_addr_at(&DevAddr([0, 0, 0, 1]), t1).is_none());
        assert_eq!(q.len(), 0);
    }

    #[test]
    fn prune_expired_reports_count() {
        let mut q = BoundedDownlinkQueue::with_limits(256, 8, Duration::from_secs(60));
        let t0 = Instant::now();
        q.enqueue_at(item([0, 0, 0, 1], 0), t0);
        q.enqueue_at(item([0, 0, 0, 2], 1), t0);
        let t1 = t0 + Duration::from_secs(61);
        assert_eq!(q.prune_expired(t1), 2);
        assert_eq!(q.len(), 0);
    }

    #[test]
    fn zero_limits_are_clamped_to_one() {
        let mut q = BoundedDownlinkQueue::with_limits(0, 0, DEFAULT_DOWNLINK_TTL);
        // Sinir 1'e kelepcelendi — en az bir giris kabul edilir.
        assert!(q.enqueue(item([0, 0, 0, 1], 0)).accepted());
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn unbounded_growth_is_structurally_impossible() {
        // Tek bir DevAddr'den binlerce downlink gelse bile kuyruk asla
        // global siniri asamaz.
        let mut q = BoundedDownlinkQueue::new();
        for i in 0..10_000u32 {
            let _ = q.enqueue(item([1, 2, 3, 4], (i % 256) as u8));
        }
        assert!(q.len() <= MAX_DOWNLINK_QUEUE);
        // Ayni DevAddr'in derinligi de per-addr siniri asamaz.
        assert!(q.len() <= MAX_DOWNLINK_PER_DEV_ADDR);
    }
}
