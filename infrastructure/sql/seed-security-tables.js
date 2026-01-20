const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function seedTables() {
  // Use connection string format
  const connectionString = process.env.DATABASE_URL ||
    'postgresql://aquaculture:devpassword@localhost:5432/aquaculture';

  const client = new Client({
    connectionString,
    ssl: false,
  });

  try {
    await client.connect();
    console.log('Connected to PostgreSQL');

    const sqlFile = path.join(__dirname, 'seed-security-tables.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    console.log('Executing seed data...\n');

    // Execute the entire SQL file at once (it handles conflicts gracefully)
    const result = await client.query(sql);

    // The last query returns the verification counts
    if (result && Array.isArray(result)) {
      const lastResult = result[result.length - 1];
      if (lastResult && lastResult.rows) {
        console.log('\nSeed data verification:');
        console.log('========================');
        lastResult.rows.forEach(row => {
          console.log(`  ${row.table_name}: ${row.record_count} records`);
        });
      }
    } else if (result && result.rows) {
      console.log('\nSeed data verification:');
      console.log('========================');
      result.rows.forEach(row => {
        console.log(`  ${row.table_name}: ${row.record_count} records`);
      });
    }

    console.log('\nSecurity tables seeded successfully!');

  } catch (err) {
    console.error('Error:', err.message);
    if (err.detail) {
      console.error('Detail:', err.detail);
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

seedTables();
