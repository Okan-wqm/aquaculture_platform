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
/// `#[must_use]` (PR935-LOW-007): bir Tier-1 sinir tipinin sonucu sessizce
/// dusurulemez — kabul/red kararini cagiran taraf ele almalidir.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueOutcome {
    /// Giris kabul edildi, hicbir sey cikarilmadi.
    Accepted,
    /// Giris kabul edildi ancak bir sinir doldugundan daha DUSUK degerli bir
    /// bekleyen downlink cikarildi (PR935-MEDIUM-004: en eski degil, en az
    /// onemli — onaylanmamis + dusuk oncelikli + eski oncelikle cikarilir).
    AcceptedEvictedLowerValue,
    /// Giris reddedildi — hedef DevAddr derinligi dolu VE yeni gelen, o
    /// DevAddr icin bekleyenlerden daha degerli degil.
    RejectedDevAddrFull,
    /// Giris reddedildi — global kuyruk dolu VE yeni gelen, kuyruktaki en az
    /// degerli girisden daha degerli degil (kendisi en degersiz).
    RejectedQueueFull,
}

/// Bir girisin "cikarilabilirlik" anahtari — BUYUK = daha cikarilabilir (daha
/// az degerli). Sirasiyla: onaylanmamis > onaylanmis, dusuk oncelik (yuksek
/// sayi) > yuksek oncelik, eski > yeni. `enqueue` bu anahtari maksimize eden
/// girisi cikarir; yeni gelen bu anahtardan kucuk (daha degerli) degilse
/// reddedilir. Yeni gelenin yasi sifir (`Duration::ZERO`) kabul edilir.
fn evictability(confirmed: bool, priority: u8, age: Duration) -> (u8, u8, Duration) {
    // confirmed=false → 1 (daha cikarilabilir); confirmed=true → 0.
    let unconfirmed_rank = u8::from(!confirmed);
    (unconfirmed_rank, priority, age)
}

impl EnqueueOutcome {
    /// Giris kuyruga alindiysa `true` (kabul veya kabul+cikar).
    pub fn accepted(self) -> bool {
        matches!(self, Self::Accepted | Self::AcceptedEvictedLowerValue)
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
    /// Sinir uygulama sirasi (PR935-MEDIUM-004 — oncelik/onay-farkindalikli):
    /// 1. TTL suresi dolmus girisleri buda,
    /// 2. hedef DevAddr derinligi doluysa: o DevAddr icin EN AZ DEGERLI girisi
    ///    bul; yeni gelen ondan daha degerliyse onu cikar, degilse reddet,
    /// 3. global sinir doluysa: kuyruktaki EN AZ DEGERLI girisi bul; yeni gelen
    ///    ondan daha degerliyse onu cikar, degilse (kendisi en degersizse) reddet,
    /// 4. girisi ekle.
    ///
    /// Boylece dusuk oncelikli/onaylanmamis bir telemetri-ack'i, baska bir
    /// cihazin bekleyen ONAYLANMIS aktuator komutunu ASLA cikarmaz.
    pub fn enqueue_at(&mut self, item: DownlinkItem, now: Instant) -> EnqueueOutcome {
        self.prune_expired(now);

        let dev_addr = item.dev_addr;
        let newcomer_ev = evictability(item.confirmed, item.priority, Duration::ZERO);

        // Bir alt kume (predicate ile) icindeki en cikarilabilir girisin
        // (index, anahtar) ciftini bulur. Kume bos ise None.
        let worst_in = |queue: &VecDeque<Queued>,
                        pred: &dyn Fn(&Queued) -> bool|
         -> Option<(usize, (u8, u8, Duration))> {
            queue
                .iter()
                .enumerate()
                .filter(|(_, q)| pred(q))
                .map(|(i, q)| {
                    (
                        i,
                        evictability(q.item.confirmed, q.item.priority, now.duration_since(q.enqueued_at)),
                    )
                })
                .max_by(|a, b| a.1.cmp(&b.1))
        };

        // Karsilastirma (onay, oncelik) uzerinden; yas yalnizca mevcutlar
        // arasinda en kotuyu secmede kullanilir (esitlerde en eski).
        let newcomer_value = (newcomer_ev.0, newcomer_ev.1);
        let value_of = |worst_ev: (u8, u8, Duration)| (worst_ev.0, worst_ev.1);

        // 2) DevAddr derinlik siniri — noisy-neighbor korumasi. Esit degerde
        // "reject-newest" korunur (`<`): tek cihaz kuyrugunu churn'lemesin.
        // Yalnizca KESIN daha degerli bir yeni gelen, en degersizi cikarir.
        let per_dev_addr = self
            .queue
            .iter()
            .filter(|q| q.item.dev_addr == dev_addr)
            .count();
        if per_dev_addr >= self.max_per_dev_addr {
            match worst_in(&self.queue, &|q| q.item.dev_addr == dev_addr) {
                Some((idx, worst_ev)) if newcomer_value < value_of(worst_ev) => {
                    self.queue.remove(idx);
                    self.queue.push_back(Queued { enqueued_at: now, item });
                    return EnqueueOutcome::AcceptedEvictedLowerValue;
                }
                _ => return EnqueueOutcome::RejectedDevAddrFull,
            }
        }

        // 3) Global sert sinir — esit degerde "evict-oldest" korunur (`<=`):
        // en taze komut kazanir. Yeni gelen KESIN en degersizse reddedilir.
        if self.queue.len() >= self.max_total {
            match worst_in(&self.queue, &|_| true) {
                Some((idx, worst_ev)) if newcomer_value <= value_of(worst_ev) => {
                    self.queue.remove(idx);
                    self.queue.push_back(Queued { enqueued_at: now, item });
                    return EnqueueOutcome::AcceptedEvictedLowerValue;
                }
                _ => return EnqueueOutcome::RejectedQueueFull,
            }
        }

        self.queue.push_back(Queued {
            enqueued_at: now,
            item,
        });
        EnqueueOutcome::Accepted
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

    fn item_pc(dev_addr: [u8; 4], marker: u8, priority: u8, confirmed: bool) -> DownlinkItem {
        DownlinkItem {
            dev_addr: DevAddr(dev_addr),
            payload: vec![marker],
            f_port: 1,
            confirmed,
            priority,
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
        // 4. giris global siniri asar — esit oncelik/onay durumunda en eski
        // (marker 0) cikarilir (yas tiebreak).
        assert_eq!(
            q.enqueue(item([0, 0, 0, 9], 9)),
            EnqueueOutcome::AcceptedEvictedLowerValue
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
        let _ = q.enqueue(item(addr, 10));
        let _ = q.enqueue(item(addr, 20));
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
        let _ = q.enqueue(item([0, 0, 0, 1], 0));
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

    // ---- PR935-MEDIUM-004: oncelik/onay-farkindalikli tahliye ----

    #[test]
    fn global_overflow_evicts_least_valuable_not_oldest() {
        // Kuyruk: [confirmed hi-pri (eski), unconfirmed lo-pri (yeni)]. Global
        // sinir dolunca gelen yeni bir orta-degerli giris, EN ESKIyi degil, en
        // az degerli olani (unconfirmed lo-pri) cikarmali.
        let mut q = BoundedDownlinkQueue::with_limits(2, 100, DEFAULT_DOWNLINK_TTL);
        // dev A: onaylanmis, yuksek oncelik (0) — degerli, EN ESKI.
        assert_eq!(
            q.enqueue(item_pc([0, 0, 0, 1], 1, 0, true)),
            EnqueueOutcome::Accepted
        );
        // dev B: onaylanmamis, dusuk oncelik (9) — en az degerli.
        assert_eq!(
            q.enqueue(item_pc([0, 0, 0, 2], 2, 9, false)),
            EnqueueOutcome::Accepted
        );
        // Yeni: dev C, onaylanmamis, orta oncelik (5). Global sinir dolu.
        assert_eq!(
            q.enqueue(item_pc([0, 0, 0, 3], 3, 5, false)),
            EnqueueOutcome::AcceptedEvictedLowerValue
        );
        // Onaylanmis-degerli (dev A, en eski) HALA kuyrukta — cikarilmadi.
        assert_eq!(
            q.take_for_dev_addr(&DevAddr([0, 0, 0, 1])).unwrap().payload,
            vec![1]
        );
        // En az degerli (dev B) cikarilmis.
        assert!(q.take_for_dev_addr(&DevAddr([0, 0, 0, 2])).is_none());
    }

    #[test]
    fn global_overflow_rejects_newcomer_when_it_is_the_worst() {
        // Kuyruk tamamen degerli girislerle dolu; gelen en degersizse
        // reddedilir (mevcut daha degerli bir sey cikarilmaz).
        let mut q = BoundedDownlinkQueue::with_limits(2, 100, DEFAULT_DOWNLINK_TTL);
        assert_eq!(
            q.enqueue(item_pc([0, 0, 0, 1], 1, 0, true)),
            EnqueueOutcome::Accepted
        );
        assert_eq!(
            q.enqueue(item_pc([0, 0, 0, 2], 2, 0, true)),
            EnqueueOutcome::Accepted
        );
        // Gelen: onaylanmamis, en dusuk oncelik → en degersiz → reddet.
        assert_eq!(
            q.enqueue(item_pc([0, 0, 0, 3], 3, 9, false)),
            EnqueueOutcome::RejectedQueueFull
        );
        assert_eq!(q.len(), 2);
    }

    #[test]
    fn per_dev_addr_cap_evicts_stale_for_a_more_valuable_newcomer() {
        // Bir DevAddr icin derinlik sinirini onaylanmamis dusuk-oncelikli
        // girislerle doldur; sonra ayni DevAddr icin ONAYLANMIS yuksek-oncelikli
        // bir komut gelsin — reddedilmemeli, en degersiz olani cikarmali.
        let mut q = BoundedDownlinkQueue::with_limits(100, 2, DEFAULT_DOWNLINK_TTL);
        let a = [0, 0, 0, 7];
        assert_eq!(
            q.enqueue(item_pc(a, 1, 9, false)),
            EnqueueOutcome::Accepted
        );
        assert_eq!(
            q.enqueue(item_pc(a, 2, 9, false)),
            EnqueueOutcome::Accepted
        );
        // Kritik komut: onaylanmis, en yuksek oncelik (0).
        assert_eq!(
            q.enqueue(item_pc(a, 3, 0, true)),
            EnqueueOutcome::AcceptedEvictedLowerValue
        );
        // Kritik komut kuyrukta olmali (ilk take FIFO ama esdeger degil —
        // en az iki giris var; kritik olanin var oldugunu dogrula).
        let mut found_critical = false;
        while let Some(it) = q.take_for_dev_addr(&DevAddr(a)) {
            if it.payload == vec![3] && it.confirmed && it.priority == 0 {
                found_critical = true;
            }
        }
        assert!(found_critical, "kritik onaylanmis komut cikarilmis olmamali");
    }
}
