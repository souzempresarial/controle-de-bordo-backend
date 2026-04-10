require('dotenv').config();
const pool = require('./src/models/db');

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id          SERIAL PRIMARY KEY,
      email       VARCHAR(255) UNIQUE NOT NULL,
      senha_hash  VARCHAR(255) NOT NULL,
      papel       VARCHAR(20) NOT NULL DEFAULT 'cliente',
      cliente_id  INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
      nome        VARCHAR(100),
      criado_em   TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Tabela usuarios criada com sucesso.');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
