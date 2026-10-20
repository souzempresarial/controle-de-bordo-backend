require('dotenv').config();
const pool = require('./src/models/db');
const { gerarResumoMensal, gerarResumoSemanal } = require('./src/services/analyticsService');
const { segundaDa, somaDias } = require('./src/services/dre');

// Memória da SOUZ AI: resumos escritos guardados em analytics_embeddings.
//   { tipo: 'mensal' }  (dia 1)   → mês anterior
//   { tipo: 'semanal' } (segunda) → semana passada + mês atual e anterior refeitos (lançamento atrasado muda os números)
// Override manual: { periodo: '2026-08' } para um mês, { semana: '2026-10-12' } para uma semana, { clienteId: 6 } para uma loja.
module.exports.gerarAnalytics = async (event = {}) => {
  console.log('[Analytics] Disparado:', new Date().toISOString(), JSON.stringify(event));
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const mesDe = (dataISO, delta) => new Date(Number(dataISO.slice(0, 4)), Number(dataISO.slice(5, 7)) - 1 + delta, 1).toLocaleDateString('sv-SE').slice(0, 7);

  const tarefas = [];
  if (event.semana) tarefas.push({ tipo: 'semana', alvo: segundaDa(event.semana) });
  if (event.periodo) tarefas.push({ tipo: 'mes', alvo: event.periodo });
  if (!tarefas.length && event.tipo === 'semanal') {
    tarefas.push({ tipo: 'semana', alvo: somaDias(segundaDa(hoje), -7) });
    tarefas.push({ tipo: 'mes', alvo: mesDe(hoje, 0) }, { tipo: 'mes', alvo: mesDe(hoje, -1) });
  }
  if (!tarefas.length) tarefas.push({ tipo: 'mes', alvo: mesDe(hoje, -1) });

  // Só lojas com acesso de cliente ativo (as demais não leem o resumo)
  let { rows: clientes } = await pool.query(
    `SELECT c.id, c.nome FROM clientes c
     WHERE EXISTS (SELECT 1 FROM usuarios u WHERE u.cliente_id = c.id AND u.ativo AND u.papel = 'cliente')
     ORDER BY c.id`
  );
  if (event.clienteId) clientes = clientes.filter(c => c.id === Number(event.clienteId));
  console.log(`[Analytics] ${clientes.length} lojas · tarefas: ${tarefas.map(t => `${t.tipo} ${t.alvo}`).join(', ')}`);

  let ok = 0, vazios = 0, erros = 0;
  // 3 lojas por vez: cabe nos 5 minutos da Lambda sem estourar o limite do Gemini
  const fila = clientes.flatMap(c => tarefas.map(t => ({ c, t })));
  async function trabalhador() {
    for (let item = fila.shift(); item; item = fila.shift()) {
      const { c, t } = item;
      try {
        const r = t.tipo === 'semana' ? await gerarResumoSemanal(c.id, t.alvo) : await gerarResumoMensal(c.id, t.alvo);
        r ? ok++ : vazios++;
      } catch (err) {
        erros++;
        console.error(`[Analytics] Erro ${t.tipo} ${t.alvo} cliente ${c.id} (${c.nome}):`, err.message);
      }
    }
  }
  await Promise.all([trabalhador(), trabalhador(), trabalhador()]);

  const msg = `Concluído — ${ok} resumos gerados, ${vazios} sem movimento, ${erros} erros`;
  console.log('[Analytics]', msg);
  return { statusCode: 200, body: msg };
};
