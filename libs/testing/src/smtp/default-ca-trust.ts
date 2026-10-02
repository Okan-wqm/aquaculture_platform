/**
 * Process-wide trust for a test certificate, with an explicit way back.
 *
 * WHY: a service that builds its own TLS client (nodemailer with
 * `rejectUnauthorized: true`) takes no CA from a test, so the only way to make
 * it trust a test server without editing production code is Node's default CA
 * list. Node 22.19 added `tls.setDefaultCACertificates` for exactly this; CI and
 * every image run Node 22, but the repo's `@types/node` is the 20.x line
 * (matching `engines.node >=20.11`) and does not declare it yet.
 * WHAT: the two declarations, copied from Node's own API signatures, and a
 * helper that appends one certificate and returns the function that restores
 * the previous list.
 */
import * as tls from 'node:tls';

declare module 'tls' {
  /** Node ≥ 22.19 / 24.5: the CA list new TLS clients use when given none. */
  function getCACertificates(type?: 'default' | 'system' | 'bundled' | 'extra'): string[];
  /** Node ≥ 22.19 / 24.5: replaces that list for subsequently created clients. */
  function setDefaultCACertificates(certs: ReadonlyArray<string | NodeJS.ArrayBufferView>): void;
}

/**
 * INVARIANT: the caller runs the returned restore function (in `finally`).
 * If violated → every later TLS client in the same Jest worker keeps trusting
 * a certificate whose key was thrown away, masking a real trust failure.
 */
export function trustCertificateInDefaultCaList(certPem: string): () => void {
  if (typeof tls.setDefaultCACertificates !== 'function') {
    throw new Error(`tls.setDefaultCACertificates needs Node >= 22.19; this is ${process.version}`);
  }
  const previous = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...previous, certPem]);
  return (): void => tls.setDefaultCACertificates(previous);
}
