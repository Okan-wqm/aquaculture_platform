# Security Module

Kapsamlı güvenlik modülü - SOLID prensiplerine uygun, enterprise-grade güvenlik özellikleri.

## Özellikler

### 1. Rate Limiting (Throttler)

Sliding window algoritması kullanan, dağıtık sistemlerde çalışabilen rate limiting.

```typescript
import { ThrottlerModule, ThrottlerGuard, Throttle, ThrottleDefaults } from '@platform/backend-common';

// Module import
@Module({
  imports: [ThrottlerModule],
})
export class AppModule {}

// Controller'da kullanım
@Controller('api')
@UseGuards(ThrottlerGuard)
export class ApiController {
  // Özel limit
  @Throttle({ limit: 10, ttl: 60 })
  @Post('action')
  doAction() {}

  // Login için özel limit (IP bazlı)
  @Throttle(ThrottleDefaults.LOGIN)
  @Post('login')
  login() {}
}
```

**Varsayılan Limitler:**
- API: 100 istek/dakika
- Login: 5 deneme/15 dakika (IP bazlı)
- Kayıt: 3 kayıt/saat (IP bazlı)
- Şifre sıfırlama: 3 deneme/saat

### 2. Token Blacklist (Access Token İptali)

JWT token'larını iptal etmek için blacklist sistemi.

```typescript
import { TokenBlacklistModule, TOKEN_BLACKLIST, ITokenBlacklist } from '@platform/backend-common';

@Injectable()
export class AuthService {
  constructor(
    @Inject(TOKEN_BLACKLIST) private readonly blacklist: ITokenBlacklist,
  ) {}

  async logout(jti: string, expiresAt: Date) {
    await this.blacklist.add(jti, expiresAt, 'user_logout');
  }

  async validateToken(jti: string): Promise<boolean> {
    return !(await this.blacklist.isBlacklisted(jti));
  }
}
```

### 3. Session Manager (Eşzamanlı Oturum Kontrolü)

Kullanıcı başına maksimum oturum sayısı kontrolü.

```typescript
import { SessionManagerModule, SESSION_MANAGER, ISessionManager } from '@platform/backend-common';

@Injectable()
export class AuthService {
  constructor(
    @Inject(SESSION_MANAGER) private readonly sessionManager: ISessionManager,
  ) {}

  async login(userId: string, metadata: SessionMetadata) {
    // Eski oturumları otomatik kapat
    await this.sessionManager.enforceSessionLimit(userId, 5);

    // Yeni oturum oluştur
    const sessionId = await this.sessionManager.createSession(userId, metadata);
    return sessionId;
  }

  async getUserSessions(userId: string) {
    return this.sessionManager.getUserSessions(userId);
  }
}
```

### 4. Timing Attack Koruması

Zamanlama saldırılarını önlemek için constant-time operasyonlar.

```typescript
import { TimingSafeService } from '@platform/backend-common';

@Injectable()
export class AuthService {
  constructor(private readonly timingSafe: TimingSafeService) {}

  async verifyToken(provided: string, stored: string): Promise<boolean> {
    // Constant-time karşılaştırma
    return this.timingSafe.compare(provided, stored);
  }

  async login(password: string): Promise<AuthPayload> {
    const startTime = Date.now();

    try {
      // Login işlemi...
    } finally {
      // Her zaman en az 200ms sürmesini garantile
      await this.timingSafe.ensureMinDuration(startTime, 200);
    }
  }
}
```

### 5. IP Validation (X-Forwarded-For)

Proxy arkasındaki gerçek client IP'sini güvenli şekilde tespit etme.

```typescript
import { IpValidatorService, IP_VALIDATOR, IIpValidator } from '@platform/backend-common';

@Injectable()
export class RateLimitService {
  constructor(
    @Inject(IP_VALIDATOR) private readonly ipValidator: IIpValidator,
  ) {}

  getClientIp(request: Request): string {
    return this.ipValidator.extractClientIp({
      ip: request.ip,
      headers: request.headers,
      connection: request.connection,
    });
  }
}
```

**Desteklenen Header'lar:**
1. CF-Connecting-IP (Cloudflare)
2. True-Client-IP (Akamai)
3. X-Real-IP (nginx)
4. X-Forwarded-For

### 6. GDPR Compliance

Veri koruma hakları için kapsamlı GDPR uyumluluk modülü.

```typescript
import { GDPR_SERVICE, IGdprService, CONSENT_MANAGER, IConsentManager } from '@platform/backend-common';
import { GdprModule } from '@platform/backend-common/gdpr';

@Injectable()
export class PrivacyService {
  constructor(
    @Inject(GDPR_SERVICE) private readonly gdprService: IGdprService,
    @Inject(CONSENT_MANAGER) private readonly consentManager: IConsentManager,
  ) {}

  // Veri erişim hakkı (Article 15)
  async exportUserData(userId: string) {
    return this.gdprService.exportUserData(userId, 'json');
  }

  // Silme hakkı (Article 17)
  async deleteUserData(userId: string) {
    return this.gdprService.deleteUserData(userId);
  }

  // Onay yönetimi
  async recordConsent(userId: string, type: ConsentType, granted: boolean) {
    return this.consentManager.recordConsent({
      userId,
      consentType: type,
      granted,
      version: '2.0.0',
    });
  }

  // Onay kontrolü
  async hasConsent(userId: string, type: ConsentType): Promise<boolean> {
    return this.consentManager.hasConsent(userId, type);
  }
}
```

### 7. Input Validation

ReDoS-safe regex patterns ve güvenli input validasyonu.

```typescript
import {
  SecureMaxLength,
  SecureMinLength,
  IsSafeEmail,
  IsSafeUuid,
  IsStrongPassword,
  NoHtmlTags,
  NoSqlInjection,
  IsSqlIdentifier,
} from '@platform/backend-common';

export class CreateUserDto {
  @IsSafeEmail()
  @SecureMaxLength(254)
  email: string;

  @IsStrongPassword()
  @SecureMinLength(8)
  @SecureMaxLength(128)
  password: string;

  @NoHtmlTags()
  @SecureMaxLength(100)
  firstName: string;

  @IsSafeUuid()
  tenantId: string;
}
```

### 8. Input Sanitization

XSS, SQL Injection ve diğer injection saldırılarına karşı koruma.

```typescript
import { InputSanitizerService } from '@platform/backend-common';

@Injectable()
export class ContentService {
  constructor(private readonly sanitizer: InputSanitizerService) {}

  processContent(content: string): string {
    // HTML escape
    const escaped = this.sanitizer.escapeHtml(content);

    // Path traversal koruması
    const safePath = this.sanitizer.sanitizePath(content);

    // SQL identifier doğrulama
    const safeIdentifier = this.sanitizer.sanitizeSqlIdentifier(content);

    return escaped;
  }

  // Deep sanitization
  sanitizeObject(data: Record<string, unknown>) {
    return this.sanitizer.deepSanitize(data, {
      escapeHtml: true,
      removeNullBytes: true,
      maxStringLength: 10000,
    });
  }
}
```

## Konfigürasyon

### Environment Variables

```env
# Rate Limiting
THROTTLE_ENABLED=true
THROTTLE_DEFAULT_LIMIT=100
THROTTLE_DEFAULT_TTL=60
THROTTLE_ANONYMOUS_LIMIT=20
RATE_LIMIT_USE_REDIS=true

# Token Blacklist
TOKEN_BLACKLIST_USE_REDIS=true

# Session Management
MAX_SESSIONS_PER_USER=5
SESSION_TTL_MS=86400000
SESSION_USE_REDIS=true

# Refresh Tokens
HASH_REFRESH_TOKENS=true
REFRESH_TOKEN_EXPIRY_DAYS=7

# Timing Attack Protection
MIN_LOGIN_DURATION_MS=200

# IP Validation
TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12
IP_WHITELIST=127.0.0.1,::1
```

## Module Import

```typescript
import { SecurityModule, ThrottlerGuard, RolesGuard } from '@platform/backend-common';
import { GdprModule } from '@platform/backend-common/gdpr';

@Module({
  imports: [
    SecurityModule,
    GdprModule, // Requires TypeORM entities
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
```

## SOLID Principles

Bu modül SOLID prensiplerine uygun olarak tasarlanmıştır:

- **Single Responsibility**: Her servis tek bir göreve odaklıdır
- **Open/Closed**: Decorator'lar ile genişletilebilir, değişiklik gerektirmez
- **Liskov Substitution**: Tüm implementasyonlar interface'lerini tam olarak karşılar
- **Interface Segregation**: Küçük, özelleşmiş interface'ler
- **Dependency Inversion**: Concrete sınıflar yerine interface'lere bağımlılık

## Security Best Practices

1. **Generic Error Messages**: User enumeration saldırılarını önler
2. **Timing-Safe Operations**: Zamanlama saldırılarına karşı koruma
3. **Rate Limiting**: Brute-force saldırılarını önler
4. **Token Blacklisting**: Çalınan token'ların iptal edilmesini sağlar
5. **Session Limits**: Account takeover riskini azaltır
6. **Input Validation**: Injection saldırılarını önler
7. **ReDoS-Safe Regex**: DoS saldırılarını önler
