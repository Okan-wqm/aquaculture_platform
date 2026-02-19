/**
 * Node-RED Settings - Simulator Stack
 *
 * SEC-016: Admin UI authentication is required.
 *
 * The default admin password hash below is for 'changeme' (bcrypt).
 * BEFORE USE: generate a proper hash with:
 *   node -e "require('bcryptjs').hash('YOUR_PASSWORD', 8).then(h => console.log(h))"
 * or use the Node-RED admin tool:
 *   npx node-red-admin hash-pw
 *
 * Then replace the hash value below.
 */

module.exports = {
    // Flow file settings
    flowFile: 'flows.json',
    flowFilePretty: true,
    credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || 'CHANGE_ME_CREDENTIAL_SECRET',

    // SEC-016: Admin UI authentication
    adminAuth: {
        type: 'credentials',
        users: [{
            username: 'admin',
            // Default hash for 'changeme' — REPLACE before use in any shared environment
            password: '$2b$08$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            permissions: '*'
        }]
    },

    // Bind editor to all interfaces inside container (port is restricted at compose level)
    uiPort: process.env.PORT || 1880,

    // Disable diagnostic endpoint in non-dev mode
    diagnostics: {
        enabled: false,
    },

    // Logging
    logging: {
        console: {
            level: 'info',
            metrics: false,
            audit: false,
        },
    },

    // Editor settings
    editorTheme: {
        tours: false,
    },
};
