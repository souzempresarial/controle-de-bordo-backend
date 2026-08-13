const pool = require('../models/db');

// Mirrors frontend constants.js — keep in sync
const CMVCATS      = ['Custos Variáveis Diretos'];
const SGA_CATS     = ['Custos Variáveis Indiretos','Despesas com Ocupação','Despesas com Pessoal','Despesas Variáveis','Softwares / Tecnologias','Serviços Terceirizados','Impostos'];
const NAOOP_CATS   = ['Dívidas / Empréstimos','Saídas Não-Operacionais'];
const DEDUCOES_CATS = ['Deduções das Vendas'];
const APORTE_CATS  = ['Aportes e Transferências'];

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
        -- Faturamento: entradas excluindo aportes/transferências (igual ao Dashboard)
        COALESCE(SUM(CASE WHEN l.tipo = 'Entrada' AND l.categoria NOT IN (${sqlIn(APORTE_CATS)}) THEN COALESCE(l.valor_recebido, l.valor) ELSE 0 END), 0) AS faturamento,
        -- CMV: flag is_cmv OU categoria Custos Variáveis Diretos (igual ao DRE)
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída' AND (COALESCE(l.is_cmv, false) OR l.categoria IN (${sqlIn(CMVCATS)})) THEN l.valor ELSE 0 END), 0) AS cmv,
        -- Deduções das vendas (igual ao DRE)
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída' AND l.categoria IN (${sqlIn(DEDUCOES_CATS)}) THEN l.valor ELSE 0 END), 0) AS deducoes,
        -- SG&A: categorias operacionais (igual ao DRE)
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída' AND l.categoria IN (${sqlIn(SGA_CATS)})   THEN l.valor ELSE 0 END), 0) AS sga,
        -- Não-operacionais (igual ao DRE)
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída' AND l.categoria IN (${sqlIn(NAOOP_CATS)}) THEN l.valor ELSE 0 END), 0) AS nao_op,
        -- Caixa bruto: entradas (excl. aportes) menos todas saídas
        COALESCE(SUM(CASE
          WHEN l.tipo = 'Entrada' AND l.categoria NOT IN (${sqlIn(APORTE_CATS)}) THEN COALESCE(l.valor_recebido, l.valor)
          WHEN l.tipo = 'Saída'   THEN -l.valor
          ELSE 0 END), 0) AS caixa
      FROM clientes c
      LEFT JOIN lancamentos l ON l.cliente_id = c.id AND l.status = 'Confirmado' ${filtroMes}
      GROUP BY c.id, c.nome
      ORDER BY faturamento DESC
    `, params);

    const resultado = rows.map(r => {
      const fat     = parseFloat(r.faturamento);
      const cmv     = parseFloat(r.cmv);
      const deducoes = parseFloat(r.deducoes);
      const sga     = parseFloat(r.sga);
      const naoOp   = parseFloat(r.nao_op);
      const caixa   = parseFloat(r.caixa);
      // lucro = fat - cmv - deducoes - sga - naoOp  (igual ao lucroLiq do DRE)
      const lucro   = fat - cmv - deducoes - sga - naoOp;
      return {
        id: r.id, nome: r.nome,
        faturamento:   fat,
        saidas:        cmv + deducoes + sga + naoOp,
        cmv,
        deducoes,
        sga,
        naoOp,
        caixa,
        lucro,
        lucratividade: fat > 0 ? parseFloat((lucro / fat * 100).toFixed(2)) : 0,
      };
    });

    res.json(resultado);
  } catch (err) {
    console.error('[admin.ranking]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

module.exports = { ranking };