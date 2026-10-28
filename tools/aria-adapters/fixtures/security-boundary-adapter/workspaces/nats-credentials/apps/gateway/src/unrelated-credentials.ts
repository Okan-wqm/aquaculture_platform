// Near-miss: none of these reads a NATS credential variable.
// NATS_AUTH_USER is ignored under mTLS; NATS_AUTH_PASS and NATS_AUTH_TOKEN too.
export const database = process.env['DATABASE_USER'];
export const smtp = { user: process.env['SMTP_USER'], pass: process.env['SMTP_PASS'] };
export const userFile = process.env['NATS_AUTH_USER_FILE'];
export const hint = (): never => {
  throw new Error('set NATS_AUTH_TOKEN or a client certificate');
};
