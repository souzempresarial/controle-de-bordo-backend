require('dotenv').config();
const pool = require('./src/models/db');
const { gerarResumoMensal } = require('./src/services/analyticsService');

async function main() {
  const periodo = process.argv[2] || '2026-09';
  console.log(`[Analytics] Gerando resumos para ${periodo}`);

  const { rows: clientes } = await pool.query('SELECT id, nome FROM clientes ORDER BY id');
  console.log(`[Analytics] ${clientes.length} clientes`);

  let ok = 0, erros = 0, semDados = 0;
  for (const c of clientes) {
    try {
      const resumo = await gerarResumoMensal(c.id, periodo);
      if (resumo) { ok++; console.log(`✔ ${c.nome}: ${resumo.slice(0, 80)}...`); }
      else { semDados++; console.log(`— ${c.nome}: sem dados`); }
    } catch (err) {
      erros++;
      console.error(`✘ ${c.nome}:`, err.message);
    }
  }

  console.log(`\nConcluído — ${ok} gerados, ${semDados} sem dados, ${erros} erros`);
  await pool.end();
}

main().catch(console.error);
