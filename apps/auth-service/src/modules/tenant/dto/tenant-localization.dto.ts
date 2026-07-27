import { Field, InputType, ObjectType } from '@nestjs/graphql';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Tenant lokalizasyonu — saat dilimi + dil (W5, kullanıcı kararı 3).
 *
 * Saat dilimi bir görünüm tercihi DEĞİLDİR: farm-service'in yemleme
 * cron'larının (plan üretimi, sabah süpürmesi, gün özeti, FCR ve kapsama
 * süpürmeleri) yerel gün sınırıdır. Bu yüzden `settings` jsonb'sinin içinde
 * tipsiz bir alan olarak değil, kendi tipli yüzeyiyle okunur/yazılır.
 */
@ObjectType()
export class TenantLocalizationSettings {
  /** IANA zon kimliği; hiç ayarlanmamışsa `UTC`. */
  @Field()
  timezone!: string;

  @Field(() => String, { nullable: true })
  locale!: string | null;
}

@InputType()
export class UpdateTenantLocalizationInput {
  /** IANA zon kimliği (örn. `Europe/Istanbul`) — sunucuda doğrulanır. */
  @Field()
  @IsString()
  @MaxLength(64)
  timezone!: string;

  /** BCP-47 dil etiketi (örn. `tr`, `en-GB`). */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}
