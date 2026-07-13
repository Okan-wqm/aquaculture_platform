/**
 * Frontend-Backend Contract Validation Test
 *
 * Sprint 4 Fix - Grup Y (H12/46)
 * ---------------------------------
 * Bu test, admin-panel frontend'inin cagirdigi API endpoint'leri ile
 * admin-api-service backend'inin sundugu endpoint'lerin uyumunu dogrular.
 *
 * Problem: 3 FIELD_MISMATCH production'da 400/404 uretiyordu ama CI/CD yakalayamiyordu.
 * Cozum: Statik analiz ile frontend URL pattern'lerini ve backend controller path'lerini
 *         extract edip, eslesme kontrolu yapan otomatik test.
 *
 * Yaklasim:
 * - Frontend: services/api/*.ts dosyalarindan apiFetch cagrilarindaki URL pattern'leri cikarilir
 * - Backend: Controller dekoratorlerinden (@Get, @Post, vb.) endpoint path'leri cikarilir
 * - Eslesme: Her frontend URL'in backend'de bir karsiligi olmali
 *
 * Bakim notu: Yeni endpoint eklendiginde veya mevcut path degistiginde bu test kirilir.
 * Bu beklenen ve istenen davranistir -- kontrat degisiklikleri bilinmeli.
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

interface FrontendEndpoint {
  url: string;
  method: string;
  source: string; // api dosya adi
  functionName: string;
}

interface BackendEndpoint {
  path: string;
  method: string;
  controller: string;
  handler: string;
}

// ============================================================================
// Frontend URL Extraction
// ============================================================================

/**
 * Frontend API dosyalarindan apiFetch cagrilarindaki URL pattern'lerini cikarir.
 * Template literal'ler normalize edilir: ${param} -> :param
 */
function extractFrontendEndpoints(): FrontendEndpoint[] {
  const apiDir = path.resolve(
    __dirname,
    '../../../../web/modules/admin-panel/src/services/api',
  );

  if (!fs.existsSync(apiDir)) {
    throw new Error(`Frontend API directory not found: ${apiDir}`);
  }

  const endpoints: FrontendEndpoint[] = [];
  const apiFiles = fs.readdirSync(apiDir).filter(f => f.endsWith('.ts'));

  for (const file of apiFiles) {
    const content = fs.readFileSync(path.join(apiDir, file), 'utf-8');
    const source = file.replace('.ts', '');

    // Cagri-basina cikarim: her apiFetch cagrisinin DENGELI parantez araligi
    // taranir; URL ilk argumandan, method AYNI cagrinin options'indan okunur.
    // (Onceki kayan 5-satir pencere komsu cagrinin method'unu yanlis atfediyor
    // ve ayni cagriyi ust uste pencerelerde tekrar yakaliyordu.)
    const callRegex = /apiFetch\s*(?:<)?/g;
    let callMatch: RegExpExecArray | null;
    while ((callMatch = callRegex.exec(content)) !== null) {
      const span = extractCallSpan(content, callMatch.index);
      if (!span) continue;

      const urlMatch = span.match(/^apiFetch\s*(?:<[^(]*?>)?\s*\(\s*(?:'([^']*)'|`([^`]*)`)/s);
      if (!urlMatch) continue;
      const rawUrl = urlMatch[1] ?? urlMatch[2] ?? '';
      const url = normalizeUrl(rawUrl);
      if (!url || !url.startsWith('/')) continue;

      const method = extractMethod(span);
      const functionName = findEnclosingFunctionName(content, callMatch.index);

      if (!endpoints.find(e => e.url === url && e.method === method && e.source === source)) {
        endpoints.push({ url, method, source, functionName });
      }
    }

    // ADMIN_API_URL concat: `${ADMIN_API_URL}/path...` (download link builder'lari)
    const adminApiRegex = /`\$\{ADMIN_API_URL\}([^`]+)`/g;
    let adminApiMatch: RegExpExecArray | null;
    while ((adminApiMatch = adminApiRegex.exec(content)) !== null) {
      const url = normalizeUrl(adminApiMatch[1]!);
      const functionName = findEnclosingFunctionName(content, adminApiMatch.index);
      if (url && !endpoints.find(e => e.url === url && e.method === 'GET' && e.source === source)) {
        endpoints.push({ url, method: 'GET', source, functionName });
      }
    }
  }

  return endpoints;
}

/**
 * `startIndex`teki apiFetch token'indan baslayarak cagrinin dengeli parantez
 * araligini dondurur (generic <...> kismi dahil). String/template literal
 * icindeki parantezler sayilmaz.
 */
function extractCallSpan(content: string, startIndex: number): string | null {
  const openParen = content.indexOf('(', startIndex);
  if (openParen === -1) return null;

  let depth = 0;
  let inSingle = false;
  let inTemplate = false;
  for (let i = openParen; i < content.length; i++) {
    const ch = content[i]!;
    const prev = content[i - 1];
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '`' && prev !== '\\') inTemplate = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '`') { inTemplate = true; continue; }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return content.substring(startIndex, i + 1);
    }
  }
  return null;
}

/**
 * Cagri index'inden GERIYE dogru tarayip en yakin `fnName: (...) =>` veya
 * `fnName: function` tanimini bulur (rapor icin; eslestirmeye etkisi yok).
 */
function findEnclosingFunctionName(content: string, callIndex: number): string {
  const before = content.substring(0, callIndex);
  const fnRegex = /^\s*(\w+)\s*[:=]\s*(?:\(|function|async\s*\()/gm;
  let name = 'unknown';
  let match: RegExpExecArray | null;
  while ((match = fnRegex.exec(before)) !== null) {
    name = match[1]!;
  }
  return name;
}

/**
 * URL'i normalize eder:
 * - Query string'leri (?...) kaldirir
 * - Template literal parametrelerini (${...}) :param'a cevirir
 * - Trailing slash kaldirir
 * - encodeURIComponent(...) kaldır
 */
function normalizeUrl(rawUrl: string): string {
  // ONCE ${...} ifadelerini :param'a cevir — ic ice backtick/brace icerebilen
  // kosullu query ifadeleri (`${x ? `?a=${x}` : ''}`) icin dengeli tarama.
  let url = replaceTemplateExpressions(rawUrl);

  // Sonra query string'i kaldir (artik ${} ici '?' karakterleri temizlendi)
  url = url.split('?')[0]!;

  // Trailing slash kaldir
  url = url.replace(/\/+$/, '');

  // Bos path segment'leri temizle
  url = url.replace(/\/+/g, '/');

  // Sondaki cikma :param'lar query-builder kalintisiysa temizle: '/x/:param'
  // gercek path parametresi olabilir, dokunma. Sadece '/:param' ile BASLAYAN
  // veya bos kalan URL'leri ele.
  return url;
}

/**
 * `${...}` ifadelerini dengeli brace/backtick taramasiyla :param'a cevirir.
 * Sablon ici sablonlar (`${a ? `?b=${c}` : ''}`) tek :param'a iner; query
 * builder cagrilari (`${buildQueryString(...)}`) bos stringe iner.
 */
function replaceTemplateExpressions(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input[i] === '$' && input[i + 1] === '{') {
      const exprStart = i + 2;
      let depth = 1;
      let j = exprStart;
      while (j < input.length && depth > 0) {
        if (input[j] === '{') depth++;
        else if (input[j] === '}') depth--;
        j++;
      }
      const expr = input.substring(exprStart, j - 1);
      // Query-builder ifadeleri path'e katki yapmaz
      if (/buildQueryString|URLSearchParams/.test(expr) || expr.includes('?')) {
        // Kosullu query eki (`${x ? `?...` : ''}`) veya builder: path disi
        out += '';
      } else {
        out += ':param';
      }
      i = j;
      continue;
    }
    out += input[i];
    i++;
  }
  return out;
}

/**
 * apiFetch cagrisindaki HTTP method'u cikarir.
 * Varsayilan: GET
 */
function extractMethod(chunk: string): string {
  const methodMatch = chunk.match(/method:\s*'(GET|POST|PUT|PATCH|DELETE)'/);
  return methodMatch ? methodMatch[1]! : 'GET';
}

// ============================================================================
// Backend Endpoint Extraction
// ============================================================================

/**
 * Backend controller dosyalarindan decorator-tabanli endpoint path'lerini cikarir.
 * @Controller('prefix') + @Get('sub') => /prefix/sub
 */
function extractBackendEndpoints(): BackendEndpoint[] {
  const srcDir = path.resolve(__dirname, '..');
  const endpoints: BackendEndpoint[] = [];

  // Controller dosyalarini bul
  const controllerFiles = findControllerFiles(srcDir);

  for (const filePath of controllerFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(srcDir, filePath);

    // Bir dosyada BIRDEN FAZLA controller olabilir (tenant.controller.ts:
    // 'tenants' + 'admin/tenants'). Her @Controller bloğu kendi prefix'iyle
    // taranir; onceki tek-prefix cikarim ikinci controller'in tum route'larini
    // ilk prefix'e atfediyordu.
    const controllerBlocks: Array<{ prefix: string; body: string }> = [];
    const ctrlRegex = /@Controller\(\s*(?:'([^']*)')?\s*\)/g;
    const ctrlMatches: Array<{ prefix: string; index: number }> = [];
    let ctrlMatch: RegExpExecArray | null;
    while ((ctrlMatch = ctrlRegex.exec(content)) !== null) {
      ctrlMatches.push({ prefix: ctrlMatch[1] ? `/${ctrlMatch[1]}` : '', index: ctrlMatch.index });
    }
    for (let c = 0; c < ctrlMatches.length; c++) {
      const start = ctrlMatches[c]!.index;
      const end = c + 1 < ctrlMatches.length ? ctrlMatches[c + 1]!.index : content.length;
      controllerBlocks.push({ prefix: ctrlMatches[c]!.prefix, body: content.substring(start, end) });
    }
    if (controllerBlocks.length === 0) {
      controllerBlocks.push({ prefix: '', body: content });
    }

    for (const { prefix: controllerPrefix, body } of controllerBlocks) {
    // HTTP method dekoratorlerini tara
    const decoratorRegex = /@(Get|Post|Put|Patch|Delete)\s*\(\s*(?:'([^']*)'|`([^`]*)`)?(?:\s*,\s*\{[^}]*\})?\s*\)/g;
    let match;

    while ((match = decoratorRegex.exec(body)) !== null) {
      const httpMethod = match[1]!.toUpperCase();
      const subPath = match[2] ?? match[3] ?? '';

      // Handler method adini bul (dekoratorun hemen sonrasindaki async/method)
      const decoratorEnd = match.index! + match[0].length;
      const afterDecorator = body.substring(decoratorEnd, decoratorEnd + 500);
      const handlerMatch = afterDecorator.match(/(?:async\s+)?(\w+)\s*\(/);
      const handlerName = handlerMatch ? handlerMatch[1]! : 'unknown';

      // Full path olustur
      let fullPath = controllerPrefix;
      if (subPath) {
        fullPath += `/${subPath}`;
      }
      // Path'i normalize et
      fullPath = fullPath.replace(/\/+/g, '/');
      if (!fullPath.startsWith('/')) {
        fullPath = '/' + fullPath;
      }
      // Trailing slash kaldir
      fullPath = fullPath.replace(/\/+$/, '');

      // NestJS path parameter'lerini normalize et: :param zaten :param formunda
      // Ama bazen :id gibi isimler var, bunlari koruyalim

      endpoints.push({
        path: fullPath,
        method: httpMethod,
        controller: relativePath,
        handler: handlerName,
      });
    }
    }
  }

  return endpoints;
}

/**
 * src altindaki tum *.controller.ts dosyalarini recursive bulur.
 */
function findControllerFiles(dir: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // node_modules ve test dizinlerini atla
      if (entry.name !== 'node_modules' && entry.name !== '__tests__') {
        results.push(...findControllerFiles(fullPath));
      }
    } else if (entry.name.endsWith('.controller.ts')) {
      results.push(fullPath);
    }
  }

  return results;
}

// ============================================================================
// Path Matching
// ============================================================================

/**
 * Frontend URL'inin backend endpoint'iyle eslesip eslesmedigini kontrol eder.
 *
 * Frontend: /tenants/:param/notes/:param   (template literal'den normalize edilmis)
 * Backend:  /tenants/:id/notes/:noteId      (NestJS param dekoratoru)
 *
 * Her ikisinde de :xxx segmentleri parametre olarak kabul edilir.
 */
function matchPath(frontendUrl: string, backendPath: string): boolean {
  const feParts = frontendUrl.split('/').filter(Boolean);
  const beParts = backendPath.split('/').filter(Boolean);

  if (feParts.length !== beParts.length) return false;

  for (let i = 0; i < feParts.length; i++) {
    const fe = feParts[i]!;
    const be = beParts[i]!;

    // Her ikisi de parametre ise eslestir
    if (fe.startsWith(':') && be.startsWith(':')) continue;

    // Karisik eslesme YOK (ADMIN-HIGH-011 sinifi): statik FE segmenti backend
    // :param'ina eslestirmek, /system/jobs/scheduled -> @Get(':id') gibi
    // yanlis-handler yonlendirmelerini gizler; FE :param'ini statik backend
    // segmentine eslestirmek de sablon degiskenini sabit bir yuvaya koyar.
    if (fe.startsWith(':') || be.startsWith(':')) return false;

    // Statik segmentler eslesiyorsa devam
    if (fe === be) continue;

    // Eslesmiyor
    return false;
  }

  return true;
}

/**
 * Iki endpoint'in hem path hem method olarak eslesmesini kontrol eder.
 * PATCH ve PUT her ikisi de eslestirilebilir (frontend PUT kullansa backend PATCH de olabilir).
 */
function matchEndpoint(fe: FrontendEndpoint, be: BackendEndpoint): boolean {
  if (!matchPath(fe.url, be.path)) return false;

  // Method eslesmesi
  if (fe.method === be.method) return true;

  // PATCH/PUT uyumlulugu
  if (
    (fe.method === 'PATCH' && be.method === 'PUT') ||
    (fe.method === 'PUT' && be.method === 'PATCH')
  ) {
    return true;
  }

  return false;
}

// ============================================================================
// Bilinen istisnalar
// ============================================================================

/**
 * Bazi frontend endpoint'leri dogrudan backend controller'a eslesmedigi
 * bilinen durumlar. Bu URL'ler test'den hariç tutulur.
 *
 * Her bir istisna icin neden aciklanir.
 */
const KNOWN_EXCEPTIONS: Array<{ url: string; method: string; reason: string }> = [
  // Frontend'de /analytics/geographic var ama backend'de ayri endpoint yok,
  // analyticsService.getGeographicDistribution() dahili data donduruyor

  // Frontend export URL'leri: bunlar ADMIN_API_URL ile build edilir, dogrudan download link'i

  // Frontend /analytics/usage/api calls backend /analytics/usage + query

  // Frontend /analytics/engagement* endpoints -- backend returns data from service methods

  // Frontend /database/monitoring/stats -> backend /database/monitoring/health

  // Frontend /database/monitoring/tables -> backend /database/monitoring/storage/by-tenant

  // Frontend /database/monitoring/vacuum and /database/monitoring/analyze

  // Frontend /database/schemas/:param/optimize and /database/schemas/:param/analyze

  // Database migration frontend vs backend path mismatch

  // Database backup frontend expects different paths

  // Security activities export - frontend uses GET with query, backend uses POST

  // Security activities/user/:userId - frontend path

  // Security audit entity path

  // Security audit retention policy run by ID

  // Compliance dashboard

  // Compliance reports generate

  // Security monitoring events resolve

  // Security monitoring incidents create/update/timeline

  // Security monitoring threat-intelligence block/unblock

  // Security monitoring health-score (frontend path vs controller)

  // Impersonation permissions check via query params

  // Impersonation sessions actions (frontend uses /actions, backend uses /log-action)

  // Feature toggle key lookup

  // Feature toggle toggle action

  // System performance endpoints

  // System error tracking endpoints

  // System job queue endpoints

  // Email template preview uses POST in frontend, GET in backend

  // Settings webhook test

  // Frontend /support/tickets PATCH vs backend PUT

  // Support ticket close
];

/**
 * Bilinen istisna mi kontrol eder.
 */
function isKnownException(fe: FrontendEndpoint): boolean {
  return KNOWN_EXCEPTIONS.some(
    exc => matchPath(fe.url, exc.url) && fe.method === exc.method,
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('Frontend-Backend Contract Validation', () => {
  let frontendEndpoints: FrontendEndpoint[];
  let backendEndpoints: BackendEndpoint[];

  beforeAll(() => {
    frontendEndpoints = extractFrontendEndpoints();
    backendEndpoints = extractBackendEndpoints();
  });

  // --------------------------------------------------------------------------
  // Temel saglik kontrolleri
  // --------------------------------------------------------------------------

  it('should extract frontend endpoints', () => {
    expect(frontendEndpoints.length).toBeGreaterThan(0);
    // En az 50 endpoint bekleniyor (14 dosya, her biri birden fazla endpoint)
    expect(frontendEndpoints.length).toBeGreaterThan(50);
  });

  it('should extract backend endpoints', () => {
    expect(backendEndpoints.length).toBeGreaterThan(0);
    expect(backendEndpoints.length).toBeGreaterThan(50);
  });

  // --------------------------------------------------------------------------
  // Domain bazli kontrat testleri
  // --------------------------------------------------------------------------

  const domainTests = [
    { domain: 'system', description: 'System Metrics API' },
    { domain: 'analytics', description: 'Analytics API' },
    { domain: 'tenants', description: 'Tenants API' },
    { domain: 'users', description: 'Users API' },
    { domain: 'modules', description: 'Modules API' },
    { domain: 'audit-logs', description: 'Audit Logs API' },
    { domain: 'billing', description: 'Billing API' },
    { domain: 'reports', description: 'Reports API' },
    { domain: 'support', description: 'Support API' },
    { domain: 'settings', description: 'Settings API' },
    { domain: 'impersonation', description: 'Impersonation API' },
    { domain: 'debug', description: 'Debug Tools API' },
    { domain: 'security', description: 'Security API' },
    { domain: 'health', description: 'Health API' },
    { domain: 'database', description: 'Database Management API' },
  ];

  for (const { domain, description } of domainTests) {
    it(`should have backend endpoints for ${description} (/${domain}/*)`, () => {
      const domainFrontend = frontendEndpoints.filter(fe =>
        fe.url.startsWith(`/${domain}/`) || fe.url === `/${domain}`,
      );

      // Bos domain'leri atla
      if (domainFrontend.length === 0) return;

      const mismatches: string[] = [];

      for (const fe of domainFrontend) {
        if (isKnownException(fe)) continue;

        const hasMatch = backendEndpoints.some(be => matchEndpoint(fe, be));
        if (!hasMatch) {
          mismatches.push(
            `  ${fe.method} ${fe.url} (from ${fe.source}.ts::${fe.functionName})`,
          );
        }
      }

      if (mismatches.length > 0) {
        fail(
          `${mismatches.length} frontend endpoint(s) in /${domain}/* have no backend match:\n${mismatches.join('\n')}`,
        );
      }
    });
  }

  // --------------------------------------------------------------------------
  // Kritik endpoint'ler icin ozel testler (H12 bulgulari)
  // --------------------------------------------------------------------------

  describe('H12 Critical Path Endpoints', () => {
    it('settings key path: backend exposes /settings/key/:key and no FE call uses the pre-H19 shape', () => {
      // Post main-merge: the admin-panel migrated generic settings-by-key reads
      // to the platform-configuration API (SystemSettingsPage), so the FE no
      // longer calls /settings/key/:key. The backend route remains a triaged
      // orphan, which the directional parity invariant permits (it only forbids
      // FE calls without a backend route, not backend routes without an FE
      // caller). Preserve the H19 regression guard: no FE call may target the
      // pre-fix /settings/:key shape.
      const be = backendEndpoints.find(
        e => matchPath(e.path, '/settings/key/:key') && e.method === 'GET',
      );
      expect(be).toBeDefined();

      const preFixMismatch = frontendEndpoints.find(
        e => e.url === '/settings/:param' && e.method === 'GET',
      );
      expect(preFixMismatch).toBeUndefined();
    });

    it('announcement unpublish should use /cancel path', () => {
      // H18 fix: frontend unpublish -> /support/announcements/:id/cancel
      const fe = frontendEndpoints.find(
        e => e.url === '/support/announcements/:param/cancel' && e.method === 'POST',
      );
      expect(fe).toBeDefined();

      const be = backendEndpoints.find(
        e => matchPath(e.path, '/support/announcements/:id/cancel') && e.method === 'POST',
      );
      expect(be).toBeDefined();
    });

    it('impersonation revoke should use /terminate path', () => {
      // H21 fix: frontend revokeSession -> /impersonation/sessions/:id/terminate
      const fe = frontendEndpoints.find(
        e => e.url === '/impersonation/sessions/:param/terminate' && e.method === 'POST',
      );
      expect(fe).toBeDefined();

      const be = backendEndpoints.find(
        e => matchPath(e.path, '/impersonation/sessions/:id/terminate') && e.method === 'POST',
      );
      expect(be).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // HTTP method uyumlulugu
  // --------------------------------------------------------------------------

  it('should not have method mismatches for matched paths', () => {
    const methodMismatches: string[] = [];

    for (const fe of frontendEndpoints) {
      if (isKnownException(fe)) continue;

      // Ayni path'e sahip ama farkli method'lu backend endpoint var mi?
      const pathMatches = backendEndpoints.filter(be => matchPath(fe.url, be.path));
      if (pathMatches.length === 0) continue; // Path eslesmediyse zaten baska test yakalayacak

      const methodMatch = pathMatches.some(be => {
        if (be.method === fe.method) return true;
        // PATCH/PUT uyumlulugu
        if (
          (fe.method === 'PATCH' && be.method === 'PUT') ||
          (fe.method === 'PUT' && be.method === 'PATCH')
        ) {
          return true;
        }
        return false;
      });

      if (!methodMatch) {
        const beMethods = pathMatches.map(be => be.method).join(',');
        methodMismatches.push(
          `  ${fe.method} ${fe.url} -> backend has [${beMethods}] (from ${fe.source}.ts)`,
        );
      }
    }

    if (methodMismatches.length > 0) {
      fail(
        `${methodMismatches.length} HTTP method mismatch(es):\n${methodMismatches.join('\n')}`,
      );
    }
  });

  // --------------------------------------------------------------------------
  // Snapshot: endpoint listesinin snapshot'ini tut
  // --------------------------------------------------------------------------

  it('backend endpoint snapshot should be up to date', () => {
    // Backend endpoint sayisi belirli bir aralikte olmali.
    // Yeni endpoint eklendiginde veya kaldirildiginda bu test guncellenmeli.
    // Bu, beklenmedik endpoint degisikliklerini yakalar.
    const count = backendEndpoints.length;

    // Minimum ve maximum beklenen endpoint sayisi
    // Guncelleme: coklu-@Controller dosyalari artik dogru taraniyor
    // (tenant.controller.ts 'tenants' + 'admin/tenants') — ~600 endpoint.
    expect(count).toBeGreaterThan(400);
    expect(count).toBeLessThan(900);
  });

  it('frontend endpoint snapshot should be up to date', () => {
    const count = frontendEndpoints.length;

    // Frontend'den ~200-350 endpoint bekleniyor
    expect(count).toBeGreaterThan(150);
    expect(count).toBeLessThan(500);
  });

  // --------------------------------------------------------------------------
  // Raporlama: eslesmeyenleri listele (bilgi amacli, test basarisiz degilse)
  // --------------------------------------------------------------------------

  it('should report all known exceptions for review', () => {
    // Bu test her zaman basarili olur ama eslesmeyenleri loglar
    const unmatched: string[] = [];

    for (const fe of frontendEndpoints) {
      if (isKnownException(fe)) continue;

      const hasMatch = backendEndpoints.some(be => matchEndpoint(fe, be));
      if (!hasMatch) {
        unmatched.push(`${fe.method} ${fe.url} (${fe.source}::${fe.functionName})`);
      }
    }

    // Eslesmeyenleri bilgi amacli logla
    if (unmatched.length > 0) {
      console.warn(
        `\n[Contract Validation] ${unmatched.length} unmatched frontend endpoint(s) (not in known exceptions):\n` +
          unmatched.map(u => `  - ${u}`).join('\n'),
      );
    }

    // Eslesmeyenlerin sayisi 0 olmali (tum eslesmeyenler bilinen istisnalarda olmali)
    expect(unmatched).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Bayat istisna korumasi (tier-3): allowlist curumesini engeller
  // --------------------------------------------------------------------------

  it('every known exception must still shield a real, unmatched frontend endpoint', () => {
    // Bir istisna ya (a) hicbir FE endpoint'ine denk gelmiyorsa ya da (b) denk
    // geldigi FE endpoint'i artik backend'de karsiligi olan bir cagri ise
    // BAYATTIR ve listeden cikarilmalidir. Bayat istisnalar allowlist'i
    // buyuterek gercek kirik cagrilarin gizlenmesine zemin hazirlar
    // (ADMIN-HIGH-011 bu curumeyle uretime sizdi).
    const stale: string[] = [];

    for (const exc of KNOWN_EXCEPTIONS) {
      const shielded = frontendEndpoints.filter(
        fe => matchPath(fe.url, exc.url) && fe.method === exc.method,
      );
      if (shielded.length === 0) {
        stale.push(`${exc.method} ${exc.url} — no frontend endpoint uses this exception`);
        continue;
      }
      const allMatched = shielded.every(fe =>
        backendEndpoints.some(be => matchEndpoint(fe, be)),
      );
      if (allMatched) {
        stale.push(`${exc.method} ${exc.url} — backend match now exists; exception is obsolete`);
      }
    }

    expect(stale).toEqual([]);
  });
});
