/**
 * Node-RED settings — repository sensor simulator.
 *
 * docker-compose.simulators.yml mounts this file read-only over
 * /data/settings.js, so the editor cannot rewrite it.
 *
 * Credentials: flows_cred.json holds only ${SIM_*} references, which Node-RED
 * resolves from the container environment when it starts the flows; no
 * credential value lives in the repository. With nothing secret in that file
 * there is nothing to encrypt, so credentialSecret is false and the file
 * stays reviewable plain JSON. A credential typed into the editor would be
 * written to it in clear: set the environment instead.
 *
 * SEC-016: admin UI authentication is required. The hash below is a
 * placeholder that admits no password; generate one with
 *   npx node-red-admin hash-pw
 * and replace it before opening the editor.
 */

module.exports = {
  flowFile: 'flows.json',
  flowFilePretty: true,
  credentialSecret: false,

  // SEC-016: admin UI authentication
  adminAuth: {
    type: 'credentials',
    users: [
      {
        username: 'admin',
        password: '$2b$08$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        permissions: '*',
      },
    ],
  },

  // The editor port is published on 127.0.0.1 only (compose).
  uiPort: process.env.PORT || 1880,

  diagnostics: {
    enabled: false,
  },

  logging: {
    console: {
      level: 'info',
      metrics: false,
      audit: false,
    },
  },

  editorTheme: {
    tours: false,
  },
};
