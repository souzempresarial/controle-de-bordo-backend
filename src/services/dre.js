const pool = require('../models/db');

// Cópia de controle-de-bordo-react/src/services/dre.js (calcDREBase) — mudou lá, muda aqui, senão a IA e a tela Financeiro divergem
function calcDREBase(lm) {
  const ent = (cat, sub) => lm.filter(l => l.tipo === 'Entrada' && l.categoria === cat && (!sub || l.subcategoria === sub)).reduce((a, l) => a + l.valor, 0);
  const sai = (cat)      => lm.filter(l => l.tipo === 'Saída'   && l.categoria === cat).reduce((a, l) => a + l.valor, 0);
  const qua = (cat)      => lm.filter(l => l.categoria === cat).reduce((a, l) => a + l.valor, 0);

  const aparelhos    = ent('Aparelhos');
  const acessorios   = ent('Acessórios');
  const assistencia  = ent('Assistência Técnica');
  const outrosProd   = ent('Outros Produtos');
  const subscricao   = aparelhos + acessorios + assistencia + outrosProd;

  const recFin       = ent('Receitas Não-Operacionais', 'Aplicações Fora da Companhia');
  const recNaoOp     = ent('Receitas Não-Operacionais') - recFin;
  const recBruta     = subscricao + recNaoOp;

  const deducoesDiretas = lm.filter(l => l.tipo === 'Entrada' && l.valorRecebido != null && l.subcategoria !== 'Upgrade').reduce((a, l) => a + (l.valor - l.valorRecebido), 0);
  const deducoes     = sai('Deduções das Vendas') + deducoesDiretas;
  const recLiquida   = recBruta - deducoes;

  const cmvTotal     = qua('Custos Variáveis Diretos');
  const lucroBruto   = recLiquida - cmvTotal;

  const custosVarInd = sai('Custos Variáveis Indiretos');
  const contribuicao = lucroBruto - custosVarInd;

  const ocupacao     = sai('Despesas com Ocupação');
  const pessoal      = sai('Despesas com Pessoal');
  const variaveis    = sai('Despesas Variáveis');
  const softwares    = sai('Softwares / Tecnologias');
  const terceiros    = sai('Serviços Terceirizados');
  const impostos     = sai('Impostos');
  const sga          = ocupacao + pessoal + variaveis + softwares + terceiros + impostos;
  const ebitda       = contribuicao - sga;

  const despJuros    = lm.filter(l => l.tipo === 'Saída' && l.categoria === 'Dívidas / Empréstimos' && l.subcategoria !== 'Amortização').reduce((a, l) => a + l.valor, 0);
  const despNaoOp    = sai('Saídas Não-Operacionais');
  const resFin       = recFin - despJuros - despNaoOp;

  return {
    aparelhos, acessorios, assistencia, outrosProd, recBruta, deducoes, recLiquida,
    cmvTotal, lucroBruto, custosVarInd, contribuicao,
    ocupacao, pessoal, variaveis, softwares, terceiros, impostos, sga, ebitda, resFin,
  };
}

function normalizar(l) {
  return {
    tipo: l.tipo, categoria: l.categoria, subcategoria: l.subcategoria, status: l.status,
    data: (l.data instanceof Date ? l.data.toISOString() : String(l.data)).slice(0, 10),
    valor: parseFloat(l.valor),
    isCMV: !!l.is_cmv,
    valorRecebido: l.valor_recebido != null ? parseFloat(l.valor_recebido) : null,
    valorUpgrade:  l.valor_upgrade  != null ? parseFloat(l.valor_upgrade)  : null,
  };
}

// DRE dos meses com lançamento desde `desde` (YYYY-MM-01), igual à tela Financeiro, mais o caixa do mês
async function dreMensal(clienteId, desde) {
  const [{ rows: lancs }, { rows: metas }] = await Promise.all([
    pool.query('SELECT * FROM lancamentos WHERE cliente_id = $1 AND data >= $2', [clienteId, desde]),
    pool.query(`SELECT mes_chave, campo, valor FROM metas WHERE cliente_id = $1 AND campo IN ('depreciacao','irpj') AND mes_chave >= $2`, [clienteId, desde.slice(0, 7)]),
  ]);
  const porMes = {};
  for (const l of lancs.map(normalizar)) (porMes[l.data.slice(0, 7)] ||= []).push(l);
  const manual = (mes, campo) => parseFloat(metas.find(m => m.mes_chave === mes && m.campo === campo)?.valor || 0);

  return Object.keys(porMes).sort().map(mes => {
    const lm   = porMes[mes];
    const base = calcDREBase(lm);
    const lucroLiq = base.ebitda + base.resFin - manual(mes, 'depreciacao') - manual(mes, 'irpj');
    const caixa = lm.filter(l => !l.isCMV && l.categoria !== 'Custos Variáveis Diretos' && !(l.tipo === 'Saída' && l.status === 'Pendente'));
    const entCaixa = caixa.filter(l => l.tipo === 'Entrada').reduce((a, l) => a + (l.valorRecebido ?? (l.valor - (l.valorUpgrade || 0))), 0);
    const saiCaixa = caixa.filter(l => l.tipo === 'Saída').reduce((a, l) => a + l.valor, 0);
    return { mes, ...base, lucroLiq, entCaixa, saiCaixa };
  });
}

const NOMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const brl = v => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v, base) => base ? `${(v / base * 100).toFixed(1)}%` : '—';

function textoDRE(d, hojeISO) {
  const [y, m] = d.mes.split('-');
  const parcial = hojeISO.startsWith(d.mes) ? ` (parcial, até ${hojeISO.slice(8, 10)}/${m})` : '';
  return `[${NOMES[Number(m) - 1]} de ${y}${parcial}]
Receita Bruta ${brl(d.recBruta)} (Aparelhos ${brl(d.aparelhos)}, Acessórios ${brl(d.acessorios)}, Assistência ${brl(d.assistencia)}, Outros produtos ${brl(d.outrosProd)})
Deduções ${brl(d.deducoes)} · Receita Líquida ${brl(d.recLiquida)}
CMV ${brl(d.cmvTotal)} · Lucro Bruto ${brl(d.lucroBruto)} (margem ${pct(d.lucroBruto, d.recBruta)})
Custos Variáveis Indiretos ${brl(d.custosVarInd)} · Margem de Contribuição ${brl(d.contribuicao)} (${pct(d.contribuicao, d.recBruta)})
Despesas SG&A ${brl(d.sga)} (Pessoal ${brl(d.pessoal)}, Ocupação ${brl(d.ocupacao)}, Variáveis ${brl(d.variaveis)}, Softwares ${brl(d.softwares)}, Terceirizados ${brl(d.terceiros)}, Impostos ${brl(d.impostos)})
EBITDA ${brl(d.ebitda)} · Resultado Financeiro ${brl(d.resFin)}
Lucro Líquido ${brl(d.lucroLiq)} (margem líquida ${pct(d.lucroLiq, d.recBruta)})
Caixa do mês: entrou ${brl(d.entCaixa)}, saiu ${brl(d.saiCaixa)}`;
}

module.exports = { calcDREBase, dreMensal, textoDRE };
