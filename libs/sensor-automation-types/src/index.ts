/**
 * @platform/sensor-automation-types — IEC 61131-3 Structured Text AST types
 * shared between the sensor-service compiler (backend parser + analyzer +
 * formatter) and the sensor-module simulator (frontend interpreter).
 *
 * Pure types + small adapter utilities — NO runtime logic, NO NestJS
 * decorators, NO React dependencies. Safe for both ts-node (backend) and
 * Vite (frontend) consumption.
 *
 * History: created per AUDIT-HIGH-005 (cold audit 2026-04-22) to eliminate
 * ~520 lines of drift-prone duplication between
 * `apps/sensor-service/src/automation/compiler/parser/st-ast.ts` and
 * `web/modules/sensor-module/src/simulation/st-ast-types.ts`.
 *
 * @see ADR-028 (lib-creation rubric — libs/<domain>/ row)
 */
export * from './st-ast';
