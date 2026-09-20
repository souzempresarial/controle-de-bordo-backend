// Roda UMA VEZ para criar a tabela de embeddings analíticos.
// Pré-requisito: extensão pgvector habilitada no RDS.
//
// Como habilitar pgvector no Aurora PostgreSQL:
//   1. AWS Console → RDS → Parameter Groups → editar o grupo do cluster
//   2. shared_preload_libraries → adicionar "pgvector"  (reinicia o cluster)
//   OU, se o Aurora já tiver pgvector disponível (Aurora PG 15.2+):
//   basta rodar este script — o CREATE EXTENSION vai funcionar sem reiniciar.
//
// Rodar: node migrate-analytics.js

require('dotenv').config();
const pool = require('./src/models/db');

async function run() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    console.log('Extensão pgvector OK');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS analytics_embeddings (
        id         SERIAL PRIMARY KEY,
        cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        periodo    CHAR(7)  NOT NULL,               -- 'YYYY-MM'
        resumo     TEXT     NOT NULL,
        embedding  VECTOR(768),                      -- text-embedding-004
        gerado_em  TIMESTAMP DEFAULT NOW(),
        UNIQUE (cliente_id, periodo)
      )
    `);
    console.log('Tabela analytics_embeddings criada');

    // Índice cosine para busca por similaridade
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_embedding
        ON analytics_embeddings
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
    `);
    console.log('Índice ivfflat criado');

    console.log('Migração concluída!');
  } catch (err) {
    console.error('Erro na migração:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
