import {
  ObjectType,
  Field,
  ID,
  Int,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { EdgeDevice } from './edge-device.entity';
import { EncryptedColumnTransformer } from '../../infrastructure/vault/credential.transformer';

/**
 * LoRaWAN Activation Mode
 *
 * OTAA (Over-The-Air Activation): Cihaz, join request göndererek ağa katılır.
 * Network server, AppKey kullanarak session key'leri türetir. Daha güvenli,
 * endüstriyel ortamda tercih edilir.
 *
 * ABP (Activation By Personalization): Session key'ler cihaza önceden yüklenir.
 * Join prosedürü atlanır. Hızlı kurulum ama güvenlik açısından zayıf —
 * session key'ler hiç değişmez.
 */
export enum LoRaActivationMode {
  OTAA = 'OTAA',
  ABP = 'ABP',
}

registerEnumType(LoRaActivationMode, {
  name: 'LoRaActivationMode',
  description: 'LoRaWAN activation mode: OTAA (Over-The-Air) or ABP (Activation By Personalization)',
});

/**
 * LoRaWAN Device Class
 *
 * Class A: Varsayılan. Uplink sonrası iki kısa receive window açılır.
 *          En düşük güç tüketimi. Sensörler için ideal.
 *
 * Class B: Beacon senkronizasyonu ile zamanlanmış receive slot'ları.
 *          Orta güç tüketimi. Periyodik downlink gereken cihazlar için.
 *
 * Class C: Sürekli dinleme modu (TX dışında her zaman RX açık).
 *          En yüksek güç tüketimi. Aktüatörler ve kontrol cihazları için.
 *          Akvakültür vana/pompa kontrolünde Class C tercih edilir.
 */
export enum LoRaDeviceClass {
  A = 'A',
  B = 'B',
  C = 'C',
}

registerEnumType(LoRaDeviceClass, {
  name: 'LoRaDeviceClass',
  description: 'LoRaWAN device class: A (lowest power), B (beacon-synced), C (continuous RX)',
});

/**
 * LoRaDevice entity — LoRaWAN end-device'ı temsil eder.
 *
 * Her LoRa cihazı bir EdgeDevice'a bağlıdır (ManyToOne). EdgeDevice üzerindeki
 * Raspberry Pi + SX1302 HAT, LoRa gateway/concentrator rolünü üstlenir ve
 * bu tablodaki cihazlarla iletişim kurar.
 *
 * LoRaWAN Kavramları:
 * - DevEUI: Globally unique 64-bit cihaz tanımlayıcı (IEEE EUI-64)
 * - AppEUI/JoinEUI: Uygulama tanımlayıcı (OTAA join request'te kullanılır)
 * - AppKey: 128-bit root key (OTAA'da session key türetimi için)
 * - DevAddr: 32-bit ağ adresi (join-accept sonrası veya ABP'de statik)
 * - ADR: Adaptive Data Rate — ağ koşullarına göre SF/BW otomatik ayarı
 * - fPort: Uygulama katmanı port numarası (1-223 arası)
 * - Codec: Payload decode formatı (CayenneLPP, custom binary, vb.)
 */
@ObjectType()
@Entity('lora_devices')
@Index(['tenantId', 'edgeDeviceId'])
@Index(['devEui'], { unique: true })
export class LoRaDevice {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Edge Device relation — LoRa gateway olarak görev yapan Pi
  @Field()
  @Column({ name: 'edge_device_id' })
  edgeDeviceId!: string;

  @Field(() => EdgeDevice)
  @ManyToOne(() => EdgeDevice, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'edge_device_id' })
  edgeDevice!: EdgeDevice;

  // LoRaWAN Identity
  /** DevEUI: 16 hex karakter (8 byte). Cihazın globally unique tanımlayıcısı. */
  @Field()
  @Column({ name: 'dev_eui', type: 'varchar', length: 16 })
  devEui!: string;

  /** AppEUI/JoinEUI: OTAA aktivasyonu için gerekli. ABP'de opsiyonel. */
  @Field({ nullable: true })
  @Column({ name: 'app_eui', type: 'varchar', length: 16, nullable: true })
  appEui?: string;

  /**
   * AppKey: 128-bit root key. OTAA join prosedüründe session key türetimi için kullanılır.
   * AES-256-GCM ile uygulama katmanında şifrelenerek saklanır (EncryptedColumnTransformer).
   * Format: enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>
   */
  @Column({ name: 'app_key', type: 'varchar', length: 255, transformer: EncryptedColumnTransformer })
  appKey!: string;

  /** Maskelenmiş AppKey — GraphQL'den güvenli erişim için ilk 4 ve son 4 karakter gösterilir */
  @Field({ description: 'Masked application key (first 4 + last 4 chars)' })
  get appKeyMasked(): string {
    if (!this.appKey) return '';
    return `${this.appKey.slice(0, 4)}${'*'.repeat(24)}${this.appKey.slice(-4)}`;
  }

  /** DevAddr: Join-accept sonrası atanan veya ABP'de statik olarak yapılandırılan ağ adresi. */
  @Field({ nullable: true })
  @Column({ name: 'dev_addr', type: 'varchar', length: 8, nullable: true })
  devAddr?: string;

  // Activation & Class
  @Field(() => LoRaActivationMode)
  @Column({ name: 'activation_mode', type: 'enum', enum: LoRaActivationMode, default: LoRaActivationMode.OTAA })
  activationMode!: LoRaActivationMode;

  @Field(() => LoRaDeviceClass)
  @Column({ name: 'device_class', type: 'enum', enum: LoRaDeviceClass, default: LoRaDeviceClass.A })
  deviceClass!: LoRaDeviceClass;

  // User-friendly fields
  @Field()
  @Column({ type: 'varchar', length: 50 })
  name!: string;

  /**
   * tagPrefix: I/O tag isimlendirme ön eki. Edge agent, bu prefix ile
   * LoRa cihazından gelen decoded değerleri tag olarak publish eder.
   * Ör: tagPrefix="LORA_PH" → "LORA_PH_temperature", "LORA_PH_humidity"
   */
  @Field()
  @Column({ name: 'tag_prefix', type: 'varchar', length: 30 })
  tagPrefix!: string;

  /**
   * Codec: Payload decode formatı.
   * - cayenne_lpp: Standart CayenneLPP (IPSO Smart Objects tabanlı)
   * - raw: Ham byte dizisi, decode edge agent'ta custom handler ile yapılır
   * - json: JSON payload (nadir, genellikle Class C cihazlarda)
   */
  @Field()
  @Column({ type: 'varchar', length: 20, default: 'cayenne_lpp' })
  codec!: string;

  // Radio parameters
  /** ADR: Adaptive Data Rate. LoRa ağ sunucusu SF ve BW'yi otomatik optimize eder. */
  @Field()
  @Column({ name: 'adr_enabled', default: true })
  adrEnabled!: boolean;

  /** fPort: LoRaWAN uygulama katmanı port numarası. Farklı payload tipleri için ayrılabilir. */
  @Field(() => Int)
  @Column({ name: 'f_port', type: 'smallint', default: 1 })
  fPort!: number;

  // Runtime status — edge agent tarafından güncellenir
  @Field({ nullable: true })
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt?: Date;

  /** RSSI (Received Signal Strength Indicator): Alınan sinyal gücü (dBm). Tipik: -120 ile -30 arası. */
  @Field(() => Float, { nullable: true })
  @Column({ name: 'last_rssi', type: 'real', nullable: true })
  lastRssi?: number;

  /** SNR (Signal-to-Noise Ratio): Sinyal/gürültü oranı (dB). Pozitif değerler iyi bağlantı gösterir. */
  @Field(() => Float, { nullable: true })
  @Column({ name: 'last_snr', type: 'real', nullable: true })
  lastSnr?: number;

  /** Uplink frame counter. LoRaWAN güvenliği için her uplink'te artırılır. Replay attack koruması sağlar. */
  @Field(() => Int, { nullable: true })
  @Column({ name: 'frame_count_up', type: 'int', nullable: true })
  frameCountUp?: number;

  /** Join durumu: OTAA ile başarılı join-accept alındıysa true. */
  @Field()
  @Column({ name: 'is_joined', default: false })
  isJoined!: boolean;

  @Field({ nullable: true })
  @Column({ name: 'joined_at', type: 'timestamptz', nullable: true })
  joinedAt?: Date;

  // Tenant isolation
  @Field()
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  // Timestamps
  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
