const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function createTables() {
  // Use connection string format which handles auth better
  const connectionString = 'postgresql://aquaculture:devpassword@localhost:5432/aquaculture';

  const client = new Client({
    connectionString,
    ssl: false,
  });

  try {
    await client.connect();
    console.log('Connected to PostgreSQL');

    const sqlFile = path.join(__dirname, 'create-security-tables.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    // Split by semicolons but be careful with statements
    const statements = sql.split(';').filter(s => s.trim().length > 0);

    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed.length === 0) continue;

      try {
        await client.query(trimmed);
        // Extract table/index name for logging
        const match = trimmed.match(/(?:CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX)[^"]*"?(\w+)"?/i);
        if (match) {
          console.log(`Created: ${match[1]}`);
        }
      } catch (err) {
        if (err.code === '42P07') {
          // Table already exists
          console.log(`Already exists: ${err.table || 'object'}`);
        } else if (err.message.includes('already exists')) {
          console.log(`Already exists: ${trimmed.substring(0, 50)}...`);
        } else {
          console.error(`Error: ${err.message}`);
        }
      }
    }

    console.log('\nAll security tables created successfully!');

    // Verify tables
    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN (
        'activity_logs', 'security_events', 'security_incidents',
        'threat_intelligence', 'data_requests', 'compliance_reports',
        'retention_policies', 'login_attempts', 'api_usage_logs', 'user_sessions'
      )
      ORDER BY table_name
    `);

    console.log('\nVerified tables:');
    result.rows.forEach(row => console.log(`  - ${row.table_name}`));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await client.end();
  }
}

createTables();
