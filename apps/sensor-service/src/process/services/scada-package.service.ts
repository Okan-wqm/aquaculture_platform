import { createHash, randomUUID, timingSafeEqual } from 'crypto';

import { Injectable, Logger, NotFoundException, BadRequestException, Inject, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  SCADA_PACKAGE_PUBLISHED,
  SCADA_PACKAGE_ARCHIVED,
  type ScadaPackageLifecycleEvent,
} from '../../scada-runtime/services/scada-activation.events';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike, In, Not, QueryFailedError } from 'typeorm';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import {
  transformScadaDocForEdgeDeploy,
  upcastScadaPackageDoc,
  type EdgeDeployWidgetRef,
  type ScadaPackageDocV2,
} from '@platform/sensor-contracts';
import {
  formatValidationErrors,
  validateCommandEnvelope,
  validateDeployScadaPackageParams,
  validateEdgeScadaPackageDoc,
  validateScadaPackageDocV2,
  validateUndeployScadaPackageParams,
} from '@platform/sensor-contracts/validators';

import { AutomationService } from '../../automation/automation.service';
import { AutomationProgram, ProgramStatus } from '../../automation/entities/automation-program.entity';
import { ProgramVariable } from '../../automation/entities/program-variable.entity';
import { ArtifactService, canonicalJsonStringify } from '../../deploy-artifact/artifact.service';
import { DeploySigningService } from '../../deploy-artifact/deploy-signing.service';
import { DeployArtifactType } from '../../deploy-artifact/entities/deploy-artifact.entity';
import { EdgeDeviceService } from '../../edge-device/edge-device.service';
import {
  ReleaseBundleArtifactRef,
  ReleaseBundleManifest,
} from '../../release-bundle/entities/release-bundle.entity';
import { ReleaseBundleService } from '../../release-bundle/release-bundle.service';
import { MqttClientService } from '../../shared-mqtt/mqtt-client.service';

import {
  CreateScadaPackageInput,
  UpdateScadaPackageInput,
  ScadaPackageFilterInput,
} from '../dto/scada-package.dto';
import { ProcessPaginationInput } from '../dto/process.dto';
import { Process } from '../entities/process.entity';
import { ScadaPackage, ScadaPackageStatus } from '../entities/scada-package.entity';
import { ScadaDeployLog, ScadaDeployStatus } from '../entities/scada-deploy-log.entity';
import { ScadaDeployLogService } from './scada-deploy-log.service';
import { TagResolutionService } from './tag-resolution.service';
import { hashPin, isPinHash, verifyPin } from './pin-hash.util';

@Injectable()
export class ScadaPackageService {
  private readonly logger = new Logger(ScadaPackageService.name);

  /** Max packageData size: 1 MB */
  private static readonly MAX_PACKAGE_DATA_BYTES = 1_048_576;

  /** Max source size of a single SCADA script (`code` field): 64 KiB. */
  private static readonly MAX_SCRIPT_CODE_BYTES = 65_536;

  /** Max number of scripts a single package may carry. */
  private static readonly MAX_SCRIPTS_PER_PACKAGE = 50;

  /**
   * Max number of SERVER-mode scripts a single package may carry. Server
   * scripts execute on the cloud runtime (scheduler + sandbox slots per
   * active tenant), so their count is bounded separately from the total.
   */
  private static readonly MAX_SERVER_SCRIPTS_PER_PACKAGE = 50;

  /** Modes a stored script may declare. */
  private static readonly VALID_SCRIPT_MODES = new Set(['server', 'client']);

  /** Minimum PIN length accepted at the set/hash boundary (M3 policy). */
  private static readonly PIN_MIN_LENGTH = 6;

  /**
   * Legacy plaintext PIN acceptance ends here. Far-future by design: legacy
   * rows are migrated opportunistically (verify-then-rehash on first
   * successful verification), so the cutoff only refuses rows whose tenant
   * NEVER re-verified — flip it down once telemetry says the legacy set is
   * empty.
   */
  private static readonly LEGACY_PIN_CUTOFF = new Date('2030-01-01T00:00:00.000Z');

  private validatePackageDataSize(data: Record<string, unknown>): void {
    const size = Buffer.byteLength(JSON.stringify(data), 'utf8');
    if (size > ScadaPackageService.MAX_PACKAGE_DATA_BYTES) {
      throw new BadRequestException(
        `packageData exceeds maximum size (${(size / 1024).toFixed(0)} KB > 1024 KB)`,
      );
    }
  }

  private validatePackageDataStructure(data: Record<string, unknown>): void {
    // Screens must be an array if present
    if (data.screens !== undefined && !Array.isArray(data.screens)) {
      throw new BadRequestException('packageData.screens must be an array');
    }
    // Each screen must have widgets as array if present
    if (Array.isArray(data.screens)) {
      for (const screen of data.screens) {
        if (screen && typeof screen === 'object' && 'widgets' in screen) {
          if (!Array.isArray((screen as Record<string, unknown>).widgets)) {
            throw new BadRequestException('Each screen.widgets must be an array');
          }
        }
      }
    }
  }

  /**
   * Bound the script surface at the write boundary.
   *
   * SCADA scripts run as untrusted tenant code inside the QuickJS sandbox at
   * runtime (`ScriptEngineService`); the sandbox is memory- and CPU-bounded, but
   * accepting unbounded source at rest is still a denial-of-service and storage
   * vector. Reject (never truncate) oversized code, over-large script counts, or
   * an unknown execution mode so malformed packages cannot be persisted.
   */
  private validateScripts(data: Record<string, unknown>): void {
    if (data.scripts === undefined) {
      return;
    }
    if (!Array.isArray(data.scripts)) {
      throw new BadRequestException('packageData.scripts must be an array');
    }
    if (data.scripts.length > ScadaPackageService.MAX_SCRIPTS_PER_PACKAGE) {
      throw new BadRequestException(
        `packageData.scripts exceeds the maximum of ${ScadaPackageService.MAX_SCRIPTS_PER_PACKAGE} scripts`,
      );
    }
    let serverScripts = 0;
    for (const entry of data.scripts) {
      if (!entry || typeof entry !== 'object') {
        throw new BadRequestException('Each packageData.scripts entry must be an object');
      }
      const scriptEntry = entry as Record<string, unknown>;
      const { code, mode } = scriptEntry;
      if (typeof code !== 'string') {
        throw new BadRequestException('Each script must have a string `code` field');
      }
      const codeBytes = Buffer.byteLength(code, 'utf8');
      if (codeBytes > ScadaPackageService.MAX_SCRIPT_CODE_BYTES) {
        throw new BadRequestException(
          `Script "${String(scriptEntry.name ?? scriptEntry.id ?? 'unnamed')}" code exceeds the maximum size (${(
            codeBytes / 1024
          ).toFixed(0)} KB > ${ScadaPackageService.MAX_SCRIPT_CODE_BYTES / 1024} KB)`,
        );
      }
      if (mode !== undefined && (typeof mode !== 'string' || !ScadaPackageService.VALID_SCRIPT_MODES.has(mode))) {
        throw new BadRequestException("Script `mode` must be 'server' or 'client'");
      }
      if (mode === 'server') serverScripts += 1;
    }
    // Server scripts run on the cloud runtime (scheduler slots + sandbox
    // executions per active tenant) — bound them explicitly so a package
    // cannot monopolise the runtime even before the activation bridge loads it.
    if (serverScripts > ScadaPackageService.MAX_SERVER_SCRIPTS_PER_PACKAGE) {
      throw new BadRequestException(
        `packageData.scripts exceeds the maximum of ${ScadaPackageService.MAX_SERVER_SCRIPTS_PER_PACKAGE} server-mode scripts`,
      );
    }
  }

  /**
   * Save-time trust boundary (ScadaPackageDocV2): upcast whatever the
   * client sent to the current document contract, then validate it against
   * the canonical JSON Schema. Returns the upcasted document — the stored
   * row is always V2, so read paths only upcast legacy pre-Faz2 rows.
   */
  private async upcastAndValidatePackageData(
    data: Record<string, unknown>,
    tenantId: string,
  ): Promise<Record<string, unknown>> {
    const deviceCode = await this.resolveDeviceCode(
      (data.meta as Record<string, unknown> | undefined)?.edgeDeviceId,
      tenantId,
    );
    const doc = upcastScadaPackageDoc(data, deviceCode ? { deviceCode } : undefined);
    if (!validateScadaPackageDocV2(doc)) {
      throw new BadRequestException(
        `packageData failed ScadaPackageDocV2 validation: ${formatValidationErrors(validateScadaPackageDocV2)}`,
      );
    }
    return doc;
  }

  /** Best-effort edgeDeviceId → deviceCode lookup for TagRef promotion. */
  private async resolveDeviceCode(
    edgeDeviceId: unknown,
    tenantId: string,
  ): Promise<string | undefined> {
    if (typeof edgeDeviceId !== 'string' || !edgeDeviceId || !this.edgeDeviceService) {
      return undefined;
    }
    try {
      const device = await this.edgeDeviceService.findByIdOrFail(edgeDeviceId, tenantId);
      return device.deviceCode;
    } catch {
      // Unknown/foreign device: legacy local names simply stay unpromoted.
      return undefined;
    }
  }

  /**
   * Strip sensitive fields (e.g. pinHash) from packageData before returning to clients.
   * Returns a shallow-modified copy — does NOT mutate the DB record.
   */
  private sanitizePackageData(pkg: ScadaPackage): ScadaPackage {
    const data = pkg.packageData;
    const controlPermissions = data.controlPermissions as Record<string, unknown> | undefined;

    // Legacy rows: widget config.pin is a PLAINTEXT secret readable by any
    // tenant member (SENSOR-CRITICAL-006). Strip it on read, keeping the
    // requirePin trigger so the operator UI still prompts (verification is
    // server-side via PIN_VERIFY).
    const screens = Array.isArray(data.screens) ? data.screens : [];
    const hasWidgetPin = screens.some((screen) => {
      const widgets = (screen as { widgets?: unknown[] })?.widgets;
      return Array.isArray(widgets) && widgets.some((w) => {
        const pin = (w as { config?: Record<string, unknown> })?.config?.pin;
        return typeof pin === 'string' && pin.length > 0;
      });
    });

    if (!controlPermissions?.pinHash && !hasWidgetPin) return pkg;

    // Return a copy — do not mutate the original entity that may be cached by TypeORM
    const clone = Object.assign(Object.create(Object.getPrototypeOf(pkg)), pkg);
    clone.packageData = {
      ...data,
      ...(hasWidgetPin
        ? {
            screens: screens.map((screen) => {
              const sc = screen as Record<string, unknown> & { widgets?: unknown[] };
              if (!Array.isArray(sc.widgets)) return screen;
              return {
                ...sc,
                widgets: sc.widgets.map((w) => {
                  const widget = w as Record<string, unknown> & { config?: Record<string, unknown> };
                  const pin = widget.config?.pin;
                  if (typeof pin !== 'string' || pin.length === 0) return w;
                  const { pin: _stripped, ...restConfig } = widget.config!;
                  return { ...widget, config: { ...restConfig, requirePin: true } };
                }),
              };
            }),
          }
        : {}),
      ...(controlPermissions?.pinHash
        ? { controlPermissions: { ...controlPermissions, pinHash: '[REDACTED]' } }
        : {}),
    };
    return clone;
  }

  constructor(
    @InjectRepository(ScadaPackage)
    private readonly scadaPackageRepository: Repository<ScadaPackage>,
    @InjectRepository(Process)
    private readonly processRepository: Repository<Process>,
    @Optional()
    @Inject(MqttClientService)
    private readonly mqttClient: MqttClientService | null,
    @Optional()
    @Inject(EdgeDeviceService)
    private readonly edgeDeviceService: EdgeDeviceService | null,
    @Optional()
    @Inject(ScadaDeployLogService)
    private readonly scadaDeployLogService: ScadaDeployLogService | null,
    @Optional()
    @Inject(AutomationService)
    private readonly automationService: AutomationService | null,
    @Optional()
    @InjectRepository(AutomationProgram)
    private readonly automationProgramRepo: Repository<AutomationProgram> | null,
    @Optional()
    @InjectRepository(ProgramVariable)
    private readonly programVariableRepo: Repository<ProgramVariable> | null,
    @Optional()
    @Inject(TagResolutionService)
    private readonly tagResolutionService: TagResolutionService | null,
    @Optional()
    @Inject(ArtifactService)
    private readonly artifactService: ArtifactService | null,
    @Optional()
    @Inject(DeploySigningService)
    private readonly deploySigningService: DeploySigningService | null,
    @Optional()
    @Inject(ReleaseBundleService)
    private readonly releaseBundleService: ReleaseBundleService | null,
    @Optional()
    @Inject(OutboxPublisher)
    private readonly outboxPublisher: OutboxPublisher | null,
    @Optional()
    @Inject(ConfigService)
    private readonly configService: ConfigService | null,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Collect the tag-name strings widgets bind to (`config.tagName`, legacy
   * `config.tag`) from every screen in the package document.
   */
  /* ── Control-security PIN (SENSOR-CRITICAL-006) ─────────────────────── */

  /**
   * PIN policy at the set/hash boundary (M3): minimum length, and no
   * trivially-guessable digit patterns (all-same or strictly
   * ascending/descending runs). Applies wherever a NEW pin value enters the
   * system — widget plaintext pins and builder-written pinHash values.
   */
  private static assertPinPolicy(pin: string): void {
    if (pin.length < ScadaPackageService.PIN_MIN_LENGTH) {
      throw new BadRequestException(
        `Control PIN must be at least ${ScadaPackageService.PIN_MIN_LENGTH} characters`,
      );
    }
    if (/^\d+$/.test(pin)) {
      const digits = pin.split('').map((d) => Number(d));
      const allSame = digits.every((d) => d === digits[0]);
      const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1]! + 1);
      const descending = digits.every((d, i) => i === 0 || d === digits[i - 1]! - 1);
      if (allSame || ascending || descending) {
        throw new BadRequestException(
          'Control PIN is too weak: repeated or sequential digits are not allowed',
        );
      }
    }
  }

  /**
   * Harden control security at the SAVE boundary — plaintext can never
   * persist through a save:
   *  - every plaintext `widget.config.pin` is stripped, replaced with
   *    `config.requirePin = true`, its widget id recorded in
   *    `controlPermissions.securityLevels.pin`, and the PIN itself hashed
   *    into the package-level `controlPermissions.pinHash` (scrypt, salted);
   *  - a plaintext value written into `pinHash` by the builder is hashed too;
   *  - a null/absent incoming `pinHash` (the read path redacts it) preserves
   *    the stored hash so a load→edit→save roundtrip cannot wipe the PIN.
   *
   * New PINs must satisfy the M3 policy (min length, no trivial digit runs).
   */
  private hardenControlSecurity(
    data: Record<string, unknown>,
    existingPinHash?: string | null,
  ): void {
    const cp = (data.controlPermissions ??= {
      securityLevels: { none: [], confirm: [], pin: [] },
      pinHash: null,
      emergencyStop: null,
    }) as Record<string, unknown>;
    const levels = (cp.securityLevels ??= { none: [], confirm: [], pin: [] }) as Record<string, unknown>;
    const pinLevel: unknown[] = Array.isArray(levels.pin) ? levels.pin : (levels.pin = []);

    let plaintextPin: string | null = null;
    const screens = Array.isArray(data.screens) ? data.screens : [];
    for (const screen of screens) {
      const widgets = (screen as { widgets?: unknown[] })?.widgets;
      if (!Array.isArray(widgets)) continue;
      for (const widget of widgets) {
        const w = widget as { id?: string; config?: Record<string, unknown> };
        const pin = w.config?.pin;
        if (typeof pin === 'string' && pin.length > 0 && w.config) {
          plaintextPin ??= pin;
          delete w.config.pin;
          w.config.requirePin = true;
          if (w.id && !pinLevel.includes(w.id)) pinLevel.push(w.id);
        }
      }
    }
    if (plaintextPin) {
      ScadaPackageService.assertPinPolicy(plaintextPin);
    }

    if (cp.pinHash === '[REDACTED]') {
      // Roundtripped read-path redaction marker — restore the stored hash.
      cp.pinHash = existingPinHash ?? null;
    } else if (typeof cp.pinHash === 'string' && cp.pinHash.length > 0 && !isPinHash(cp.pinHash)) {
      // The builder wrote a raw PIN into the hash field — never store it as-is.
      ScadaPackageService.assertPinPolicy(cp.pinHash);
      cp.pinHash = hashPin(cp.pinHash);
    }
    if (plaintextPin) {
      cp.pinHash = hashPin(plaintextPin);
    } else if ((cp.pinHash == null || cp.pinHash === '') && existingPinHash) {
      cp.pinHash = existingPinHash;
    }
  }

  /** Extract the stored pinHash from a raw (unredacted) packageData. */
  private extractPinHash(data: Record<string, unknown>): string | null {
    const cp = data.controlPermissions as { pinHash?: unknown } | undefined;
    return typeof cp?.pinHash === 'string' && cp.pinHash.length > 0 ? cp.pinHash : null;
  }

  /**
   * Constant-time plaintext comparison (M3): both sides are SHA-256 digested
   * first so `timingSafeEqual` always sees equal-length buffers, making the
   * comparison time independent of where the first differing byte sits.
   */
  private static constantTimeEquals(a: string, b: string): boolean {
    const da = createHash('sha256').update(a, 'utf8').digest();
    const db = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(da, db);
  }

  /**
   * Verify a PIN against a package's stored hash (PIN_VERIFY socket flow).
   * Hashed values verify through the scrypt `verifyPin` (itself
   * timingSafeEqual-based). Legacy rows saved before hardening carry only
   * plaintext pins — those compare in CONSTANT TIME and harden IN PLACE on
   * their first successful verification (verify-then-rehash migration);
   * plaintext acceptance ends at LEGACY_PIN_CUTOFF.
   */
  async verifyPackagePin(packageId: string, tenantId: string, pin: string): Promise<boolean> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id: packageId, tenantId } });
    if (!pkg) return false;
    const stored = this.extractPinHash(pkg.packageData);
    if (stored) {
      if (isPinHash(stored)) {
        return verifyPin(pin, stored);
      }
      // Legacy: plaintext in the pinHash slot.
      if (Date.now() > ScadaPackageService.LEGACY_PIN_CUTOFF.getTime()) {
        this.logger.warn(
          `verifyPackagePin: package ${pkg.id} still carries a legacy plaintext PIN after the cutoff — refused`,
        );
        return false;
      }
      if (!ScadaPackageService.constantTimeEquals(pin, stored)) return false;
      await this.migrateLegacyPin(pkg, pin);
      return true;
    }
    // Legacy: per-widget plaintext pins (pre-hardening rows).
    const screens = Array.isArray(pkg.packageData.screens) ? pkg.packageData.screens : [];
    for (const screen of screens) {
      const widgets = (screen as { widgets?: unknown[] })?.widgets;
      if (!Array.isArray(widgets)) continue;
      for (const widget of widgets) {
        const wpin = (widget as { config?: Record<string, unknown> })?.config?.pin;
        if (typeof wpin === 'string' && wpin.length > 0) {
          if (Date.now() > ScadaPackageService.LEGACY_PIN_CUTOFF.getTime()) {
            this.logger.warn(
              `verifyPackagePin: package ${pkg.id} still carries legacy widget plaintext PINs after the cutoff — refused`,
            );
            return false;
          }
          if (ScadaPackageService.constantTimeEquals(pin, wpin)) {
            await this.migrateLegacyPin(pkg, pin);
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Verify-then-rehash migration (M3): once a legacy plaintext PIN is proven
   * known, hash it into the package-level `controlPermissions.pinHash`,
   * strip the widget plaintext, and persist — the row is hardened the first
   * time its owner successfully uses it. Deliberately NOT run through the
   * set-time PIN policy: this migrates an existing secret, it does not
   * accept a new one.
   */
  private async migrateLegacyPin(pkg: ScadaPackage, pin: string): Promise<void> {
    try {
      const data = pkg.packageData;
      const cp = (data.controlPermissions ??= {
        securityLevels: { none: [], confirm: [], pin: [] },
        pinHash: null,
        emergencyStop: null,
      }) as Record<string, unknown>;
      const levels = (cp.securityLevels ??= { none: [], confirm: [], pin: [] }) as Record<
        string,
        unknown
      >;
      const pinLevel: unknown[] = Array.isArray(levels.pin) ? levels.pin : (levels.pin = []);
      const screens = Array.isArray(data.screens) ? data.screens : [];
      for (const screen of screens) {
        const widgets = (screen as { widgets?: unknown[] })?.widgets;
        if (!Array.isArray(widgets)) continue;
        for (const widget of widgets) {
          const w = widget as { id?: string; config?: Record<string, unknown> };
          if (typeof w.config?.pin === 'string' && w.config.pin.length > 0) {
            delete w.config.pin;
            w.config.requirePin = true;
            if (w.id && !pinLevel.includes(w.id)) pinLevel.push(w.id);
          }
        }
      }
      cp.pinHash = hashPin(pin);
      await this.scadaPackageRepository.save(pkg);
      this.logger.warn(
        `DEPRECATION: migrated legacy plaintext PIN to a salted hash for package ${pkg.id} (tenant ${pkg.tenantId}) — plaintext PIN storage is deprecated and refused after ${ScadaPackageService.LEGACY_PIN_CUTOFF.toISOString()}`,
      );
    } catch (error) {
      // The verification itself already succeeded; a failed migration must
      // not flip it to a denial (the row simply stays legacy until next try).
      this.logger.error(
        `migrateLegacyPin: failed to harden package ${pkg.id} — ${(error as Error).message}`,
      );
    }
  }

  /**
   * The tenant-wide set of tag keys whose writes require PIN elevation:
   * every tag bound to a pin-protected widget (securityLevels.pin membership,
   * `config.requirePin`, or a legacy plaintext `config.pin`) across the
   * tenant's non-archived packages. The gateway enforces against this set so
   * a caller cannot opt out by omitting package context.
   */
  async getPinProtectedTagKeys(tenantId: string): Promise<Set<string>> {
    const packages = await this.scadaPackageRepository.find({ where: { tenantId } });
    const keys = new Set<string>();
    for (const pkg of packages) {
      if (pkg.status === ScadaPackageStatus.ARCHIVED) continue;
      const data = pkg.packageData;
      const cp = data.controlPermissions as { securityLevels?: { pin?: unknown[] } } | undefined;
      const pinWidgetIds = new Set(
        (Array.isArray(cp?.securityLevels?.pin) ? cp.securityLevels.pin : []).filter(
          (x): x is string => typeof x === 'string',
        ),
      );
      const screens = Array.isArray(data.screens) ? data.screens : [];
      for (const screen of screens) {
        const widgets = (screen as { widgets?: unknown[] })?.widgets;
        if (!Array.isArray(widgets)) continue;
        for (const widget of widgets) {
          const w = widget as { id?: string; config?: Record<string, unknown> };
          const protectedWidget =
            (w.id && pinWidgetIds.has(w.id)) ||
            w.config?.requirePin === true ||
            (typeof w.config?.pin === 'string' && w.config.pin.length > 0);
          if (!protectedWidget || !w.config) continue;
          for (const key of ['tagRef', 'tagId', 'tagName', 'tag'] as const) {
            const v = w.config[key];
            if (typeof v === 'string' && v.length > 0) keys.add(v);
          }
        }
      }
    }
    return keys;
  }

  private collectWidgetTagNames(data: Record<string, unknown>): string[] {
    const names = new Set<string>();
    const screens = Array.isArray(data.screens) ? data.screens : [];
    for (const screen of screens) {
      const widgets = (screen as { widgets?: unknown[] })?.widgets;
      if (!Array.isArray(widgets)) continue;
      for (const widget of widgets) {
        const config = (widget as { config?: Record<string, unknown> })?.config;
        for (const key of ['tagName', 'tag'] as const) {
          const value = config?.[key];
          if (typeof value === 'string' && value.length > 0) {
            names.add(value);
          }
        }
      }
    }
    return [...names];
  }

  /**
   * Map a Postgres unique-violation (23505) on the partial index
   * `uq_scada_packages_tenant_process` to a friendly conflict message naming
   * the process; anything else rethrows unchanged.
   */
  private mapProcessLinkConflict<T>(save: Promise<T>, processId?: string | null): Promise<T> {
    return save.catch((error: unknown) => {
      const code =
        (error as { code?: string } | null)?.code ??
        (error as { driverError?: { code?: string } } | null)?.driverError?.code;
      if (error instanceof QueryFailedError && code === '23505') {
        throw new BadRequestException(
          `A package is already linked to this process${processId ? ` (${processId})` : ''} — unlink or delete the existing package first`,
        );
      }
      throw error;
    });
  }

  async createScadaPackage(
    input: CreateScadaPackageInput,
    tenantId: string,
    userId?: string,
  ): Promise<ScadaPackage> {
    this.logger.log(`Creating SCADA package "${input.name}" for tenant ${tenantId}`);

    this.validatePackageDataSize(input.packageData);
    this.validatePackageDataStructure(input.packageData);
    this.validateScripts(input.packageData);
    const packageData = await this.upcastAndValidatePackageData(input.packageData, tenantId);
    this.hardenControlSecurity(packageData);

    if (input.processId) {
      const process = await this.processRepository.findOne({
        where: { id: input.processId, tenantId },
      });
      if (!process) {
        throw new NotFoundException(
          `Process with id ${input.processId} not found in current tenant`,
        );
      }
    }

    const pkg = this.scadaPackageRepository.create({
      ...input,
      packageData,
      tenantId,
      status: ScadaPackageStatus.DRAFT,
      version: 1,
      createdBy: userId,
    });
    return this.mapProcessLinkConflict(
      this.scadaPackageRepository.save(pkg),
      input.processId ?? null,
    );
  }

  async updateScadaPackage(
    id: string,
    input: UpdateScadaPackageInput,
    tenantId: string,
    userId?: string,
  ): Promise<ScadaPackage> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id, tenantId } });
    if (!pkg) throw new NotFoundException(`ScadaPackage ${id} not found`);

    if (input.processId !== undefined) {
      if (input.processId === null) {
        // Explicit null = UNLINK: skip process validation (there is nothing
        // to validate) and clear the column. Previously null fell through to
        // `findOne({ id: null })` nonsense.
        pkg.processId = null;
      } else {
        const process = await this.processRepository.findOne({
          where: { id: input.processId, tenantId },
        });
        if (!process) {
          throw new NotFoundException(
            `Process with id ${input.processId} not found in current tenant`,
          );
        }
        pkg.processId = input.processId;
      }
    }

    if (input.packageData !== undefined) {
      this.validatePackageDataSize(input.packageData);
      this.validatePackageDataStructure(input.packageData);
      this.validateScripts(input.packageData);
      const existingPinHash = this.extractPinHash(pkg.packageData);
      pkg.packageData = await this.upcastAndValidatePackageData(input.packageData, tenantId);
      this.hardenControlSecurity(pkg.packageData, existingPinHash);
    }

    if (input.name !== undefined) pkg.name = input.name;
    if (input.description !== undefined) pkg.description = input.description;
    // `status` is intentionally not applied here — it is owned by the lifecycle
    // methods (create/deploy/delete), not by a client update (see DTO comment).

    pkg.version = pkg.version + 1;
    pkg.updatedBy = userId;

    return this.mapProcessLinkConflict(
      this.scadaPackageRepository.save(pkg),
      pkg.processId ?? null,
    );
  }

  /**
   * Backfill legacy (pre-Faz2) SCADA package documents to the canonical
   * ScadaPackageDocV2 (Faz 6 / 6d). Every row whose `meta.schemaVersion` is not
   * exactly 2 is upcast — reusing the SAME `upcastScadaPackageDoc` + deviceCode
   * resolution the save/read boundaries use, so the `tagName → tagRef`
   * promotion is applied identically — validated against the canonical schema,
   * then rewritten in place. Idempotent: rows already at V2 are skipped, so a
   * re-run migrates 0. A row that fails V2 validation is left UNTOUCHED and
   * counted, never partially written. `dryRun` reports what would change
   * without writing a single row.
   *
   * Scoped to the caller's tenant (the search_path fences the query); run once
   * per tenant for a platform-wide backfill. The deploy version is deliberately
   * NOT bumped — a schema migration is not a user edit — and `updatedBy` is
   * stamped `system-backfill` so the provenance is auditable. The read-path
   * upcast in `getScadaPackage` stays as a defensive net until this backfill is
   * verified across production.
   */
  async backfillPackageDocsToV2(
    tenantId: string,
    options?: { dryRun?: boolean },
  ): Promise<{ scanned: number; migrated: number; skipped: number; failed: number; dryRun: boolean }> {
    const dryRun = options?.dryRun ?? false;
    // Enumerate candidate ids only. The authoritative read + write happens
    // under a row lock inside a per-row transaction (below), so a user edit
    // concurrent with the backfill cannot be lost: `save(pkg)` writes the
    // whole entity by primary key with no version check (ScadaPackage.version
    // is a manual counter, not a TypeORM @VersionColumn), so a blind
    // read-here / save-later would clobber an edit landing in that window.
    const ids = (await this.scadaPackageRepository.find({ where: { tenantId } })).map((p) => p.id);

    let migrated = 0;
    let skipped = 0;
    let failed = 0;

    for (const id of ids) {
      const outcome = await this.scadaPackageRepository.manager.transaction(
        async (manager): Promise<'migrated' | 'skipped' | 'failed'> => {
          const pkg = await manager.findOne(ScadaPackage, {
            where: { id, tenantId },
            lock: { mode: 'pessimistic_write' },
          });
          // Deleted between enumeration and lock acquisition.
          if (!pkg) return 'skipped';

          const meta = pkg.packageData?.meta as Record<string, unknown> | undefined;
          if (Number(meta?.schemaVersion) === 2) return 'skipped';

          // Per-row fenced: a single malformed legacy row is counted and left
          // untouched, never aborting the rest of the tenant's migration.
          let doc: Record<string, unknown>;
          try {
            const deviceCode = await this.resolveDeviceCode(meta?.edgeDeviceId, tenantId);
            doc = upcastScadaPackageDoc(pkg.packageData, deviceCode ? { deviceCode } : undefined);
            if (!validateScadaPackageDocV2(doc)) {
              this.logger.warn(
                `Backfill left package ${pkg.id} unchanged: failed ScadaPackageDocV2 validation (${formatValidationErrors(validateScadaPackageDocV2)})`,
              );
              return 'failed';
            }
          } catch (error) {
            this.logger.warn(`Backfill left package ${pkg.id} unchanged: ${(error as Error).message}`);
            return 'failed';
          }

          if (dryRun) return 'migrated';

          pkg.packageData = doc;
          pkg.updatedBy = 'system-backfill';
          await manager.save(pkg);
          return 'migrated';
        },
      );

      if (outcome === 'migrated') migrated += 1;
      else if (outcome === 'skipped') skipped += 1;
      else failed += 1;
    }

    this.logger.log(
      `SCADA packageData backfill for tenant ${tenantId}: scanned=${ids.length} migrated=${migrated} skipped=${skipped} failed=${failed} dryRun=${dryRun}`,
    );

    return { scanned: ids.length, migrated, skipped, failed, dryRun };
  }

  async getScadaPackage(id: string, tenantId: string): Promise<ScadaPackage | null> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id, tenantId } });
    if (!pkg) return null;
    // Upcast-on-read: legacy pre-Faz2 rows come back as V2 documents (no
    // validation throw on read — reads must never break on old data).
    const deviceCode = await this.resolveDeviceCode(
      (pkg.packageData?.meta as Record<string, unknown> | undefined)?.edgeDeviceId,
      tenantId,
    );
    pkg.packageData = upcastScadaPackageDoc(
      pkg.packageData,
      deviceCode ? { deviceCode } : undefined,
    );
    return this.sanitizePackageData(pkg);
  }

  /**
   * Operator consumption gate (M4): the PUBLISHED representation of a package.
   * Returns null when the package does not exist OR is not PUBLISHED — the
   * resolver turns both into the same FORBIDDEN 'Package is not published'
   * error so the gate leaks nothing about which id exists. `getScadaPackage`
   * above stays unrestricted (the builder needs DRAFT rows).
   */
  async getPublishedScadaPackage(id: string, tenantId: string): Promise<ScadaPackage | null> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id, tenantId } });
    if (!pkg || pkg.status !== ScadaPackageStatus.PUBLISHED) return null;
    const deviceCode = await this.resolveDeviceCode(
      (pkg.packageData?.meta as Record<string, unknown> | undefined)?.edgeDeviceId,
      tenantId,
    );
    pkg.packageData = upcastScadaPackageDoc(
      pkg.packageData,
      deviceCode ? { deviceCode } : undefined,
    );
    return this.sanitizePackageData(pkg);
  }

  /**
   * Derive `publishedAt` (M4) from the deploy history — NO schema migration.
   * The scada_packages table has no published_at column; the latest deploy
   * log row that actually shipped (i.e. not FAILED / ROLLED_BACK /
   * UNDEPLOY_*) carries the publication timestamp as its `updatedAt ?? sentAt`
   * (updatedAt advances as the row progresses SENT → … → SUCCESS, which is
   * the closest durable witness of "running as PUBLISHED"). Null when the
   * package never shipped or no deploy-log service/history exists.
   */
  async derivePublishedAt(packageId: string, tenantId: string): Promise<Date | null> {
    if (!this.scadaDeployLogService) return null;
    let logs: ScadaDeployLog[];
    try {
      logs = await this.scadaDeployLogService.getByPackage(packageId, tenantId);
    } catch {
      return null;
    }
    const notShipped = new Set<ScadaDeployStatus>([
      ScadaDeployStatus.FAILED,
      ScadaDeployStatus.ROLLED_BACK,
      ScadaDeployStatus.UNDEPLOY_SENT,
      ScadaDeployStatus.UNDEPLOYED,
    ]);
    for (const log of logs) {
      // getByPackage orders sentAt DESC — the first shipped row is the latest.
      if (notShipped.has(log.status)) continue;
      return log.updatedAt ?? log.sentAt ?? null;
    }
    return null;
  }

  /**
   * Publish WITHOUT an edge round-trip (M5): flips the package to PUBLISHED
   * through the SAME shared transition the deploy/ack paths use (so the
   * activation bridge reloads the tenant's runtime), but touches no broker,
   * no signing, no artifacts. Refuses ARCHIVED packages (a deleted package
   * must not re-enter the runtime).
   */
  async publishScadaPackage(
    id: string,
    tenantId: string,
    userId?: string,
  ): Promise<{ success: boolean; message: string; version: number }> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id, tenantId } });
    if (!pkg) throw new NotFoundException(`ScadaPackage ${id} not found`);
    if (pkg.status === ScadaPackageStatus.ARCHIVED) {
      throw new BadRequestException(
        `ScadaPackage ${id} is archived (deleted) and cannot be published`,
      );
    }
    await this.applyPublishState(pkg);
    this.logger.log(
      `Package "${pkg.name}" v${pkg.version} published without deploy (user: ${userId ?? 'system'})`,
    );
    return { success: true, message: 'Package published', version: pkg.version };
  }

  async listScadaPackages(
    tenantId: string,
    filter?: ScadaPackageFilterInput,
    pagination?: ProcessPaginationInput,
  ): Promise<IStandardPaginatedResult<ScadaPackage>> {
    const page = pagination?.page || 1;
    const limit = Math.min(pagination?.limit || 20, 100);
    const offset = (page - 1) * limit;

    const where: FindOptionsWhere<ScadaPackage> = { tenantId };
    if (filter?.status) {
      where.status = filter.status;
    } else if (filter?.includeArchived !== true) {
      // Archive semantics (M6b): with no status filter the default EXCLUDES
      // ARCHIVED — a soft-deleted package must not surface in package
      // pickers (the unified editor's processId-only query included it).
      // Callers that really want tombstones opt in with includeArchived.
      where.status = Not(ScadaPackageStatus.ARCHIVED);
    }
    if (filter?.processId) where.processId = filter.processId;

    let whereConditions: FindOptionsWhere<ScadaPackage> | FindOptionsWhere<ScadaPackage>[];
    if (filter?.searchTerm) {
      const escapedTerm = filter.searchTerm.replace(/%/g, '\\%').replace(/_/g, '\\_');
      whereConditions = [
        { ...where, name: ILike(`%${escapedTerm}%`) },
      ];
    } else {
      whereConditions = where;
    }

    const [items, total] = await this.scadaPackageRepository.findAndCount({
      where: whereConditions,
      order: { updatedAt: 'DESC' },
      skip: offset,
      take: limit,
    });

    const sanitizedItems = items.map((item) => this.sanitizePackageData(item));
    return createStandardPaginatedResult(sanitizedItems, total, page, limit);
  }

  /**
   * Shared PUBLISHED transition (M5): the single place a package row flips to
   * PUBLISHED and signals the activation bridge. Used by the bundle-ack
   * path (`markPackagePublished`), the single-command deploy path, and the
   * deploy-less `publishScadaPackage` mutation — one transition, one event.
   */
  private async applyPublishState(pkg: ScadaPackage): Promise<ScadaPackage> {
    pkg.status = ScadaPackageStatus.PUBLISHED;
    const saved = await this.scadaPackageRepository.save(pkg);
    this.emitPackageLifecycle(SCADA_PACKAGE_PUBLISHED, pkg.tenantId, pkg.id);
    return saved;
  }

  /**
   * Flip a package to PUBLISHED — called by the bundle-ack path when the
   * edge CONFIRMS the atomic apply (Faz 5). The single-command deploy
   * path still flips on publish; the bundle path only flips on device
   * confirmation, so PUBLISHED means "running on the device", not
   * "left the broker".
   */
  async markPackagePublished(packageId: string, tenantId: string): Promise<void> {
    const pkg = await this.scadaPackageRepository.findOne({
      where: { id: packageId, tenantId },
    });
    if (!pkg) {
      this.logger.warn(`Cannot mark package ${packageId} PUBLISHED — not found`);
      return;
    }
    await this.applyPublishState(pkg);
  }

  /**
   * In-process signal to the SCADA activation bridge (RT-011 Faz 3). The cloud
   * runtime engines must NOT be imported here (they live in the scada-runtime
   * module and depend on the gateway) — so a publish/archive crosses the
   * boundary as an EventEmitter2 event, consumed by `ScadaActivationService`.
   * Best-effort: a listener fault must never fail the package mutation.
   */
  private emitPackageLifecycle(event: string, tenantId: string, packageId: string): void {
    try {
      this.eventEmitter.emit(event, { tenantId, packageId } satisfies ScadaPackageLifecycleEvent);
    } catch (error) {
      this.logger.error(
        `emitPackageLifecycle(${event}) failed for tenant=${tenantId} pkg=${packageId} — ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete (archive) a package — and take it OFF the devices it runs on
   * (WF-011). Archive alone left every deployed device rendering, alarming
   * and actuating from a package the tenant believed deleted.
   *
   * Undeploy is BEST-EFFORT and the archive happens REGARDLESS: blocking
   * delete on an offline device would make decommissioning impossible, and
   * an archived package can never be re-deployed (`assertPackageDeployable`).
   * Per-device outcomes are returned so the caller can report honestly.
   * Idempotent: re-deleting an ARCHIVED package is a no-op (already swept).
   */
  async deleteScadaPackage(
    id: string,
    tenantId: string,
    userId?: string,
  ): Promise<DeleteScadaPackageResult> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id, tenantId } });
    if (!pkg) throw new NotFoundException(`ScadaPackage ${id} not found`);

    if (pkg.status === ScadaPackageStatus.ARCHIVED) {
      // Idempotent no-op sweep — but still finish any pending unlink so a
      // legacy archived row cannot hold the 1:1 process link hostage forever.
      if (pkg.processId != null) {
        pkg.processId = null;
        await this.scadaPackageRepository.save(pkg);
      }
      return { archived: true, undeploy: [] };
    }

    const undeploy = await this.undeployPackageFromDevices(pkg, tenantId, userId);

    pkg.status = ScadaPackageStatus.ARCHIVED;
    // Unlink the process (M6a): the partial unique index
    // uq_scada_packages_tenant_process (WHERE process_id IS NOT NULL) would
    // otherwise block re-creating a package for the same process FOREVER —
    // the migration's own dedup step documents process_id → NULL as the
    // intended unlink semantics. NULL rows sit outside the index.
    pkg.processId = null;
    await this.scadaPackageRepository.save(pkg);
    this.emitPackageLifecycle(SCADA_PACKAGE_ARCHIVED, tenantId, pkg.id);
    return { archived: true, undeploy };
  }

  /**
   * Fan an `undeploy_scada_package` command out to every device whose
   * LATEST deploy-log row says this package is (or may be) running there.
   * Devices whose latest row is FAILED / ROLLED_BACK / UNDEPLOY_SENT /
   * UNDEPLOYED are skipped — nothing of this package runs there. A failure
   * on device A never stops device B (each result is recorded).
   */
  private async undeployPackageFromDevices(
    pkg: ScadaPackage,
    tenantId: string,
    userId?: string,
  ): Promise<UndeployDeviceResult[]> {
    if (!this.scadaDeployLogService) {
      // No deploy history available — degrade to archive-only (nothing to
      // derive targets from; the optional dep is absent in slim setups).
      return [];
    }

    let logs: ScadaDeployLog[];
    try {
      logs = await this.scadaDeployLogService.getByPackage(pkg.id, tenantId);
    } catch (error) {
      this.logger.error(
        `undeploy fan-out: deploy logs unavailable for package ${pkg.id}: ${(error as Error).message}`,
      );
      return [];
    }

    // getByPackage orders sentAt DESC — first row per device is its latest.
    const latestByDevice = new Map<string, ScadaDeployStatus>();
    for (const log of logs) {
      if (!latestByDevice.has(log.deviceId)) {
        latestByDevice.set(log.deviceId, log.status);
      }
    }

    const nothingRunning = new Set<ScadaDeployStatus>([
      ScadaDeployStatus.FAILED,
      ScadaDeployStatus.ROLLED_BACK,
      ScadaDeployStatus.UNDEPLOY_SENT,
      ScadaDeployStatus.UNDEPLOYED,
    ]);

    const results: UndeployDeviceResult[] = [];
    for (const [deviceId, latestStatus] of latestByDevice) {
      if (nothingRunning.has(latestStatus)) continue;
      results.push(await this.sendUndeployCommand(pkg, deviceId, tenantId, userId));
    }
    return results;
  }

  /** Publish one undeploy command; every failure mode becomes a result note. */
  private async sendUndeployCommand(
    pkg: ScadaPackage,
    deviceId: string,
    tenantId: string,
    userId?: string,
  ): Promise<UndeployDeviceResult> {
    if (!this.edgeDeviceService || !this.mqttClient) {
      return {
        deviceId,
        sent: false,
        message: 'undeploy infrastructure unavailable (MQTT/device service) — package archived only',
      };
    }

    let device: Awaited<ReturnType<EdgeDeviceService['findByIdOrFail']>>;
    try {
      device = await this.edgeDeviceService.findByIdOrFail(deviceId, tenantId);
    } catch {
      return { deviceId, sent: false, message: `device ${deviceId} not found` };
    }
    if (!device.isOnline) {
      return {
        deviceId: device.id,
        sent: false,
        message: `${device.deviceCode} is offline — undeploy not sent`,
      };
    }
    if (!this.mqttClient.isConnectedToBroker()) {
      return { deviceId: device.id, sent: false, message: 'No MQTT broker connection' };
    }

    const commandId = randomUUID();
    const params = { packageId: pkg.id, reason: 'package_deleted' };
    const payload = {
      commandId,
      command: 'undeploy_scada_package',
      params,
      timestamp: new Date().toISOString(),
    };
    // Publish-boundary contract validation — same canonical schemas the
    // Rust agent is parity-tested against (deploy-path discipline).
    if (!validateUndeployScadaPackageParams(params) || !validateCommandEnvelope(payload)) {
      const detail =
        formatValidationErrors(validateUndeployScadaPackageParams) ||
        formatValidationErrors(validateCommandEnvelope);
      return {
        deviceId: device.id,
        sent: false,
        message: `undeploy payload violates the canonical contract: ${detail}`,
      };
    }

    if (this.scadaDeployLogService) {
      try {
        await this.scadaDeployLogService.createLog({
          tenantId,
          packageId: pkg.id,
          deviceId: device.id,
          commandId,
          version: pkg.version,
          deployedBy: userId,
          status: ScadaDeployStatus.UNDEPLOY_SENT,
        });
      } catch (logError) {
        this.logger.error(
          `Failed to create undeploy log for device ${device.id}: ${(logError as Error).message}`,
        );
      }
    }

    try {
      await this.mqttClient.publish(`tenants/${tenantId}/devices/${device.id}/commands`, payload);
      this.logger.log(
        `undeploy_scada_package sent for package ${pkg.id} to device ${device.deviceCode} (command: ${commandId})`,
      );
      return { deviceId: device.id, sent: true, message: `${device.deviceCode}: undeploy sent` };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Failed to publish undeploy to device ${device.id}: ${msg}`);
      return { deviceId: device.id, sent: false, message: `${device.deviceCode}: publish failed — ${msg}` };
    }
  }

  /**
   * Deploy tag-gate mode (WF-003 / SENSOR-HIGH-051). `enforce` blocks a deploy
   * whose tag bindings do not fully resolve against the registry; the default
   * `warn` only logs, so tenants whose registry is not yet populated keep
   * deploying while ops flips the flag per environment after backfill.
   */
  private isTagGateEnforced(): boolean {
    // Config rides through Nest ConfigService (config-env-access-ratchet);
    // without a ConfigService (slim test modules) the gate stays at `warn`.
    const mode = this.configService?.get<string>('SCADA_DEPLOY_TAG_GATE') ?? 'warn';
    return mode.toLowerCase() === 'enforce';
  }

  /**
   * Handle an unresolved tag-binding set at a deploy boundary: throw in
   * enforce mode (each unresolved ref + reason named), warn otherwise.
   */
  private handleUnresolvedBindings(
    context: string,
    unresolved: ReadonlyArray<{ ref: string; reason: string }>,
    totalRefs: number,
  ): void {
    if (unresolved.length === 0) return;
    const detail = `${unresolved.length}/${totalRefs} tag bindings could not be resolved: ${JSON.stringify(unresolved)}`;
    if (this.isTagGateEnforced()) {
      throw new BadRequestException(`${context}: ${detail} — deploy blocked (SCADA_DEPLOY_TAG_GATE=enforce)`);
    }
    this.logger.warn(`${context}: ${detail}`);
  }

  /**
   * Publish-boundary widget transform (CONTRACT-H-002). The edge runtime
   * parses a closed 16-type widget set; everything else either STRIPS
   * (decorative / display-only — losing it on the device costs pixels,
   * not behaviour) or REJECTS the deploy (control-semantics widgets whose
   * silent removal would change what the operator can actuate). Rejects
   * throw with EVERY violating widget named; strips are warn-logged and
   * returned so callers can surface a summary.
   */
  private transformForEdgeOrThrow(
    context: string,
    doc: ScadaPackageDocV2,
  ): { doc: ScadaPackageDocV2; stripped: EdgeDeployWidgetRef[] } {
    const transform = transformScadaDocForEdgeDeploy(doc);
    if (!transform.ok) {
      const detail = transform.rejected
        .map((r) => `${r.widgetType} (widget ${r.widgetId}, screen ${r.screenId})`)
        .join(', ');
      throw new BadRequestException(
        `${context}: ${transform.rejected.length} widget(s) are not supported by the edge runtime and carry control semantics, so they cannot be silently stripped: ${detail}. Remove these widgets or replace them with edge-supported equivalents.`,
      );
    }
    if (transform.stripped.length > 0) {
      this.logger.warn(
        `${context}: ${transform.stripped.length} display-only/decorative widget(s) stripped from the edge payload (the stored package is unchanged): ` +
          transform.stripped.map((r) => `${r.widgetType}#${r.widgetId}`).join(', '),
      );
    }
    return { doc: transform.doc, stripped: transform.stripped };
  }

  /**
   * A package that has been soft-deleted (ARCHIVED) must never be pushed to a
   * device. Deploy is the moment the package starts running physical hardware,
   * so an archived (deleted) package reaching the edge is a state-machine
   * violation, not a recoverable warning. Every device-push entrypoint guards
   * on this before touching the broker.
   */
  private assertPackageDeployable(pkg: ScadaPackage): void {
    if (pkg.status === ScadaPackageStatus.ARCHIVED) {
      throw new BadRequestException(
        `ScadaPackage ${pkg.id} is archived (deleted) and cannot be deployed`,
      );
    }
  }

  async deployScadaPackageToEdge(
    packageId: string,
    deviceId: string,
    tenantId: string,
    userId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id: packageId, tenantId } });
    if (!pkg) throw new NotFoundException(`ScadaPackage ${packageId} not found`);
    this.assertPackageDeployable(pkg);

    if (!this.edgeDeviceService) {
      throw new BadRequestException('Edge device service not available');
    }
    const device = await this.edgeDeviceService.findByIdOrFail(deviceId, tenantId);
    if (!device.isOnline) {
      return { success: false, message: 'Device is offline — cannot deploy SCADA package' };
    }

    if (!this.mqttClient) {
      throw new BadRequestException('MQTT service not available');
    }
    if (!this.mqttClient.isConnectedToBroker()) {
      throw new BadRequestException('Not connected to MQTT broker');
    }

    // Validate automation bindings before deploying (TASK 2)
    await this.validateAutomationBindings(pkg);

    // Deploy always ships the CURRENT document contract: legacy rows that
    // were saved before Faz 2 upcast here (deploy reads the repo directly,
    // bypassing getScadaPackage's read-path upcast).
    const packageDoc = upcastScadaPackageDoc(pkg.packageData, {
      deviceCode: device.deviceCode,
    });

    // Edge widget transform (CONTRACT-H-002) — AFTER upcast (tagRef
    // promotion first), BEFORE the tag gate (stripped widgets' bindings
    // must not gate a payload they are no longer part of).
    const { doc: edgeDoc, stripped } = this.transformForEdgeOrThrow(
      `deploy_scada_package ${packageId}`,
      packageDoc,
    );

    // Tag SSoT gate (WF-003): widget tag bağlamalarını `${deviceCode}/${tagName}`
    // olarak registry'ye karşı çöz. enforce modunda çözülmeyen binding deploy'u
    // BLOKLAR; warn modunda (default — registry'si dolmamış tenant'lar) loglar.
    if (this.tagResolutionService) {
      const tagNames = this.collectWidgetTagNames(edgeDoc);
      if (tagNames.length > 0) {
        const refs = tagNames.map((name) => `${device.deviceCode}/${name}`);
        const resolution = await this.tagResolutionService.resolve(tenantId, refs);
        this.handleUnresolvedBindings(
          `deploy_scada_package ${packageId}`,
          resolution.unresolved,
          refs.length,
        );
      }
    }

    const commandId = randomUUID();

    // Content-addressed snapshot (Faz 3): the CANONICAL package content is
    // archived (volatile envelope fields like deployedAt stay out so
    // identical content dedupes to one artifact). Rollback = republish by
    // artifact id with a fresh envelope.
    //
    // FAIL-CLOSED (M1): a snapshot failure ABORTS the deploy. The previous
    // behavior swallowed the error and shipped an unsnapshotted — and
    // therefore unrollbackable — payload. Signing is deferred platform-wide
    // (decision), but snapshotting is NOT optional: no artifact, no deploy.
    if (!this.artifactService) {
      throw new BadRequestException(
        'Artifact service not available — deploys are fail-closed without a content-addressed snapshot',
      );
    }
    let artifact: Awaited<ReturnType<ArtifactService['snapshot']>>;
    try {
      artifact = await this.artifactService.snapshot(tenantId, {
        artifactType: DeployArtifactType.SCADA_PACKAGE,
        // The snapshot archives EXACTLY what ships (the transformed edge
        // doc) so rollback republishes device-parseable content verbatim.
        content: edgeDoc,
        schemaVersion: edgeDoc.meta.schemaVersion,
        sourceEntityId: pkg.id,
        sourceEntityVersion: pkg.version,
        createdBy: userId,
      });
    } catch (snapshotError) {
      this.logger.error(
        `Failed to snapshot SCADA package artifact: ${(snapshotError as Error).message}`,
      );
      throw new BadRequestException(
        `Deploy aborted: snapshotting the package artifact failed (${(snapshotError as Error).message}) — fail-closed, no unsigned-and-unsnapshotted deploy`,
      );
    }

    // Faz 4: ed25519 signature over tenant + artifact sha256 under domain
    // tag `scada-pkg-v1` — verified by the edge against
    // firmware_signing_pubkey before applying the package. Null (unsigned)
    // when the key seed is not configured — the result message then carries
    // the UNSIGNED marker.
    const signature = this.deploySigningService
      ? this.deploySigningService.signDeployArtifact(
          'scada-package',
          tenantId,
          artifact.contentSha256,
        )
      : null;

    const packagePayload = {
      ...edgeDoc,
      meta: {
        ...edgeDoc.meta,
        // Server-side fields MUST come last to prevent client override
        version: pkg.version,
        packageVersion: `${pkg.version}.0.0`,
        deployedBy: userId || 'system',
        deployedAt: new Date().toISOString(),
        edgeDeviceId: device.id,
        artifactSha256: artifact.contentSha256,
        ...(signature ? { signature } : {}),
      },
    };

    const topic = `tenants/${tenantId}/devices/${device.id}/commands`;
    // Server-controlled envelope — spread packagePayload into params only,
    // so client packageData cannot override commandId/command/timestamp
    const payload = {
      commandId,
      command: 'deploy_scada_package',
      params: packagePayload,
      timestamp: new Date().toISOString(),
    };

    // Publish-boundary contract validation (Faz 4): the shipped payload must
    // match the canonical schemas the Rust agent is parity-tested against.
    if (!validateDeployScadaPackageParams(packagePayload)) {
      throw new BadRequestException(
        `deploy_scada_package payload violates the canonical contract: ${formatValidationErrors(validateDeployScadaPackageParams)}`,
      );
    }
    if (!validateCommandEnvelope(payload)) {
      throw new BadRequestException(
        `Command envelope violates the canonical contract: ${formatValidationErrors(validateCommandEnvelope)}`,
      );
    }

    // Create SCADA deploy log entry before sending MQTT (TASK 1)
    if (this.scadaDeployLogService) {
      try {
        await this.scadaDeployLogService.createLog({
          tenantId,
          packageId: pkg.id,
          deviceId: device.id,
          commandId,
          version: pkg.version,
          deployedBy: userId,
          artifactId: artifact.id,
          checksumSha256: artifact.contentSha256,
        });
      } catch (logError) {
        this.logger.error(`Failed to create SCADA deploy log: ${(logError as Error).message}`);
        // Continue with deployment even if logging fails
      }
    }

    try {
      await this.mqttClient.publish(topic, payload);
      await this.applyPublishState(pkg);

      this.logger.log(
        `SCADA package "${pkg.name}" v${pkg.version} deployed to device ${device.deviceCode} (command: ${commandId})`,
      );
      // Honest success: name what was stripped so the operator is never
      // surprised by widgets present in the builder but absent on the HMI.
      const strippedNote =
        stripped.length > 0
          ? ` (${stripped.length} display-only widget(s) stripped from the deploy — kept in the package: ${stripped.map((r) => r.widgetType).join(', ')})`
          : '';
      // UNSIGNED marker (M1): platform-wide signing is deferred by decision —
      // the result message must say so; the frontend labels it.
      const unsignedNote = signature
        ? ''
        : ' [UNSIGNED — deploy signing not configured; the edge will warn]';
      return {
        success: true,
        message: `SCADA package deployed successfully${strippedNote}${unsignedNote}`,
      };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Failed to deploy SCADA package: ${msg}`);
      return { success: false, message: `Failed to deploy: ${msg}` };
    }
  }

  /**
   * REAL rollback (Faz 3): republish a previously-shipped artifact snapshot
   * verbatim. Unlike the edge's single previous-version slot, any retained
   * artifact can be restored, any number of times.
   *
   * Rollback PARITY with a fresh deploy (M1): the same ARCHIVED guard and
   * the same tag-gate terms apply — rollback is a deploy, so a package that
   * could not be freshly deployed (archived, or unresolved bindings under
   * SCADA_DEPLOY_TAG_GATE=enforce) cannot be rolled back either.
   */
  async rollbackScadaPackageDeploy(
    artifactId: string,
    deviceId: string,
    tenantId: string,
    userId?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!this.artifactService) {
      throw new BadRequestException('Artifact service not available');
    }
    const artifact = await this.artifactService.getById(tenantId, artifactId);
    if (artifact.artifactType !== DeployArtifactType.SCADA_PACKAGE) {
      throw new BadRequestException(
        `Artifact ${artifactId} is a ${artifact.artifactType}, not a SCADA package`,
      );
    }

    // Archived/deleted packages never reach a device — same guard, same
    // terms as deployScadaPackageToEdge.
    if (!artifact.sourceEntityId) {
      throw new BadRequestException(
        `Artifact ${artifactId} has no source package — cannot roll back`,
      );
    }
    const pkg = await this.scadaPackageRepository.findOne({
      where: { id: artifact.sourceEntityId, tenantId },
    });
    if (!pkg) {
      throw new NotFoundException(
        `ScadaPackage ${artifact.sourceEntityId} (source of artifact ${artifactId}) not found`,
      );
    }
    this.assertPackageDeployable(pkg);

    if (!this.edgeDeviceService) {
      throw new BadRequestException('Edge device service not available');
    }
    const device = await this.edgeDeviceService.findByIdOrFail(deviceId, tenantId);
    if (!device.isOnline) {
      return { success: false, message: 'Device is offline — cannot roll back' };
    }
    if (!this.mqttClient) {
      throw new BadRequestException('MQTT service not available');
    }
    if (!this.mqttClient.isConnectedToBroker()) {
      throw new BadRequestException('Not connected to MQTT broker');
    }

    // Tag SSoT gate — same coverage as the single-command deploy path,
    // evaluated against the artifact's archived content.
    if (this.tagResolutionService) {
      const tagNames = this.collectWidgetTagNames(artifact.content);
      if (tagNames.length > 0) {
        const refs = tagNames.map((name) => `${device.deviceCode}/${name}`);
        const resolution = await this.tagResolutionService.resolve(tenantId, refs);
        this.handleUnresolvedBindings(
          `rollback_scada_package ${artifactId}`,
          resolution.unresolved,
          refs.length,
        );
      }
    }

    const commandId = randomUUID();
    const version = artifact.sourceEntityVersion ?? 0;
    // Rollback republishes signed content: same artifact sha256, same
    // domain tag — the edge cannot distinguish (nor needs to) a rollback
    // from a fresh deploy at the signature layer.
    // CONTRACT-H-002: deliberately NO widget transform here — the payload
    // must stay byte-faithful to the signed artifact (the signature binds
    // the content hash). Unknown widget types inside PRE-transform-era
    // artifacts are absorbed by the edge's #[serde(other)] Unknown
    // tolerance instead of failing deserialization.
    const signature = this.deploySigningService
      ? this.deploySigningService.signDeployArtifact(
          'scada-package',
          tenantId,
          artifact.contentSha256,
        )
      : null;
    const payload = {
      commandId,
      command: 'deploy_scada_package',
      params: {
        ...artifact.content,
        meta: {
          ...((artifact.content.meta ?? {}) as Record<string, unknown>),
          version,
          packageVersion: `${version}.0.0`,
          deployedBy: userId || 'system',
          deployedAt: new Date().toISOString(),
          edgeDeviceId: device.id,
          artifactSha256: artifact.contentSha256,
          rollback: true,
          ...(signature ? { signature } : {}),
        },
      },
      timestamp: new Date().toISOString(),
    };

    if (this.scadaDeployLogService) {
      try {
        await this.scadaDeployLogService.createLog({
          tenantId,
          packageId: artifact.sourceEntityId,
          deviceId: device.id,
          commandId,
          version,
          deployedBy: userId,
          artifactId: artifact.id,
          checksumSha256: artifact.contentSha256,
          rolledBackTo: artifact.sourceEntityVersion,
        });
      } catch (logError) {
        this.logger.error(
          `Failed to create rollback deploy log: ${(logError as Error).message}`,
        );
      }
    }

    try {
      await this.mqttClient.publish(
        `tenants/${tenantId}/devices/${device.id}/commands`,
        payload,
      );
      this.logger.log(
        `Rolled back device ${device.deviceCode} to SCADA artifact ${artifact.id} (v${version}, command: ${commandId})`,
      );
      // UNSIGNED marker (M1) — parity with the deploy result message.
      const unsignedNote = signature
        ? ''
        : ' [UNSIGNED — deploy signing not configured; the edge will warn]';
      return {
        success: true,
        message: `Rollback to artifact v${version} sent${unsignedNote}`,
      };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Failed to publish rollback: ${msg}`);
      return { success: false, message: `Failed to roll back: ${msg}` };
    }
  }

  // ==========================================================================
  // Automation Binding Validation (TASK 2)
  // ==========================================================================

  /**
   * Validate automation bindings in a SCADA package's metadata.
   *
   * When a package has `meta.automationBindings`, each binding references
   * an automation program and its variables. This method validates:
   *   1. Each referenced programId exists in the database
   *   2. Each program is in APPROVED or DEPLOYED status
   *   3. Each referenced variableId exists for that program
   *   4. Each boundWidgetId references a widget present in the package screens
   */
  private async validateAutomationBindings(pkg: ScadaPackage): Promise<void> {
    const meta = pkg.packageData.meta as Record<string, unknown> | undefined;
    const bindings: AutomationBinding[] | undefined = meta?.automationBindings as AutomationBinding[] | undefined;

    if (!bindings || !Array.isArray(bindings) || bindings.length === 0) {
      return; // No automation bindings — nothing to validate
    }

    if (!this.automationProgramRepo || !this.programVariableRepo) {
      this.logger.warn(
        'Automation repositories not available — skipping automation binding validation',
      );
      return;
    }

    const errors: string[] = [];

    // 1. Collect all unique programIds and variableIds from bindings
    const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    const programIds = [...new Set(bindings.map((b) => b.programId).filter(isString))];
    const variableIds = [...new Set(bindings.map((b) => b.variableId).filter(isString))];
    const widgetIds = [...new Set(bindings.map((b) => b.boundWidgetId).filter(isString))];

    // 2. Validate programs exist and are in deployable status
    if (programIds.length > 0) {
      const programs = await this.automationProgramRepo.find({
        where: { id: In(programIds), tenantId: pkg.tenantId },
      });

      const foundIds = new Set(programs.map((p) => p.id));
      for (const pid of programIds) {
        if (!foundIds.has(pid)) {
          errors.push(`Automation program ${pid} not found`);
        }
      }

      for (const program of programs) {
        if (
          program.status !== ProgramStatus.APPROVED &&
          program.status !== ProgramStatus.DEPLOYED
        ) {
          errors.push(
            `Program "${program.programName}" (${program.id}) is in ${program.status} status; must be APPROVED or DEPLOYED`,
          );
        }
      }
    }

    // 3. Validate variables exist and belong to their referenced programs
    if (variableIds.length > 0) {
      const variables = await this.programVariableRepo.find({
        where: { id: In(variableIds) },
      });

      const foundVarIds = new Set(variables.map((v) => v.id));
      const varProgramMap = new Map(variables.map((v) => [v.id, v.programId]));

      for (const binding of bindings) {
        if (binding.variableId && !foundVarIds.has(binding.variableId)) {
          errors.push(`Variable ${binding.variableId} not found`);
        } else if (binding.variableId && binding.programId) {
          const actualProgramId = varProgramMap.get(binding.variableId);
          if (actualProgramId && actualProgramId !== binding.programId) {
            errors.push(
              `Variable ${binding.variableId} belongs to program ${actualProgramId}, not ${binding.programId}`,
            );
          }
        }
      }
    }

    // 4. Validate widget IDs exist in the package screens
    if (widgetIds.length > 0) {
      const packageWidgetIds = this.extractWidgetIds(pkg.packageData);
      for (const wid of widgetIds) {
        if (!packageWidgetIds.has(wid)) {
          errors.push(`Widget "${wid}" not found in package screens`);
        }
      }
    }

    if (errors.length > 0) {
      throw new BadRequestException(
        `Automation binding validation failed:\n- ${errors.join('\n- ')}`,
      );
    }
  }

  /**
   * Recursively extract all widget IDs from the SCADA package data.
   * Looks for `id` fields inside `screens[].widgets[]` and nested children.
   */
  private extractWidgetIds(packageData: Record<string, unknown>): Set<string> {
    const ids = new Set<string>();
    const screens = packageData.screens;
    if (!Array.isArray(screens)) return ids;

    const collectIds = (widgets: unknown[]): void => {
      for (const widget of widgets) {
        if (widget && typeof widget === 'object') {
          const w = widget as Record<string, unknown>;
          if (typeof w.id === 'string') {
            ids.add(w.id);
          }
          // Recurse into children
          if (Array.isArray(w.children)) {
            collectIds(w.children);
          }
          if (Array.isArray(w.widgets)) {
            collectIds(w.widgets);
          }
        }
      }
    };

    for (const screen of screens) {
      if (screen && typeof screen === 'object') {
        const s = screen as Record<string, unknown>;
        if (Array.isArray(s.widgets)) {
          collectIds(s.widgets);
        }
      }
    }

    return ids;
  }

  // ==========================================================================
  // Unified Deploy: SCADA + Automation — release-bundle builder (Faz 5)
  // ==========================================================================

  /**
   * Deploy a SCADA package together with its bound automation programs as
   * ONE two-phase release bundle (enterprise plan Faz 5).
   *
   * The pre-Faz-5 shape published N+1 independent fire-and-forget commands
   * (programs first, then the package) — a crash or broker outage between
   * them left the device half-deployed with no record of it. Now:
   *
   *   1. Each program + the package is snapshotted as a content-addressed
   *      artifact and staged into a signed manifest.
   *   2. The `release_bundles` PENDING row and the `DeployBundleRequested`
   *      outbox event commit in ONE transaction — a crash cannot lose the
   *      dispatch, and the dispatch cannot precede the commit.
   *   3. The edge verifies the manifest signature + every artifact
   *      checksum, then applies everything atomically under its deploy
   *      lock and acks staged → confirmed (or failed with nothing applied).
   *
   * Bundles are ALWAYS signed — the builder refuses to run without the
   * signing key rather than shipping an unsigned bundle.
   */
  async deployScadaWithAutomation(
    packageId: string,
    deviceId: string,
    tenantId: string,
    userId?: string,
    programIdOverrides?: string[],
  ): Promise<UnifiedDeployResult> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id: packageId, tenantId } });
    if (!pkg) throw new NotFoundException(`ScadaPackage ${packageId} not found`);
    this.assertPackageDeployable(pkg);

    // Determine which programs ride the bundle
    const meta = pkg.packageData.meta as Record<string, unknown> | undefined;
    const bindings: AutomationBinding[] | undefined = meta?.automationBindings as AutomationBinding[] | undefined;
    const programIds = programIdOverrides && programIdOverrides.length > 0
      ? programIdOverrides
      : [...new Set((bindings || []).map((b) => b.programId).filter(Boolean))];

    // Bundle pipeline preconditions — fail loudly with the exact remedy.
    if (!this.edgeDeviceService) {
      throw new BadRequestException('Edge device service not available');
    }
    if (!this.artifactService) {
      throw new BadRequestException(
        'Artifact service not available — bundle deploys require the content-addressed store',
      );
    }
    const releaseBundleService = this.releaseBundleService;
    const outboxPublisher = this.outboxPublisher;
    if (!releaseBundleService || !outboxPublisher) {
      throw new BadRequestException(
        'Release-bundle pipeline not available (ReleaseBundleModule / outbox not wired)',
      );
    }
    const deploySigningService = this.deploySigningService;
    if (!deploySigningService?.isConfigured) {
      throw new BadRequestException(
        'Bundle deploys require deploy signing — set SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX (unsigned bundles do not exist)',
      );
    }
    const automationService = this.automationService;
    if (programIds.length > 0 && !automationService) {
      throw new BadRequestException(
        'AutomationService not available — cannot bundle automation programs',
      );
    }

    const device = await this.edgeDeviceService.findByIdOrFail(deviceId, tenantId);
    if (!device.isOnline) {
      return {
        success: false,
        message: 'Device is offline — cannot deploy release bundle',
        automationResults: [],
      };
    }

    const automationResults: AutomationDeployStepResult[] = [];
    const artifactRefs: ReleaseBundleArtifactRef[] = [];

    // Step 1: stage automation programs into the bundle (programs lead so
    // they are running before SCADA reads their variables — same ordering
    // contract as before, now enforced by manifest order + edge apply).
    for (const programId of programIds) {
      if (!automationService) break;
      try {
        const prep = await automationService.prepareProgramBundleArtifact(
          programId,
          deviceId,
          tenantId,
          userId || 'system',
        );
        artifactRefs.push({
          artifactId: prep.artifactId,
          kind: DeployArtifactType.AUTOMATION_PROGRAM,
          sha256: prep.sha256,
          sourceEntityId: programId,
          logCommandId: prep.logCommandId,
          version: prep.version,
        });
        automationResults.push({
          programId,
          success: true,
          message: 'Staged into release bundle',
          commandId: prep.logCommandId,
        });
      } catch (error) {
        const errMsg = (error as Error).message;
        automationResults.push({ programId, success: false, message: errMsg });
        return {
          success: false,
          message: `Automation program ${programId} staging failed: ${errMsg}. Bundle aborted — nothing published.`,
          automationResults,
        };
      }
    }

    // Step 2: stage the SCADA package artifact
    let packageRef: ReleaseBundleArtifactRef;
    try {
      packageRef = await this.prepareScadaPackageBundleArtifact(pkg, device, tenantId, userId);
      artifactRefs.push(packageRef);
    } catch (error) {
      const errMsg = (error as Error).message;
      return {
        success: false,
        message: `SCADA package staging failed: ${errMsg}. Bundle aborted — nothing published.`,
        automationResults,
        scadaResult: { packageId, success: false, message: errMsg },
      };
    }

    // Step 3: signed manifest + transactional PENDING row + outbox event
    const bundleId = randomUUID();
    const commandId = randomUUID();
    const previous = await releaseBundleService.findLastConfirmed(tenantId, device.id);
    const manifest: ReleaseBundleManifest = { bundleId, artifacts: artifactRefs };
    const manifestSha256 = createHash('sha256')
      .update(canonicalJsonStringify(manifest))
      .digest('hex');
    const signature = deploySigningService.signDeployArtifact(
      'bundle',
      tenantId,
      manifestSha256,
    );
    if (!signature) {
      throw new BadRequestException(
        'Deploy signing became unavailable while building the bundle',
      );
    }

    await this.scadaPackageRepository.manager.transaction(async (manager) => {
      await releaseBundleService.createPending(
        tenantId,
        {
          bundleId,
          deviceId: device.id,
          commandId,
          manifest,
          manifestSha256,
          signature,
          previousBundleId: previous?.id,
          createdBy: userId,
        },
        manager,
      );
      await outboxPublisher.enqueue(
        {
          ...createBaseEvent('DeployBundleRequested', tenantId),
          bundleId,
          deviceId: device.id,
          commandId,
        },
        manager,
        { aggregateId: bundleId },
      );
    });

    this.logger.log(
      `Release bundle ${bundleId} committed for device ${device.deviceCode} ` +
        `(${artifactRefs.length} artifact(s), command ${commandId}) — outbox will dispatch`,
    );

    return {
      success: true,
      message:
        `Release bundle ${bundleId} queued for ${device.deviceCode}: ` +
        `${programIds.length} program(s) + SCADA package. ` +
        'The edge acks staged → confirmed; package status flips to PUBLISHED on confirmation.',
      automationResults,
      scadaResult: {
        packageId,
        success: true,
        message: `Staged into release bundle (artifact ${packageRef.artifactId})`,
      },
    };
  }

  /**
   * Snapshot + validate + log the SCADA package for a bundle — everything
   * `deployScadaPackageToEdge` does EXCEPT the MQTT publish and the
   * premature PUBLISHED flip (the package becomes PUBLISHED only when the
   * edge CONFIRMS the bundle).
   */
  private async prepareScadaPackageBundleArtifact(
    pkg: ScadaPackage,
    device: { id: string; deviceCode: string },
    tenantId: string,
    userId?: string,
  ): Promise<ReleaseBundleArtifactRef> {
    if (!this.artifactService) {
      throw new BadRequestException(
        'Artifact service not available — bundle deploys require the content-addressed store',
      );
    }

    await this.validateAutomationBindings(pkg);

    const packageDoc = upcastScadaPackageDoc(pkg.packageData, {
      deviceCode: device.deviceCode,
    });
    if (!validateScadaPackageDocV2(packageDoc)) {
      throw new BadRequestException(
        `packageData failed ScadaPackageDocV2 validation: ${formatValidationErrors(validateScadaPackageDocV2)}`,
      );
    }

    // Edge widget transform (CONTRACT-H-002) — same ordering as the
    // single-command path: after upcast, before the tag gate.
    const { doc: edgeDoc } = this.transformForEdgeOrThrow(
      `bundle package ${pkg.id}`,
      packageDoc,
    );
    if (!validateEdgeScadaPackageDoc(edgeDoc)) {
      throw new BadRequestException(
        `bundle package failed edge-deploy validation: ${formatValidationErrors(validateEdgeScadaPackageDoc)}`,
      );
    }

    // Tag SSoT gate (WF-003) — same coverage as the single-command path.
    if (this.tagResolutionService) {
      const tagNames = this.collectWidgetTagNames(edgeDoc);
      if (tagNames.length > 0) {
        const refs = tagNames.map((name) => `${device.deviceCode}/${name}`);
        const resolution = await this.tagResolutionService.resolve(tenantId, refs);
        this.handleUnresolvedBindings(`bundle package ${pkg.id}`, resolution.unresolved, refs.length);
      }
    }

    const artifact = await this.artifactService.snapshot(tenantId, {
      artifactType: DeployArtifactType.SCADA_PACKAGE,
      // Bundle artifacts also archive EXACTLY what ships (the transformed
      // edge doc) — the edge stages this content verbatim on confirmation.
      content: edgeDoc,
      schemaVersion: edgeDoc.meta.schemaVersion,
      sourceEntityId: pkg.id,
      sourceEntityVersion: pkg.version,
      createdBy: userId,
    });

    const logCommandId = randomUUID();
    if (this.scadaDeployLogService) {
      await this.scadaDeployLogService.createLog({
        tenantId,
        packageId: pkg.id,
        deviceId: device.id,
        commandId: logCommandId,
        version: pkg.version,
        deployedBy: userId,
        artifactId: artifact.id,
        checksumSha256: artifact.contentSha256,
      });
    }

    return {
      artifactId: artifact.id,
      kind: DeployArtifactType.SCADA_PACKAGE,
      sha256: artifact.contentSha256,
      sourceEntityId: pkg.id,
      logCommandId,
      version: pkg.version,
    };
  }
}

// ==========================================================================
// Interfaces
// ==========================================================================

/** Per-device outcome of the best-effort undeploy fan-out on delete (WF-011). */
export interface UndeployDeviceResult {
  deviceId: string;
  sent: boolean;
  message: string;
}

/** Result of deleteScadaPackage: archive always happens; undeploy is per-device. */
export interface DeleteScadaPackageResult {
  archived: boolean;
  undeploy: UndeployDeviceResult[];
}

/** Shape of a single automation binding in packageData.meta.automationBindings */
interface AutomationBinding {
  programId: string;
  variableId?: string;
  boundWidgetId?: string;
}

/** Result for a single automation program deployment step */
export interface AutomationDeployStepResult {
  programId: string;
  success: boolean;
  message?: string;
  commandId?: string;
}

/** Combined result for unified SCADA + Automation deployment */
export interface UnifiedDeployResult {
  success: boolean;
  message: string;
  automationResults: AutomationDeployStepResult[];
  scadaResult?: {
    packageId: string;
    success: boolean;
    message?: string;
  };
}
