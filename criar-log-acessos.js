require('dotenv').config();
const pool = require('./src/models/db');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS log_acessos (
        id         SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        email      VARCHAR(255) NOT NULL,
        nome       VARCHAR(255),
        ip         VARCHAR(100),
        data_hora  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE usuarios
        ADD COLUMN IF NOT EXISTS ultimo_acesso TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS ultimo_ip     VARCHAR(100)
    `);

    console.log('✅ Tabela log_acessos criada e colunas adicionadas a usuarios.');
  } catch (err) {
    console.error('Erro:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
