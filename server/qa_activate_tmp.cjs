const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const res = await pool.query(
    "UPDATE users SET status = 'ACTIVE', role = 'System admin' WHERE id = 'USR-0003' RETURNING id, name, email, role, status"
  );
  console.log('Activated:', res.rows);
}

main().then(() => pool.end()).catch((err) => { console.error(err); pool.end(); process.exit(1); });
