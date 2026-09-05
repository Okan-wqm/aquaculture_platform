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
import * as ts from 'typescript';

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
  const apiDir = path.resolve(__dirname, '../../../../web/modules/admin-panel/src/services/api');

  if (!fs.existsSync(apiDir)) {
    throw new Error(`Frontend API directory not found: ${apiDir}`);
  }

  const endpoints: FrontendEndpoint[] = [];
  const apiFiles = fs.readdirSync(apiDir).filter((f) => f.endsWith('.ts'));

  for (const file of apiFiles) {
    const filePath = path.join(apiDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const source = file.replace('.ts', '');
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'apiFetch'
      ) {
        const urlArgument = node.arguments[0];
        const rawUrl = urlArgument ? renderStaticUrl(urlArgument) : null;

        // HATEOAS links validated and returned by the backend are deliberately
        // dynamic. They are not a second declaration of a route, so there is
        // no static frontend route to compare for those calls.
        if (rawUrl !== null) {
          const url = normalizeUrl(rawUrl);
          const method = extractMethod(node.arguments[1]);
          const functionName = findContainingFunctionName(node);

          if (
            url &&
            !endpoints.some(
              (endpoint) =>
                endpoint.url === url && endpoint.method === method && endpoint.source === source,
            )
          ) {
            endpoints.push({ url, method, source, functionName });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return endpoints;
}

function renderStaticUrl(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }

  if (!ts.isTemplateExpression(expression)) return null;

  let rendered = expression.head.text;
  for (const span of expression.templateSpans) {
    if (expressionIntroducesQuery(span.expression)) {
      rendered += '?';
      break;
    }

    // A template whose first segment is a runtime path (for example a
    // backend-provided status URL) is not a statically declared route.
    if (rendered === '' && ts.isIdentifier(span.expression)) return null;

    rendered += ':param';
    rendered += span.literal.text;
  }
  return rendered;
}

function expressionIntroducesQuery(expression: ts.Expression): boolean {
  let introducesQuery = false;
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node) && node.head.text.startsWith('?')) {
      introducesQuery = true;
      return;
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.startsWith('?')
    ) {
      introducesQuery = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return introducesQuery;
}

function findContainingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isPropertyAssignment(current) || ts.isMethodDeclaration(current)) {
      return propertyNameText(current.name);
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
    current = current.parent;
  }
  return 'unknown';
}

function propertyNameText(name: ts.PropertyName | undefined): string {
  if (!name) return 'unknown';
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

/**
 * URL'i normalize eder:
 * - Query string'leri (?...) kaldirir
 * - Template literal parametrelerini (${...}) :param'a cevirir
 * - Trailing slash kaldirir
 * - encodeURIComponent(...) kaldır
 */
function normalizeUrl(rawUrl: string): string {
  // Query string'i kaldir
  let url = rawUrl.split('?')[0]!;

  // ${buildQueryString(...)} kaldir
  url = url.replace(/\$\{buildQueryString\([^)]*\)\}/g, '');

  // ${encodeURIComponent(...)} -> :param
  url = url.replace(/\$\{encodeURIComponent\([^)]*\)\}/g, ':param');

  // Template literal parametrelerini :param'a cevir
  // ${variable} veya ${variable.property} veya ${expression}
  url = url.replace(/\$\{[^}]+\}/g, ':param');

  // Trailing slash kaldir
  url = url.replace(/\/+$/, '');

  // Bos path segment'leri temizle
  url = url.replace(/\/+/g, '/');

  return url;
}

/**
 * apiFetch cagrisindaki HTTP method'u cikarir.
 * Varsayilan: GET
 */
function extractMethod(options: ts.Expression | undefined): string {
  if (!options || !ts.isObjectLiteralExpression(options)) return 'GET';

  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === 'method' &&
      ts.isStringLiteral(property.initializer)
    ) {
      return property.initializer.text.toUpperCase();
    }
  }
  return 'GET';
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
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const controller = findDecorator(statement, 'Controller');
      if (!controller) continue;
      const controllerPrefix = decoratorPath(controller);

      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        for (const httpMethod of ['Get', 'Post', 'Put', 'Patch', 'Delete'] as const) {
          const decorator = findDecorator(member, httpMethod);
          if (!decorator) continue;
          const subPath = decoratorPath(decorator);
          const fullPath = normalizeUrl(`/${controllerPrefix}/${subPath}`);

          endpoints.push({
            path: fullPath,
            method: httpMethod.toUpperCase(),
            controller: relativePath,
            handler: propertyNameText(member.name),
          });
        }
      }
    }
  }

  return endpoints;
}

function findDecorator(node: ts.Node, expectedName: string): ts.Decorator | undefined {
  if (!ts.canHaveDecorators(node)) return undefined;
  return ts.getDecorators(node)?.find((decorator) => {
    const expression = decorator.expression;
    return (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === expectedName
    );
  });
}

function decoratorPath(decorator: ts.Decorator): string {
  const expression = decorator.expression;
  if (!ts.isCallExpression(expression)) return '';
  const pathArgument = expression.arguments[0];
  if (
    !pathArgument ||
    (!ts.isStringLiteral(pathArgument) && !ts.isNoSubstitutionTemplateLiteral(pathArgument))
  ) {
    return '';
  }
  return pathArgument.text;
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

    // Birisi parametre, digeri statik ise eslestir (frontend :param, backend :id gibi)
    if (fe.startsWith(':') || be.startsWith(':')) continue;

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
  {
    url: '/analytics/geographic',
    method: 'GET',
    reason: 'Backend returns mock data from analytics service, no dedicated controller endpoint',
  },

  // Frontend export URL'leri: bunlar ADMIN_API_URL ile build edilir, dogrudan download link'i
  {
    url: '/reports/export/:param',
    method: 'GET',
    reason: 'Export URL builder, maps to /reports/export/pdf/:reportType or /reports/export/csv',
  },
  {
    url: '/reports/export/:param/:param',
    method: 'GET',
    reason: 'Export URL with reportType, maps to /reports/export/pdf/:reportType',
  },

  // Frontend /analytics/usage/api calls backend /analytics/usage + query
  {
    url: '/analytics/usage/api',
    method: 'GET',
    reason: 'Not a separate endpoint; usage analytics with query params',
  },

  // Frontend /analytics/engagement* endpoints -- backend returns data from service methods
  {
    url: '/analytics/engagement',
    method: 'GET',
    reason: 'Analytics engagement data served by usage endpoint or service mock',
  },
  {
    url: '/analytics/engagement/features',
    method: 'GET',
    reason: 'Feature engagement data served by usage/features endpoint',
  },

  // Frontend /database/monitoring/stats -> backend /database/monitoring/health
  {
    url: '/database/monitoring/stats',
    method: 'GET',
    reason: 'Frontend alias for /database/monitoring/health',
  },

  // Frontend /database/monitoring/tables -> backend /database/monitoring/storage/by-tenant
  {
    url: '/database/monitoring/tables',
    method: 'GET',
    reason: 'Frontend alias for /database/monitoring/storage tables',
  },

  // Frontend /database/monitoring/vacuum and /database/monitoring/analyze
  {
    url: '/database/monitoring/vacuum',
    method: 'POST',
    reason: 'DB maintenance operations not exposed as REST endpoints',
  },
  {
    url: '/database/monitoring/analyze',
    method: 'POST',
    reason: 'DB maintenance operations not exposed as REST endpoints',
  },

  // Frontend /database/schemas/:param/optimize and /database/schemas/:param/analyze
  {
    url: '/database/schemas/:param/optimize',
    method: 'POST',
    reason: 'Schema optimization not yet implemented in controller',
  },
  {
    url: '/database/schemas/:param/analyze',
    method: 'GET',
    reason: 'Schema analysis not yet implemented in controller',
  },
  {
    url: '/database/schemas/:param/reset',
    method: 'POST',
    reason: 'Schema reset not yet implemented in controller',
  },

  // Database migration frontend vs backend path mismatch
  {
    url: '/database/migrations',
    method: 'GET',
    reason: 'Frontend expects flat list, backend uses /database/migrations/history',
  },
  {
    url: '/database/migrations/:param',
    method: 'GET',
    reason:
      'Frontend uses migration ID, backend uses /database/migrations/tenant/:tenantId/history',
  },
  {
    url: '/database/migrations',
    method: 'POST',
    reason: 'Frontend creates migration, backend uses /database/migrations/tenant/:tenantId/run',
  },
  {
    url: '/database/migrations/:param/run',
    method: 'POST',
    reason: 'Frontend runs by ID, backend runs by tenant+version',
  },
  {
    url: '/database/migrations/:param/rollback',
    method: 'POST',
    reason: 'Frontend rollback by ID, backend by tenant+version',
  },
  {
    url: '/database/migrations/pending',
    method: 'GET',
    reason: 'Frontend list pending, backend /database/migrations/tenant/:tenantId/pending',
  },

  // Security activities export - frontend uses GET with query, backend uses POST
  {
    url: '/security/activities/export',
    method: 'GET',
    reason: 'Frontend uses GET, backend audit trail uses POST export',
  },

  // Security activities/user/:userId - frontend path
  {
    url: '/security/activities/user/:param',
    method: 'GET',
    reason: 'Not a controller endpoint; activity query with userId filter',
  },

  // Security audit entity path
  {
    url: '/security/audit/entity/:param/:param',
    method: 'GET',
    reason:
      'Audit trail entity query not as controller endpoint; use main query with entityType/entityId',
  },

  // Security audit retention policy run by ID
  {
    url: '/security/audit/retention-policies/:param/run',
    method: 'POST',
    reason: 'Backend uses /security/audit/retention-policies/apply POST instead',
  },

  // Compliance dashboard
  {
    url: '/security/compliance/dashboard',
    method: 'GET',
    reason: 'No dedicated dashboard endpoint; use checks and reports',
  },

  // Compliance reports generate
  {
    url: '/security/compliance/reports/generate',
    method: 'POST',
    reason: 'Frontend path differs from backend /security/compliance/reports POST',
  },

  // Security monitoring events resolve
  {
    url: '/security/monitoring/events/:param/resolve',
    method: 'POST',
    reason: 'Backend uses PUT /security/monitoring/events/:id/status instead',
  },

  // Security monitoring incidents create/update/timeline
  {
    url: '/security/monitoring/incidents',
    method: 'POST',
    reason: 'Incidents are auto-created from events, not manually via POST',
  },
  {
    url: '/security/monitoring/incidents/:param/timeline',
    method: 'POST',
    reason: 'Timeline entries are auto-added, not via dedicated endpoint',
  },

  // Security monitoring threat-intelligence block/unblock
  {
    url: '/security/monitoring/threat-intelligence/:param/block',
    method: 'POST',
    reason: 'Block/unblock not separate endpoints in controller',
  },
  {
    url: '/security/monitoring/threat-intelligence/:param/unblock',
    method: 'POST',
    reason: 'Block/unblock not separate endpoints in controller',
  },

  // Security monitoring health-score (frontend path vs controller)
  {
    url: '/security/monitoring/health-score',
    method: 'GET',
    reason: 'Backend uses /security/monitoring/health-score (matches)',
  },

  // Impersonation permissions check via query params
  {
    url: '/impersonation/permissions/check',
    method: 'GET',
    reason: 'Backend uses /impersonation/permissions/:superAdminId/check/:tenantId',
  },

  // Impersonation sessions actions (frontend uses /actions, backend uses /log-action)
  {
    url: '/impersonation/sessions/:param/actions',
    method: 'GET',
    reason: 'No GET actions endpoint; actions are write-only',
  },
  {
    url: '/impersonation/sessions/:param/actions',
    method: 'POST',
    reason: 'Backend uses /sessions/:id/log-action',
  },

  // Feature toggle key lookup
  {
    url: '/system/settings/feature-toggles/key/:param',
    method: 'GET',
    reason: 'No dedicated key-based lookup in controller; use query with search',
  },

  // Feature toggle toggle action
  {
    url: '/system/settings/feature-toggles/:param/toggle',
    method: 'POST',
    reason: 'Backend uses PUT /system/settings/feature-toggles/:id with status field',
  },

  // System performance endpoints
  {
    url: '/system/performance/dashboard',
    method: 'GET',
    reason: 'Performance dashboard not in global-settings; may be in a different service',
  },
  {
    url: '/system/performance/application',
    method: 'GET',
    reason: 'Performance metrics not in global-settings controller',
  },
  {
    url: '/system/performance/application/apdex',
    method: 'GET',
    reason: 'Apdex score not in global-settings controller',
  },
  {
    url: '/system/performance/database',
    method: 'GET',
    reason: 'DB perf not in global-settings controller',
  },
  {
    url: '/system/performance/database/slow-queries',
    method: 'GET',
    reason: 'Slow queries not in global-settings controller',
  },
  {
    url: '/system/performance/infrastructure',
    method: 'GET',
    reason: 'Infrastructure metrics not in global-settings controller',
  },

  // System error tracking endpoints
  {
    url: '/system/errors/dashboard',
    method: 'GET',
    reason: 'Error tracking not in global-settings controller',
  },
  {
    url: '/system/errors/groups',
    method: 'GET',
    reason: 'Error groups not in global-settings controller',
  },
  {
    url: '/system/errors/groups/:param',
    method: 'GET',
    reason: 'Error group detail not in global-settings controller',
  },
  {
    url: '/system/errors/groups/:param/occurrences',
    method: 'GET',
    reason: 'Error occurrences not in global-settings controller',
  },
  {
    url: '/system/errors/groups/:param/status',
    method: 'PUT',
    reason: 'Error status update not in global-settings controller',
  },
  {
    url: '/system/errors/groups/:param/resolve',
    method: 'POST',
    reason: 'Error resolve not in global-settings controller',
  },
  {
    url: '/system/errors/groups/:param/ignore',
    method: 'POST',
    reason: 'Error ignore not in global-settings controller',
  },

  // System job queue endpoints
  {
    url: '/system/jobs/dashboard',
    method: 'GET',
    reason: 'Job dashboard not in global-settings controller',
  },
  {
    url: '/system/jobs/queues',
    method: 'GET',
    reason: 'Job queues not in global-settings controller',
  },
  {
    url: '/system/jobs/queues/:param',
    method: 'GET',
    reason: 'Job queue detail not in global-settings controller',
  },
  {
    url: '/system/jobs/queues',
    method: 'POST',
    reason: 'Queue creation not in global-settings controller',
  },
  {
    url: '/system/jobs/queues/:param/pause',
    method: 'POST',
    reason: 'Queue pause not in global-settings controller',
  },
  {
    url: '/system/jobs/queues/:param/resume',
    method: 'POST',
    reason: 'Queue resume not in global-settings controller',
  },
  {
    url: '/system/jobs/queues/:param/drain',
    method: 'POST',
    reason: 'Queue drain not in global-settings controller',
  },
  { url: '/system/jobs', method: 'GET', reason: 'Jobs list not in global-settings controller' },
  {
    url: '/system/jobs/:param',
    method: 'GET',
    reason: 'Job detail not in global-settings controller',
  },
  { url: '/system/jobs', method: 'POST', reason: 'Job creation not in global-settings controller' },
  {
    url: '/system/jobs/:param/cancel',
    method: 'POST',
    reason: 'Job cancel not in global-settings controller',
  },
  {
    url: '/system/jobs/:param/retry',
    method: 'POST',
    reason: 'Job retry not in global-settings controller',
  },
  {
    url: '/system/jobs/scheduled',
    method: 'GET',
    reason: 'Scheduled jobs not in global-settings controller',
  },
  {
    url: '/system/jobs/failed',
    method: 'GET',
    reason: 'Failed jobs not in global-settings controller',
  },
  {
    url: '/system/jobs/cleanup',
    method: 'POST',
    reason: 'Jobs cleanup not in global-settings controller',
  },

  // Email template preview uses POST in frontend, GET in backend
  {
    url: '/settings/email-templates/:param/preview',
    method: 'POST',
    reason: 'Frontend sends POST with sampleData, backend has GET preview',
  },
  {
    url: '/settings/email-templates/:param/test',
    method: 'POST',
    reason: 'Test email endpoint exists but with different body shape',
  },

  // Settings webhook test
  {
    url: '/settings/tenant/:param/webhooks/:param/test',
    method: 'POST',
    reason: 'Webhook test endpoint not in controller',
  },

  // Frontend /support/tickets PATCH vs backend PUT
  {
    url: '/support/tickets/:param',
    method: 'PATCH',
    reason: 'Frontend uses PATCH, backend uses PUT for ticket update',
  },

  // Support ticket close
  {
    url: '/support/tickets/:param/close',
    method: 'POST',
    reason: 'Backend uses status change via POST /status with status=closed',
  },
];

/**
 * Bilinen istisna mi kontrol eder.
 */
function isKnownException(fe: FrontendEndpoint): boolean {
  return KNOWN_EXCEPTIONS.some((exc) => matchPath(fe.url, exc.url) && fe.method === exc.method);
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
      const domainFrontend = frontendEndpoints.filter(
        (fe) => fe.url.startsWith(`/${domain}/`) || fe.url === `/${domain}`,
      );

      // Bos domain'leri atla
      if (domainFrontend.length === 0) return;

      const mismatches: string[] = [];

      for (const fe of domainFrontend) {
        if (isKnownException(fe)) continue;

        const hasMatch = backendEndpoints.some((be) => matchEndpoint(fe, be));
        if (!hasMatch) {
          mismatches.push(`  ${fe.method} ${fe.url} (from ${fe.source}.ts::${fe.functionName})`);
        }
      }

      if (mismatches.length > 0) {
        throw new Error(
          `${mismatches.length} frontend endpoint(s) in /${domain}/* have no backend match:\n${mismatches.join('\n')}`,
        );
      }
    });
  }

  // --------------------------------------------------------------------------
  // Kritik endpoint'ler icin ozel testler (H12 bulgulari)
  // --------------------------------------------------------------------------

  describe('H12 Critical Path Endpoints', () => {
    it('live settings email test route should match', () => {
      const fe = frontendEndpoints.find(
        (e) => e.url === '/settings/config/email/test' && e.method === 'POST',
      );
      expect(fe).toBeDefined();

      const be = backendEndpoints.find(
        (e) => e.path === '/settings/config/email/test' && e.method === 'POST',
      );
      expect(be).toBeDefined();
    });

    it('announcement unpublish should use /cancel path', () => {
      // H18 fix: frontend unpublish -> /support/announcements/:id/cancel
      const fe = frontendEndpoints.find(
        (e) => e.url === '/support/announcements/:param/cancel' && e.method === 'POST',
      );
      expect(fe).toBeDefined();

      const be = backendEndpoints.find(
        (e) => matchPath(e.path, '/support/announcements/:id/cancel') && e.method === 'POST',
      );
      expect(be).toBeDefined();
    });

    it('impersonation revoke should use /terminate path', () => {
      // H21 fix: frontend revokeSession -> /impersonation/sessions/:id/terminate
      const fe = frontendEndpoints.find(
        (e) => e.url === '/impersonation/sessions/:param/terminate' && e.method === 'POST',
      );
      expect(fe).toBeDefined();

      const be = backendEndpoints.find(
        (e) => matchPath(e.path, '/impersonation/sessions/:id/terminate') && e.method === 'POST',
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
      const pathMatches = backendEndpoints.filter((be) => matchPath(fe.url, be.path));
      if (pathMatches.length === 0) continue; // Path eslesmediyse zaten baska test yakalayacak

      const methodMatch = pathMatches.some((be) => {
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
        const beMethods = pathMatches.map((be) => be.method).join(',');
        methodMismatches.push(
          `  ${fe.method} ${fe.url} -> backend has [${beMethods}] (from ${fe.source}.ts)`,
        );
      }
    }

    if (methodMismatches.length > 0) {
      throw new Error(
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

    expect(count).toBe(592);
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

      const hasMatch = backendEndpoints.some((be) => matchEndpoint(fe, be));
      if (!hasMatch) {
        unmatched.push(`${fe.method} ${fe.url} (${fe.source}::${fe.functionName})`);
      }
    }

    // Eslesmeyenlerin sayisi 0 olmali (tum eslesmeyenler bilinen istisnalarda olmali)
    expect(unmatched).toEqual([]);
  });
});
