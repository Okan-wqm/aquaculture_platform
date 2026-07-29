/**
 * The acknowledgement a fire-and-forget admin command returns.
 *
 * Three routes — activity logging, retention-policy application and compliance
 * download recording — declared `Promise<{ success: boolean }>` inline. An
 * anonymous shape is a contract with no name: nothing can import it, nothing can
 * generate from it, and the admin panel therefore had to re-declare each one.
 *
 * `success` is the literal `true`, not `boolean`. Every one of these handlers
 * either awaits its work and returns a hardcoded `true` or throws — `false` is
 * not reachable, and typing it `boolean` invited a caller to branch on an
 * outcome that never occurs.
 */
export interface OperationAcknowledgement {
  success: true;
}
