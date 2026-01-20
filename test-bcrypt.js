const bcrypt = require('bcryptjs');

// Generate fresh hash for Test123! with 12 rounds (like auth service)
const freshHash = bcrypt.hashSync('Test123!', 12);
console.log('Fresh hash:', freshHash);

// Verify it works
console.log('Verification:', bcrypt.compareSync('Test123!', freshHash));
