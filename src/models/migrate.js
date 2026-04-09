require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('./db');

async function migrate() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Tabelas criadas com sucesso!');
  } catch (err) {
    console.error('Erro ao criar tabelas:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();
