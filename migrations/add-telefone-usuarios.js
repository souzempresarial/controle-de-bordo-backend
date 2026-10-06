require('dotenv').config();
const pool = require('../src/models/db');

async function main() {
  console.log('Adicionando coluna telefone na tabela usuarios...');

  await pool.query(`
    ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS telefone VARCHAR(20);
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS usuarios_telefone_unique
    ON usuarios (telefone)
    WHERE telefone IS NOT NULL;
  `);

  console.log('Concluído.');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
