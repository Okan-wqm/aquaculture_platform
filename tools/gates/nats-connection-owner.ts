/**
 * nats-connection-owner — the one owner of "which module builds the NATS connection", and of the
 * credential names a CONNECT-identity rule talks about (DET crossfile-2, ledger Z33 / Z-B2).
 * ===============================================================================================
 *
 * ADR-015: under mTLS the client certificate is the only identity, so no user, pass or token reaches
 * the CONNECT frame. The rule lives in the branch structure of `buildNatsConnectionOptions`
 * (libs/backend-common/src/nats/nats-connection.factory.ts), and a tool that checks it has to find
 * that factory by what a module DECLARES, never by a copy of its path: a factory that moves is still
 * held to the rule, the old path becomes an ordinary module, and the `nats/index.ts` barrel that
 * re-exports the symbol is no owner.
 *
 * What this module owns:
 *   - `declaresNatsConnectionFactory`: does a parsed module declare and export the factory.
 *   - `NATS_CREDENTIAL_ENV_VARS` / `NATS_CREDENTIAL_FIELDS`: the environment variables the factory
 *     reads credentials from and the option fields it writes them onto, as one table so the two
 *     lists cannot drift apart. tests/invariants/nats-connection-owner.spec.ts holds both lists to
 *     the factory's own text, so a credential variable or field cannot reach the factory without
 *     reaching the rule.
 *
 * Consumers: tools/aria-adapters/security-boundary-adapter.ts.
 */

import * as ts from 'typescript';

/** The exported name of the factory; the one spelling of it a tool may rely on. */
export const NATS_CONNECTION_FACTORY_SYMBOL = 'buildNatsConnectionOptions';

/** One NATS credential: the variable the factory reads and the option field it fills. */
const NATS_CREDENTIALS = [
  { envVar: 'NATS_AUTH_USER', field: 'user' },
  { envVar: 'NATS_AUTH_PASS', field: 'pass' },
  { envVar: 'NATS_AUTH_TOKEN', field: 'token' },
] as const;

export const NATS_CREDENTIAL_ENV_VARS: readonly string[] = NATS_CREDENTIALS.map(
  (credential) => credential.envVar,
);

export const NATS_CREDENTIAL_FIELDS: readonly string[] = NATS_CREDENTIALS.map(
  (credential) => credential.field,
);

const isExported = (statement: ts.Statement): boolean =>
  ts.canHaveModifiers(statement) &&
  (ts.getModifiers(statement) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );

/**
 * True when the module declares a top-level function or constant named
 * `buildNatsConnectionOptions` and exports it under that name (`export function ...`,
 * `export const ...` or `export { buildNatsConnectionOptions }`). A re-export, an import, an
 * unexported function, a class member and a mention in a comment or a string declare nothing.
 */
export function declaresNatsConnectionFactory(sourceFile: ts.SourceFile): boolean {
  let declared = false;
  let exported = false;
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === NATS_CONNECTION_FACTORY_SYMBOL
    ) {
      declared = true;
      exported ||= isExported(statement);
    } else if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === NATS_CONNECTION_FACTORY_SYMBOL,
      )
    ) {
      declared = true;
      exported ||= isExported(statement);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      exported ||= statement.exportClause.elements.some(
        (element) =>
          element.name.text === NATS_CONNECTION_FACTORY_SYMBOL &&
          (element.propertyName ?? element.name).text === NATS_CONNECTION_FACTORY_SYMBOL,
      );
    }
  }
  return declared && exported;
}
