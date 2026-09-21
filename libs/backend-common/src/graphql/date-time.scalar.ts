/**
 * DateTime scalar — TypeORM `date` kolonları için SSoT serileştirme.
 *
 * WHY (2026-09-21 canlı olay): `@Column({ type: 'date' })` kolonları
 * TypeORM'dan `'YYYY-MM-DD'` DİZGESİ olarak döner. @nestjs/graphql'in
 * GraphQLISODateTime'i `serialize`'te Date olmayan her şeye null döndürüyor
 * (`value instanceof Date ? toISOString : null`) — alan non-null olduğunda
 * TÜM sorgu (`batches`, `harvestPlans`, …) INTERNAL_SERVER_ERROR ile
 * çöküyordu. İlk müdahale 26 entity dosyasına `@Field(() => String)`
 * serpiştirmekti — her yeni date kolonunda unutulacak dağınık bir yamaydı.
 *
 * SSoT çözüm (bu dosya): scalar ÖRNEĞİNİN serialize/parseValue'ini tek
 * noktadan sarmalıyoruz. @Scalar('DateTime') ile ikinci tip kaydetmek
 * federasyon şemasında "multiple types named DateTime" verdiği için örnek
 * düzeyinde sarmalama seçildi. `installDateOnlyDateTimeScalar()` servisin
 * app.module'ünde BİR KEZ, modül init'ten (şema kurulumundan) önce çağrılır.
 *
 * Wire format: date kolonları 'YYYY-MM-DD' döner (önceki String yamasıyla
 * birebir); timestamptz ISO kalır.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(__filename);

interface PatchableScalar {
  serialize: (value: unknown) => unknown;
  parseValue: (value: unknown) => unknown;
}

let installed = false;

function patchInstance(instance: PatchableScalar | undefined, source: string): boolean {
  if (!instance || typeof instance.serialize !== 'function') return false;
  const originalSerialize = instance.serialize.bind(instance);
  const originalParseValue = instance.parseValue.bind(instance);
  instance.serialize = (value: unknown): unknown => {
    if (typeof value === 'string' && value.length > 0) {
      // DATE kolonları: 'YYYY-MM-DD' olduğu gibi; ISO datetime zaten string.
      return value;
    }
    return originalSerialize(value);
  };
  instance.parseValue = (value: unknown): unknown => {
    // Tarih-sadece girdiler artık reddedilmiyor — '2027-04-01' gibi.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Date(`${value}T00:00:00.000Z`);
    }
    return originalParseValue(value);
  };
  return true;
}

export function installDateOnlyDateTimeScalar(): void {
  if (installed) return;
  installed = true;

  const patched: string[] = [];

  // @nestjs/graphql'in kendi singleton'u (TypeMapper'ın kullandığı gerçek
  // örnek — paket kök index'inden dışa açılmadığı için derin modül yolu).
  try {
    // Paketin exports haritası derin require'u (ERR_PACKAGE_PATH_NOT_EXPORTED)
    // engelliyor — createRequire + mutlak yol bu kısıtı aşar ve TypeMapper'ın
    // kullandığı gerçek singleton'a ulaşır.
    const path = nodeRequire('path') as typeof import('path');
    const pkgEntry = nodeRequire.resolve('@nestjs/graphql') as string;
    const scalarsModulePath = path.join(path.dirname(pkgEntry), 'scalars');
    const nestScalars = nodeRequire(scalarsModulePath) as Record<string, unknown>;
    if (patchInstance(nestScalars.GraphQLISODateTime as PatchableScalar | undefined, 'nestjs')) {
      patched.push('@nestjs/graphql GraphQLISODateTime');
    }
  } catch (error) {
    // Bulunamazsa graphql-scalars'a düş; ikisi de yoksa aşağıda fırlatılır.
    void error;
  }

  // graphql-scalars örneği (bazı modüller doğrudan bunu kaydediyor).
  try {
    const gs = nodeRequire('graphql-scalars') as Record<string, unknown>;
    if (patchInstance(gs.GraphQLDateTime as PatchableScalar | undefined, 'graphql-scalars')) {
      patched.push('graphql-scalars GraphQLDateTime');
    }
  } catch {
    // bağımlılık yok — sessiz geç
  }

  if (patched.length === 0) {
    // Kurulum boşa gitmesin — çağıran taraf loglayabilsin.
    throw new Error('installDateOnlyDateTimeScalar: hiçbir DateTime scalar örneği bulunamadı');
  }
}
