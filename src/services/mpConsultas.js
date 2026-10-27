const pool  = require('../models/db');
const redis = require('./redis');

// Consultas do SOUZ AI direto no Mercado Phone: estoque parado, ranking de vendedores, melhores clientes e
// clientes sumidos. A conta é feita aqui e a IA recebe só o texto pronto (nunca a lista bruta de vendas)

const MP_BASE   = 'https://platform.mercadophone.tech/api/v1';
const CACHE_TTL = 6 * 3600;
const POR_PAGINA = 300;

const brl = v => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const brl0 = v => `R$ ${Math.round(Number(v || 0)).toLocaleString('pt-BR')}`;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const dataBR = iso => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
const hojeISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const diasEntre = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

// 429 = o MP pediu para esperar: espera o tempo que ele diz ("aguarde 12s") e tenta de novo
async function mpGet(path, apiKey, tentativas = 2) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const r = await fetch(MP_BASE + path, { headers: { 'X-API-Key': apiKey }, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  if (r.status === 429 && tentativas > 0) {
    const corpo = await r.clone().json().catch(() => ({}));
    const segundos = Math.min(13, parseInt((String(corpo.detail || '').match(/(\d+)\s*s/) || [])[1]) || 4);
    await new Promise(ok => setTimeout(ok, segundos * 1000 + 300));
    return mpGet(path, apiKey, tentativas - 1);
  }
  if (!r.ok) {
    const detalhe = String((await r.json().catch(() => ({}))).detail || '').trim();
    throw new Error(detalhe ? `O Mercado Phone recusou a consulta: ${detalhe}` : `O Mercado Phone não respondeu (${r.status}).`);
  }
  return r.json();
}

// Páginas de 4 em 4 até vir uma incompleta. O "total" do histórico de vendas ignora o filtro de data, então não dá para confiar nele
async function lerTudo(montarPath, apiKey, maxPaginas = 40) {
  const itens = [];
  for (let p = 1; p <= maxPaginas; p += 4) {
    const lote = await Promise.all([p, p + 1, p + 2, p + 3].filter(n => n <= maxPaginas).map(n => mpGet(montarPath(n), apiKey)));
    let acabou = false;
    for (const b of lote) {
      const pg = b.items || [];
      itens.push(...pg);
      if (pg.length < POR_PAGINA) acabou = true;
    }
    if (acabou) break;
  }
  return itens;
}

async function chavesDoCliente(clienteId) {
  const { rows } = await pool.query('SELECT id, nome, api_key FROM mercadophone_chaves WHERE cliente_id = $1 AND ativa = true ORDER BY id', [clienteId]);
  return rows;
}

// Mesmo valor que a importação usa: o faturamento do MP (valorTotal); item que saiu de graça vale 0
const valorItem = i => (i.valorCliente !== '' && i.valorCliente != null && +i.valorCliente === 0 ? 0 : +i.valorTotal || 0);
const ehAparelho = (tipo, desc, imei) =>
  !!imei || /celular|iphone|smartphone|aparelho|macbook|ipad|tablet|watch|airpods|notebook/.test(norm(`${tipo} ${desc}`));
// Peça e serviço (ex.: bateria de iPhone 11) não são aparelho, mesmo com "iphone" na descrição
const ehPecaOuServico = i => i.snPeca === 1 || i.snServico === 1 || /peca|servico/.test(norm(i.tipoProdutoDescricao));
// Cliente de balcão sem cadastro não entra em ranking de clientes
const clienteGenerico = nome => !norm(nome) || /consumidor|cliente padr|cliente passante|passante|avulso|nao identificad|nao informad|balcao|^cliente$|^venda$|^loja/.test(norm(nome));

// No máximo `n` tarefas ao mesmo tempo: dezenas de consultas juntas estouram o limite do MP
async function emLotes(tarefas, n = 4) {
  const res = [];
  for (let i = 0; i < tarefas.length; i += n) res.push(...await Promise.all(tarefas.slice(i, i + n).map(t => t())));
  return res;
}

// Vendas concluídas num período, compactas, com cache (12 meses de loja grande são milhares de itens)
async function vendasPeriodo(clienteId, chaves, ini, fim) {
  const chave = `mp:ia:vendas:${clienteId}:${ini}:${fim}`;
  const cache = await redis.get(chave).catch(() => null);
  if (Array.isArray(cache)) return cache;

  // Um mês por vez em paralelo: cada mês pagina sozinho
  const meses = [];
  for (let d = new Date(`${ini.slice(0, 7)}-01T12:00:00`); d.toISOString().slice(0, 10) <= fim; d.setMonth(d.getMonth() + 1)) {
    const a = d.toISOString().slice(0, 7);
    const mIni = a === ini.slice(0, 7) ? ini : `${a}-01`;
    const ult = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
    meses.push([mIni, ult < fim ? ult : fim]);
  }
  const lotes = await emLotes(chaves.flatMap(k => meses.map(([a, b]) => () =>
    lerTudo(p => `/sales/history?limit=${POR_PAGINA}&page=${p}&dataVendaInicial=${a}&dataVendaFinal=${b}`, k.api_key, 20)
      .then(itens => itens.filter(i => norm(i.statusVenda) === 'concluido' && String(i.dataVenda || '').slice(0, 10) <= b)))), 3);
  const vendas = lotes.flat().map(i => ({
    v: String(i.vendaId), d: String(i.dataVenda || '').slice(0, 10), vend: String(i.vendedorNome || '').trim(),
    cid: i.clienteId || null, cli: String(i.clienteNome || '').trim(), fat: valorItem(i), custo: +i.valorCusto || 0,
    q: +i.quantidade || 1, ap: ehAparelho(i.tipoProdutoDescricao, i.aparelhoDescricao, i.imei1) ? 1 : 0,
  }));
  if (JSON.stringify(vendas).length < 900 * 1024) await redis.set(chave, vendas, { ex: CACHE_TTL }).catch(() => {});
  return vendas;
}

// "IPHONE 17 PRO MAX" sozinho não diz qual é: junta GB e cor da descrição completa e o final do IMEI
function descricaoAparelho(i) {
  const completa = String(i.descricao || '').replace(/^\d+\s*-\s*/, '').replace(/\s+/g, ' ').trim();
  const base = String(i.aparelhoDescricao || completa).replace(/\s+/g, ' ').trim();
  const partes = completa.split(' - ').map(s => s.trim());
  const gb = partes.find(p => /^\d+\s*(gb|tb)$/i.test(p));
  const cor = partes.find(p => p && p !== base && !/imei|gb$|tb$|sa[uú]de|bateria|estado|garantia|^[A-Z0-9]{8,}$/i.test(p) && !/^celular$/i.test(p) && p.length <= 25 && !base.toLowerCase().includes(p.toLowerCase()));
  const imei = String(i.imei || '').trim();
  return [base, gb && !base.includes(gb) ? gb : null, cor, imei ? `IMEI …${imei.slice(-4)}` : null].filter(Boolean).join(' · ');
}

// ── 1. Estoque parado ───────────────────────────────────────────────────────────
async function estoqueParado(clienteId, chaves, dias = 60) {
  const hoje = hojeISO();
  const itens = (await Promise.all(chaves.map(k => lerTudo(p => `/inventory?limit=${POR_PAGINA}&page=${p}`, k.api_key, 60)))).flat();
  const parados = [], erros = [], imeis = new Set();
  let vendidosSemBaixa = 0;
  for (const i of itens) {
    const q = +i.quantidade || 0;
    if (i.excluido || q <= 0 || ehPecaOuServico(i)) continue;
    const desc = descricaoAparelho(i);
    if (!ehAparelho(i.tipoProdutoDescricao, desc, i.imei) || /pre-?venda/.test(norm(desc))) continue;
    const entrada = i.dataEntrada ? String(i.dataEntrada).slice(0, 10) : null;
    const ultVenda = i.dataUltimaVenda ? String(i.dataUltimaVenda).slice(0, 10) : null;
    // Aparelho é unidade única: vendido depois de entrar e ainda com quantidade = baixa esquecida no MP
    if (q <= 1 && ultVenda && entrada && ultVenda >= entrada) { vendidosSemBaixa++; continue; }
    if (!entrada) continue;
    // Mesmo IMEI cadastrado duas vezes no MP é um aparelho só
    const imei = String(i.imei || '').trim();
    if (imei && imeis.has(imei)) continue;
    if (imei) imeis.add(imei);
    const d = diasEntre(entrada, hoje);
    if (d < dias) continue;
    const custo = +i.valorCusto || 0;
    const item = { desc, dias: d, custo, q, disp: String(i.disponibilidade || '').trim(), entrada };
    // IMEI com quantidade > 1 é erro de cadastro (ex.: 966 iPhones iguais): fica fora do total e vai como aviso
    if (i.imei && q > 1) erros.push(item); else parados.push(item);
  }
  const faixa = d => (d < 90 ? `${dias}–89 dias` : d < 180 ? '90–179 dias' : '180 dias ou mais');
  const faixas = {};
  for (const p of parados) { const f = faixas[faixa(p.dias)] ||= { n: 0, v: 0 }; f.n += p.q; f.v += p.custo * p.q; }
  return {
    dias, n: parados.reduce((a, p) => a + p.q, 0), valor: parados.reduce((a, p) => a + p.custo * p.q, 0), faixas,
    top: parados.sort((a, b) => b.custo * b.q - a.custo * a.q || b.dias - a.dias).slice(0, 10), erros, vendidosSemBaixa,
  };
}

function textoEstoque(r) {
  if (!r.n && !r.erros.length) return `Nenhum aparelho parado há ${r.dias} dias ou mais no Mercado Phone. 👏`;
  const linhas = [`📦 Aparelhos parados há ${r.dias}+ dias: ${r.n} unidade${r.n !== 1 ? 's' : ''}, ${brl(r.valor)} em custo.`];
  const ordem = [`${r.dias}–89 dias`, '90–179 dias', '180 dias ou mais'];
  const fx = ordem.filter(k => r.faixas[k]).map(k => `${k}: ${r.faixas[k].n} (${brl0(r.faixas[k].v)})`);
  if (fx.length) linhas.push(fx.join(' · '));
  if (r.top.length) {
    linhas.push('', 'Os que mais prendem dinheiro:');
    r.top.forEach(p => linhas.push(`• ${p.desc.slice(0, 60)} — ${brl0(p.custo)}${p.q > 1 ? ` × ${p.q}` : ''} · ${p.dias} dias${/labora|manuten|assist/.test(norm(p.disp)) ? ` · ${p.disp}` : ''}`));
  }
  if (r.erros.length) linhas.push('', `⚠️ ${r.erros.length} aparelho${r.erros.length !== 1 ? 's' : ''} com IMEI e quantidade maior que 1 (erro de cadastro no Mercado Phone), fora do total: ${r.erros.slice(0, 3).map(e => `${e.desc.slice(0, 35)} (qtd ${e.q})`).join('; ')}.`);
  if (r.vendidosSemBaixa) linhas.push(`ℹ️ ${r.vendidosSemBaixa} aparelho${r.vendidosSemBaixa !== 1 ? 's' : ''} já vendido${r.vendidosSemBaixa !== 1 ? 's' : ''} ainda aparece${r.vendidosSemBaixa !== 1 ? 'm' : ''} no estoque do MP (sem baixa) e ficou de fora.`);
  return linhas.join('\n');
}

// ── 2. Ranking de vendedores ────────────────────────────────────────────────────
async function rankingVendedores(clienteId, chaves, ini, fim) {
  const vendas = await vendasPeriodo(clienteId, chaves, ini, fim);
  const por = {};
  for (const i of vendas) {
    const nome = i.vend || 'Sem vendedor';
    const x = por[nome] ||= { nome, vendas: new Set(), fat: 0, lucro: 0, aparelhos: 0 };
    x.vendas.add(i.v); x.fat += i.fat; x.lucro += i.fat - i.custo; if (i.ap) x.aparelhos += i.q;
  }
  const lista = Object.values(por).map(x => ({ ...x, vendas: x.vendas.size })).filter(x => x.vendas).sort((a, b) => b.fat - a.fat);
  return { ini, fim, lista, totalFat: lista.reduce((a, x) => a + x.fat, 0) };
}

function textoRanking(r, periodo, vendedor) {
  if (!r.lista.length) return `Nenhuma venda concluída no Mercado Phone ${periodo || 'no período'}.`;
  const medalha = ['🥇', '🥈', '🥉'];
  // Pergunta sobre um vendedor: a resposta começa por ele e o ranking vem depois, como contexto
  const alvo = vendedor ? r.lista.findIndex(x => norm(x.nome).includes(norm(vendedor)) || norm(vendedor).includes(norm(x.nome))) : -1;
  const destaque = [];
  if (vendedor && alvo < 0) destaque.push(`Não achei vendas de ${vendedor} ${periodo || 'no período'} no Mercado Phone.`, '');
  if (alvo >= 0) { const x = r.lista[alvo]; destaque.push(`${x.nome} vendeu ${brl0(x.fat)} ${periodo || 'no período'}: ${x.vendas} venda${x.vendas !== 1 ? 's' : ''}, lucro de ${brl0(x.lucro)} (${x.fat ? ((x.lucro / x.fat) * 100).toFixed(1) : 0}%). Ficou em ${alvo + 1}º lugar.`, ''); }
  const linhas = [...destaque, `🏆 Ranking de vendedores ${periodo || `de ${dataBR(r.ini)} a ${dataBR(r.fim)}`} (faturamento no Mercado Phone):`];
  r.lista.forEach((x, idx) => linhas.push(
    `${medalha[idx] || `${idx + 1}.`} ${x.nome} — ${brl0(x.fat)} · ${x.vendas} venda${x.vendas !== 1 ? 's' : ''} · ticket ${brl0(x.fat / x.vendas)} · lucro ${brl0(x.lucro)} (${x.fat ? ((x.lucro / x.fat) * 100).toFixed(1) : 0}%)${x.aparelhos ? ` · ${x.aparelhos} aparelho${x.aparelhos !== 1 ? 's' : ''}` : ''}`));
  linhas.push('', `Total: ${brl0(r.totalFat)}`);
  return linhas.join('\n');
}

// ── 3 e 4. Clientes ─────────────────────────────────────────────────────────────
// Venda para outra loja do mesmo grupo (ex.: "LOSS PATO BRANCO" comprando da Loss Beltrão) é transferência, não cliente
const GENERICAS = new Set(['tecnologia', 'imports', 'import', 'store', 'celular', 'celulares', 'cell', 'phone', 'iphone', 'apple', 'comercio', 'ltda', 'loja', 'centro']);
function palavrasDaLoja(nomes) {
  return [...new Set(nomes.flatMap(n => norm(n).split(/[^a-z0-9]+/)).filter(p => p.length >= 4 && !GENERICAS.has(p)))];
}

function agruparClientes(vendas, palavrasLoja = []) {
  const por = {};
  for (const i of vendas) {
    if (clienteGenerico(i.cli)) continue;
    if (palavrasLoja.some(p => norm(i.cli).split(/[^a-z0-9]+/).includes(p))) continue;
    // Pelo nome: a mesma pessoa tem um id em cada empresa do MP (ex.: Meu iPhone e Riachi da Aura)
    const k = norm(i.cli);
    const x = por[k] ||= { cids: new Set(), nome: i.cli, compras: new Set(), total: 0, ultima: '' };
    if (i.cid) x.cids.add(i.cid);
    x.compras.add(i.v); x.total += i.fat; if (i.d > x.ultima) x.ultima = i.d;
  }
  return Object.values(por).map(x => ({ ...x, cids: [...x.cids], compras: x.compras.size }));
}

// 12 meses de vendas, base das duas consultas de clientes (mesmo cache)
async function vendas12Meses(clienteId, chaves, comIni = false) {
  const fim = hojeISO();
  const d = new Date(`${fim}T12:00:00`); d.setMonth(d.getMonth() - 12); d.setDate(1);
  const ini = d.toISOString().slice(0, 10);
  const vendas = await vendasPeriodo(clienteId, chaves, ini, fim);
  return comIni ? { ini, vendas } : vendas;
}

async function melhoresClientes(clienteId, chaves, meses = 6, palavrasLoja = []) {
  const fim = hojeISO();
  const d = new Date(`${fim}T12:00:00`); d.setMonth(d.getMonth() - meses); d.setDate(1);
  const ini = d.toISOString().slice(0, 10);
  const lista = agruparClientes((await vendas12Meses(clienteId, chaves)).filter(i => i.d >= ini), palavrasLoja).sort((a, b) => b.total - a.total).slice(0, 10);
  return { meses, ini, lista };
}

function textoMelhores(r) {
  if (!r.lista.length) return 'Não achei vendas com cliente identificado no Mercado Phone nesse período.';
  const linhas = [`⭐ Top ${r.lista.length} clientes desde ${dataBR(r.ini)} (Mercado Phone):`];
  r.lista.forEach((c, i) => linhas.push(`${i + 1}. ${c.nome} — ${brl0(c.total)} · ${c.compras} compra${c.compras !== 1 ? 's' : ''} · última em ${dataBR(c.ultima)}`));
  return linhas.join('\n');
}

async function clientesSumidos(clienteId, chaves, diasSem = 90, palavrasLoja = []) {
  const fim = hojeISO();
  const { ini, vendas } = await vendas12Meses(clienteId, chaves, true);
  const todos = agruparClientes(vendas, palavrasLoja);
  const sumidos = todos.filter(c => diasEntre(c.ultima, fim) >= diasSem).sort((a, b) => b.total - a.total).slice(0, 10);
  // Telefone do cadastro de clientes, para quem for chamar de volta
  const ids = new Set(sumidos.flatMap(c => c.cids));
  if (ids.size) {
    try {
      const clientes = (await emLotes(chaves.map(k => () => lerTudo(p => `/customers?limit=${POR_PAGINA}&page=${p}`, k.api_key, 30)), 1)).flat();
      const tel = new Map(clientes.filter(c => ids.has(c.id)).map(c => [c.id, String(c.telefone || '').trim()]));
      sumidos.forEach(c => { c.telefone = c.cids.map(id => tel.get(id)).find(Boolean) || ''; });
    } catch { /* sem telefone a lista continua valendo */ }
  }
  return { diasSem, ini, sumidos, base: todos.length };
}

function textoSumidos(r) {
  if (!r.sumidos.length) return `Nenhum cliente sumido: todos que compraram nos últimos 12 meses voltaram nos últimos ${r.diasSem} dias.`;
  const linhas = [`📞 Clientes que mais gastaram e não compram há ${r.diasSem}+ dias (últimos 12 meses):`];
  r.sumidos.forEach((c, i) => linhas.push(`${i + 1}. ${c.nome} — ${brl0(c.total)} em ${c.compras} compra${c.compras !== 1 ? 's' : ''} · última em ${dataBR(c.ultima)} (${diasEntre(c.ultima, hojeISO())} dias)${c.telefone ? ` · ${c.telefone}` : ''}`));
  linhas.push('', 'Vale um contato: são clientes que já confiaram na loja.');
  return linhas.join('\n');
}

// ── Entrada única para o agente ─────────────────────────────────────────────────
async function consultarMercadoPhone(clienteId, dados = {}) {
  const chaves = await chavesDoCliente(clienteId);
  if (!chaves.length) return 'Esta loja não tem o Mercado Phone conectado ao SOUZ, então não consigo consultar estoque, vendedores ou clientes de lá.';
  const consulta = dados.consulta;
  const { rows: [loja] } = await pool.query('SELECT nome, obs FROM clientes WHERE id = $1', [clienteId]);
  const palavrasLoja = palavrasDaLoja([loja?.nome, loja?.obs, ...chaves.map(k => k.nome)].filter(Boolean));
  const num = (v, padrao, min, max) => Math.min(max, Math.max(min, parseInt(v) || padrao));
  if (consulta === 'estoque_parado') return textoEstoque(await estoqueParado(clienteId, chaves, num(dados.dias, 60, 15, 720)));
  if (consulta === 'ranking_vendedores') {
    const hoje = hojeISO();
    const ini = /^\d{4}-\d{2}-\d{2}$/.test(dados.start_date || '') ? dados.start_date : `${hoje.slice(0, 7)}-01`;
    const fim = /^\d{4}-\d{2}-\d{2}$/.test(dados.end_date || '') && dados.end_date < hoje ? dados.end_date : hoje;
    return textoRanking(await rankingVendedores(clienteId, chaves, ini, fim), dados.periodo, dados.vendedor);
  }
  if (consulta === 'melhores_clientes') return textoMelhores(await melhoresClientes(clienteId, chaves, num(dados.meses, 6, 1, 12), palavrasLoja));
  if (consulta === 'clientes_sumidos') return textoSumidos(await clientesSumidos(clienteId, chaves, num(dados.dias, 90, 30, 330), palavrasLoja));
  return 'Consigo consultar no Mercado Phone: estoque parado, ranking de vendedores, melhores clientes e clientes sumidos. Qual delas você quer?';
}

module.exports = { consultarMercadoPhone, estoqueParado, rankingVendedores, melhoresClientes, clientesSumidos, lerTudo, chavesDoCliente, vendasPeriodo, ehPecaOuServico };
