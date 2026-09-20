require('dotenv').config();
const pool = require('./src/models/db');
const { gerarResumoMensal } = require('./src/services/analyticsService');

module.exports.gerarAnalytics = async (event) => {
  console.log('[Analytics] Cron disparado:', new Date().toISOString());

  // Período alvo: mês anterior
  const agora  = new Date();
  const ano    = agora.getMonth() === 0 ? agora.getFullYear() - 1 : agora.getFullYear();
  const mes    = agora.getMonth() === 0 ? 12 : agora.getMonth();
  const periodo = `${ano}-${String(mes).padStart(2, '0')}`;

  // Permite override via event para rodar manual (ex: { periodo: '2026-08' })
  const periodoAlvo = event?.periodo || periodo;
  console.log(`[Analytics] Gerando resumos para período: ${periodoAlvo}`);

  let { rows: clientes } = await pool.query(
    'SELECT id, nome FROM clientes ORDER BY id'
  );

  // Permite rodar para um cliente específico
  if (event?.clienteId) {
    clientes = clientes.filter(c => c.id === Number(event.clienteId));
  }

  console.log(`[Analytics] ${clientes.length} clientes encontrados`);

  let ok = 0, erros = 0;
  for (const cliente of clientes) {
    try {
      const resumo = await gerarResumoMensal(cliente.id, periodoAlvo);
      if (resumo) ok++;
    } catch (err) {
      erros++;
      console.error(`[Analytics] Erro cliente ${cliente.id} (${cliente.nome}):`, err.message);
    }
  }

  await pool.end();
  const msg = `Concluído — ${ok} resumos gerados, ${erros} erros`;
  console.log('[Analytics]', msg);
  return { statusCode: 200, body: msg };
};
