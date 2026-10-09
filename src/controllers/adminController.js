const pool = require('../models/db');

// Mirrors frontend constants.js — keep in sync
const CMVCATS      = ['Custos Variáveis Diretos'];
const SGA_CATS     = ['Custos Variáveis Indiretos','Despesas com Ocupação','Despesas com Pessoal','Despesas Variáveis','Softwares / Tecnologias','Serviços Terceirizados','Impostos'];
const NAOOP_CATS   = ['Dívidas / Empréstimos','Saídas Não-Operacionais'];
const DEDUCOES_CATS = ['Deduções das Vendas'];
const APORTE_CATS  = ['Aportes e Transferências'];

const DIAS_ESFRIANDO = 7;
const DIAS_PARADO    = 14;

// Saúde de uso por cliente: se o cliente entra, se tem lançamento recente e o que está pendente
async function clientesSaude(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.nome,
        (SELECT count(*)::int FROM usuarios u WHERE u.cliente_id = c.id) AS acessos,
        (SELECT max(la.data_hora) FROM log_acessos la JOIN usuarios u ON u.id = la.usuario_id
          WHERE u.cliente_id = c.id AND u.papel <> 'admin') AS ultimo_acesso,
        (SELECT count(*)::int FROM log_acessos la JOIN usuarios u ON u.id = la.usuario_id
          WHERE u.cliente_id = c.id AND u.papel <> 'admin' AND la.data_hora > NOW() - interval '30 days') AS entradas_30d,
        (SELECT count(*)::int FROM lancamentos l WHERE l.cliente_id = c.id AND NOT COALESCE(l.is_cmv, false)
          AND l.criado_em > NOW() - interval '7 days') AS lanc_7d,
        (SELECT max(l.criado_em) FROM lancamentos l WHERE l.cliente_id = c.id) AS ultimo_lancamento,
        (SELECT count(*)::int FROM contas co WHERE co.cliente_id = c.id AND co.tipo = 'pagar'
          AND co.status = 'pendente' AND co.vencimento < CURRENT_DATE) AS contas_vencidas,
        (SELECT count(*)::int FROM lancamentos l WHERE l.cliente_id = c.id AND l.origem = 'ia'
          AND l.criado_em > NOW() - interval '30 days') AS lanc_ia_30d,
        EXISTS (SELECT 1 FROM mercadophone_chaves k WHERE k.cliente_id = c.id AND k.ativa) AS mp_conectado
      FROM clientes c
      WHERE EXISTS (SELECT 1 FROM usuarios u WHERE u.cliente_id = c.id)`);

    // Conversa com a SOUZ AI fica no Redis (chat:{clienteId})
    let conversas = [];
    try {
      const redis = require('../services/redis');
      conversas = rows.length ? await redis.mget(...rows.map(r => `chat:${r.id}`)) : [];
    } catch (e) { console.warn('[admin.clientesSaude] Redis:', e.message); }

    const agora = Date.now();
    const clientes = rows.map((r, i) => {
      const dias = r.ultimo_acesso ? Math.floor((agora - new Date(r.ultimo_acesso)) / 86400000) : null;
      const situacao = dias === null
        ? (r.ultimo_lancamento ? 'parado' : 'novo')
        : dias >= DIAS_PARADO ? 'parado' : dias >= DIAS_ESFRIANDO ? 'esfriando' : 'usando';
      const msgs = Array.isArray(conversas[i]) ? conversas[i].filter(m => m.role === 'user').length : 0;
      return { ...r, dias_sem_acesso: dias, situacao, souz_ai_mensagens: msgs };
    });
    const ordem = { parado: 0, esfriando: 1, novo: 2, usando: 3 };
    clientes.sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || (b.contas_vencidas - a.contas_vencidas) || a.nome.localeCompare(b.nome));
    res.json(clientes);
  } catch (err) {
    console.error('[admin.clientesSaude]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function tentativas(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  try {
    const [{ rows: lista }, { rows: [resumo] }, { rows: bloqueados }] = await Promise.all([
      pool.query(`
        SELECT t.id, t.email, t.ip, t.motivo, t.data_hora,
               u.nome, c.nome AS cliente_nome, (u.id IS NOT NULL) AS conhecido
        FROM log_tentativas t
        LEFT JOIN usuarios u ON u.email = t.email
        LEFT JOIN clientes c ON c.id = u.cliente_id
        WHERE t.data_hora > NOW() - interval '30 days'
        ORDER BY t.data_hora DESC LIMIT 500`),
      pool.query(`
        SELECT count(*)::int AS falhas_24h,
               count(DISTINCT ip)::int AS ips_24h,
               count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.email = t.email))::int AS desconhecidos_24h
        FROM log_tentativas t WHERE t.data_hora > NOW() - interval '24 hours'`),
      pool.query(`
        SELECT email FROM log_tentativas
        WHERE motivo = 'senha_incorreta' AND data_hora > NOW() - interval '15 minutes'
        GROUP BY email HAVING count(*) >= 5`),
    ]);
    res.json({ tentativas: lista, resumo: { ...resumo, bloqueados: bloqueados.map(b => b.email) } });
  } catch (err) {
    console.error('[admin.tentativas]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

function sqlIn(cats) {
  return cats.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
}

async function ranking(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  try {
    const { mes } = req.query;
    const filtroMes = mes ? `AND TO_CHAR(l.data, 'YYYY-MM') = $1` : '';
    const params    = mes ? [mes] : [];

    const { rows } = await pool.query(`
      SELECT
        c.id,
        c.nome,

        -- DRE (base competência): usa l.valor original
        COALESCE(SUM(CASE WHEN l.tipo = 'Entrada' AND l.categoria NOT IN (${sqlIn(APORTE_CATS)}) THEN l.valor ELSE 0 END), 0) AS receita_bruta,
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída'   AND (COALESCE(l.is_cmv, false) OR l.categoria IN (${sqlIn(CMVCATS)}))   THEN l.valor ELSE 0 END), 0) AS cmv,
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída'   AND l.categoria IN (${sqlIn(DEDUCOES_CATS)}) THEN l.valor ELSE 0 END), 0)
        + COALESCE(SUM(CASE WHEN l.tipo = 'Entrada' AND l.valor_recebido IS NOT NULL THEN l.valor - l.valor_recebido ELSE 0 END), 0) AS deducoes,
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída'   AND l.categoria IN (${sqlIn(SGA_CATS)})      THEN l.valor ELSE 0 END), 0) AS sga,
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída'   AND l.categoria IN (${sqlIn(NAOOP_CATS)})    THEN l.valor ELSE 0 END), 0) AS nao_op,

        -- DFC (base caixa): espelha Financeiro.jsx — exclui CMV, deduz valor_upgrade das entradas
        COALESCE(SUM(CASE
          WHEN l.tipo = 'Entrada' AND NOT COALESCE(l.is_cmv, false) AND l.categoria NOT IN (${sqlIn(CMVCATS)})
          THEN l.valor - LEAST(COALESCE(l.valor_upgrade, 0), l.valor)
          ELSE 0
        END), 0) AS dfc_entradas,
        COALESCE(SUM(CASE
          WHEN l.tipo = 'Saída' AND NOT COALESCE(l.is_cmv, false) AND l.categoria NOT IN (${sqlIn(CMVCATS)})
          THEN l.valor
          ELSE 0
        END), 0) AS dfc_saidas

      FROM clientes c
      LEFT JOIN lancamentos l ON l.cliente_id = c.id AND l.status = 'Confirmado' ${filtroMes}
      GROUP BY c.id, c.nome
      ORDER BY receita_bruta DESC
    `, params);

    const resultado = rows.map(r => {
      const receita   = parseFloat(r.receita_bruta);
      const cmv       = parseFloat(r.cmv);
      const deducoes  = parseFloat(r.deducoes);
      const sga       = parseFloat(r.sga);
      const naoOp     = parseFloat(r.nao_op);
      const lucroBruto = receita - cmv - deducoes;
      const lucroLiq   = lucroBruto - sga - naoOp;

      const dfcEntradas = parseFloat(r.dfc_entradas);
      const dfcSaidas   = parseFloat(r.dfc_saidas);
      const geracaoCaixa = dfcEntradas - dfcSaidas;

      return {
        id: r.id,
        nome: r.nome,
        // DRE
        receita,
        cmv,
        deducoes,
        sga,
        naoOp,
        lucroBruto,
        lucroLiq,
        lucratividade: receita > 0 ? parseFloat((lucroLiq / receita * 100).toFixed(2)) : 0,
        // DFC
        dfcEntradas,
        dfcSaidas,
        geracaoCaixa,
      };
    });

    res.json(resultado);
  } catch (err) {
    console.error('[admin.ranking]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

module.exports = { ranking, clientesSaude, tentativas };
