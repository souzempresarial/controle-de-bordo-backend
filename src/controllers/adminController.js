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

        -- DRE (base competência): usa l.valor original
        COALESCE(SUM(CASE WHEN l.tipo = 'Entrada' AND l.categoria NOT IN (${sqlIn(APORTE_CATS)}) THEN l.valor ELSE 0 END), 0) AS receita_bruta,
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída'   AND (COALESCE(l.is_cmv, false) OR l.categoria IN (${sqlIn(CMVCATS)}))   THEN l.valor ELSE 0 END), 0) AS cmv,
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída'   AND l.categoria IN (${sqlIn(DEDUCOES_CATS)}) THEN l.valor ELSE 0 END), 0) AS deducoes,
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída'   AND l.categoria IN (${sqlIn(SGA_CATS)})      THEN l.valor ELSE 0 END), 0) AS sga,
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída'   AND l.categoria IN (${sqlIn(NAOOP_CATS)})    THEN l.valor ELSE 0 END), 0) AS nao_op,

        -- DFC (base caixa): entradas usam valor_recebido, saídas usam valor cheio
        COALESCE(SUM(CASE WHEN l.tipo = 'Entrada' AND l.categoria NOT IN (${sqlIn(APORTE_CATS)}) THEN COALESCE(l.valor_recebido, l.valor) ELSE 0 END), 0) AS dfc_entradas,
        COALESCE(SUM(CASE WHEN l.tipo = 'Saída'   AND l.categoria NOT IN (${sqlIn(APORTE_CATS)}) THEN l.valor ELSE 0 END), 0) AS dfc_saidas

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

module.exports = { ranking };
