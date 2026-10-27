const redis = require('./redis');
const { dreMensal, textoDRE } = require('./dre');
const { lerTudo, chavesDoCliente, vendasPeriodo, estoqueParado, ehPecaOuServico } = require('./mpConsultas');

// "Foto da loja": o resumo que o SOUZ AI recebe quando a pergunta não cabe numa consulta pronta.
// Junta o DRE do SOUZ com estoque, vendas do mês, contas em aberto e OS do Mercado Phone, já calculados.
// Cada parte do MP tem tempo máximo: o chat roda no API Gateway (corte em 29s), então o que não chegar fica de fora

// O job fotosHandler refaz a foto de todas as lojas várias vezes ao dia (sem pressa); o chat só lê pronto.
// Sem foto pronta, o chat lê ao vivo com limite curto e usa o que chegar
const CACHE_TTL  = 4 * 3600;
const LIMITE_MP  = 9000;
const brl0 = v => `R$ ${Math.round(Number(v || 0)).toLocaleString('pt-BR')}`;
const hojeISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const diasEntre = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

const comLimite = (promessa, ms, nome) => Promise.race([
  promessa,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${nome}: demorou mais de ${ms / 1000}s`)), ms)),
]);

// Estoque pelo custo, separado em aparelhos e acessórios; aparelho já vendido sem baixa no MP fica de fora.
// Mesma regra do Balanço: só conta o que está disponível ou em manutenção; "Em uso", "Bloqueado", "Não localizado" etc. vão à parte
async function resumoEstoque(chaves) {
  const itens = (await Promise.all(chaves.map(k => lerTudo(p => `/inventory?limit=300&page=${p}`, k.api_key, 60)))).flat();
  const r = { apCusto: 0, apVenda: 0, apUn: 0, acCusto: 0, acVenda: 0, acUn: 0, manut: 0, semCusto: 0, fora: {} };
  const norm = v => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const imeis = new Set();
  for (const i of itens) {
    const q = +i.quantidade || 0;
    if (i.excluido || q <= 0 || ehPecaOuServico(i)) continue;
    const imei = String(i.imei || '').trim();
    const aparelho = !!imei || /celular|iphone|smartphone|aparelho|macbook|ipad|tablet|watch|airpods|notebook/i.test(`${i.tipoProdutoDescricao} ${i.aparelhoDescricao}`);
    if (aparelho) {
      const ent = String(i.dataEntrada || '').slice(0, 10), ult = String(i.dataUltimaVenda || '').slice(0, 10);
      if (q <= 1 && ult && ent && ult >= ent) continue;
      // IMEI repetido ou com quantidade > 1 é erro de cadastro: conta uma unidade só
      if (imei && imeis.has(imei)) continue;
      if (imei) imeis.add(imei);
    }
    const un = aparelho && imei ? 1 : q;
    const custo = +i.valorCusto || 0, venda = +i.valorVenda || 0;
    if (!custo) r.semCusto++;
    const sit = norm(i.disponibilidade);
    if (/labora|manuten|assist|conserto/.test(sit)) { if (aparelho) r.manut += custo * un; continue; }
    if (!/disponivel/.test(sit)) {
      const nome = String(i.disponibilidade || 'sem situação').trim();
      const f = r.fora[nome] ||= { un: 0, custo: 0 };
      f.un += un; f.custo += custo * un;
      continue;
    }
    if (aparelho) { r.apCusto += custo * un; r.apVenda += venda * un; r.apUn += un; }
    else          { r.acCusto += custo * un; r.acVenda += venda * un; r.acUn += un; }
  }
  return r;
}

// Contas a receber e a pagar em aberto no financeiro do MP. Título vencido há meses costuma ser baixa esquecida
async function resumoFinanceiro(chaves) {
  const hoje = hojeISO();
  const r = { receber: 0, receberVencido: 0, receberAntigo: 0, pagar: 0, pagarVencido: 0, pagarAntigo: 0, pagar30: 0 };
  for (const k of chaves) {
    const titulos = await lerTudo(p => `/finance?limit=300&page=${p}`, k.api_key, 20);
    for (const t of titulos) {
      if (t.deletedAt || t.situacaoId !== 1) continue;
      const v = +(t.valorTotal ?? t.valor) || 0;
      const atraso = t.dataVencimento ? diasEntre(t.dataVencimento, hoje) : 0;
      const lado = t.flagTipoMovimentacao === 1 ? 'receber' : 'pagar';
      if (atraso > 60)      r[`${lado}Antigo`] += v;
      else if (atraso > 0)  r[`${lado}Vencido`] += v;
      else                  r[lado] += v;
      if (lado === 'pagar' && atraso <= 0 && atraso >= -30) r.pagar30 += v;
    }
  }
  return r;
}

async function resumoOS(chaves) {
  const hoje = hojeISO();
  const r = { abertas: 0, valor: 0, antigas: 0 };
  for (const k of chaves) {
    const os = await lerTudo(p => `/service-orders?limit=300&page=${p}`, k.api_key, 20);
    for (const o of os) {
      if (o.dataFinalizacao || o.situacaoId !== 1) continue;
      r.abertas++; r.valor += +o.valorTotal || 0;
      if (diasEntre(String(o.dataCriacao).slice(0, 10), hoje) > 90) r.antigas++;
    }
  }
  return r;
}

async function resumoVendasMes(clienteId, chaves) {
  const hoje = hojeISO();
  const vendas = await vendasPeriodo(clienteId, chaves, `${hoje.slice(0, 7)}-01`, hoje);
  const ids = new Set(vendas.map(v => v.v));
  const fat = vendas.reduce((a, v) => a + v.fat, 0), custo = vendas.reduce((a, v) => a + v.custo, 0);
  return { vendas: ids.size, fat, lucro: fat - custo, aparelhos: vendas.filter(v => v.ap).reduce((a, v) => a + v.q, 0) };
}

function textoFotoMP(p) {
  const linhas = [];
  if (p.estoque) {
    const e = p.estoque;
    linhas.push(`Estoque agora (custo): aparelhos ${brl0(e.apCusto)} em ${e.apUn} un. (preço de venda ${brl0(e.apVenda)}); acessórios ${brl0(e.acCusto)} em ${e.acUn} un. (venda ${brl0(e.acVenda)})${e.manut ? `; aparelhos em manutenção ${brl0(e.manut)}` : ''}. Total em estoque ${brl0(e.apCusto + e.acCusto + e.manut)}.${e.semCusto ? ` ${e.semCusto} produtos estão sem custo cadastrado no MP, então o valor real é maior.` : ''}`);
    const fora = Object.entries(e.fora).sort((a, b) => b[1].custo - a[1].custo);
    if (fora.length) linhas.push(`Fora do estoque vendável (não entra no total acima; ponto de atenção): ${fora.map(([n, f]) => `${n} ${f.un} un. ${brl0(f.custo)}`).join('; ')}.`);
  }
  if (p.parado) linhas.push(`Aparelhos parados há 60+ dias: ${p.parado.n} un., ${brl0(p.parado.valor)} em custo${p.parado.top.length ? `; os que mais prendem dinheiro: ${p.parado.top.slice(0, 5).map(t => `${t.desc.slice(0, 40)} ${brl0(t.custo)} (${t.dias} dias)`).join('; ')}` : ''}.`);
  if (p.vendas) {
    const v = p.vendas;
    linhas.push(`Vendas do mês no MP (até hoje): ${brl0(v.fat)} em ${v.vendas} vendas (ticket médio ${brl0(v.vendas ? v.fat / v.vendas : 0)}), lucro bruto ${brl0(v.lucro)}, ${v.aparelhos} aparelhos vendidos.`);
  }
  if (p.fin) {
    const f = p.fin;
    linhas.push(`Financeiro do MP: a receber ${brl0(f.receber)} a vencer e ${brl0(f.receberVencido)} vencido há até 60 dias; a pagar ${brl0(f.pagar)} a vencer (${brl0(f.pagar30)} nos próximos 30 dias) e ${brl0(f.pagarVencido)} vencido há até 60 dias.${f.receberAntigo || f.pagarAntigo ? ` Há ainda ${brl0(f.receberAntigo)} a receber e ${brl0(f.pagarAntigo)} a pagar vencidos há mais de 60 dias — provavelmente títulos sem baixa no MP; trate como algo a conferir, não como dinheiro certo.` : ''}`);
  }
  if (p.os) linhas.push(`Ordens de serviço abertas: ${p.os.abertas} (${brl0(p.os.valor)})${p.os.antigas ? `, ${p.os.antigas} delas abertas há mais de 90 dias` : ''}.`);
  if (p.faltou.length) linhas.push(`Não consegui ler agora do MP: ${p.faltou.join(', ')}.`);
  return linhas.join('\n');
}

// semMP: só o DRE, para quando o dado do MP já foi consultado à parte (evita ler o MP duas vezes)
// forcar + limiteMP: usados pelo job, que refaz a foto mesmo com cache e espera o MP o quanto precisar
async function fotoDaLoja(clienteId, { semMP = false, forcar = false, limiteMP = LIMITE_MP } = {}) {
  const chave = `ia:foto:${clienteId}`;
  if (!forcar) {
    const cache = await redis.get(chave).catch(() => null);
    if (cache?.texto) return cache.texto;
  }

  const hoje = hojeISO();
  const desde = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 2, 1).toLocaleDateString('sv-SE');
  const chaves = semMP ? [] : await chavesDoCliente(clienteId);

  const partesMP = chaves.length ? {
    estoque: () => resumoEstoque(chaves),
    parado:  () => estoqueParado(clienteId, chaves, 60),
    vendas:  () => resumoVendasMes(clienteId, chaves),
    fin:     () => resumoFinanceiro(chaves),
    os:      () => resumoOS(chaves),
  } : {};
  const nomes = { estoque: 'estoque', parado: 'estoque parado', vendas: 'vendas do mês', fin: 'contas a receber e a pagar', os: 'ordens de serviço' };

  const [meses, ...resultados] = await Promise.all([
    dreMensal(clienteId, desde).catch(() => []),
    ...Object.entries(partesMP).map(([k, f]) => comLimite(f(), limiteMP, k).then(v => [k, v]).catch(err => {
      console.warn('[fotoLoja]', k, err.message);
      return [k, null];
    })),
  ]);
  const mp = { faltou: [] };
  for (const [k, v] of resultados) { if (v) mp[k] = v; else mp.faltou.push(nomes[k]); }

  const blocos = [];
  blocos.push(meses.length
    ? `DRE do SOUZ (lançamentos conciliados):\n${meses.map(d => textoDRE(d, hoje)).join('\n\n')}`
    : 'DRE do SOUZ: ainda sem lançamentos nos últimos meses.');
  if (!semMP) blocos.push(chaves.length
    ? `Mercado Phone (sistema de vendas da loja), lido agora:\n${textoFotoMP(mp)}`
    : 'Mercado Phone: esta loja não tem o MP conectado ao SOUZ, então não há dado de estoque, vendas no PDV, contas a receber nem OS.');
  const texto = blocos.join('\n\n');

  // Só guarda a foto completa; se faltou parte do MP, a próxima pergunta tenta de novo
  if (!semMP && !mp.faltou.length) await redis.set(chave, { texto }, { ex: CACHE_TTL }).catch(() => {});
  return texto;
}

// Job: refaz a foto de cada loja com MP, uma por vez (o MP limita consultas por minuto)
async function atualizarFotos() {
  const pool = require('../models/db');
  const { rows } = await pool.query('SELECT DISTINCT cliente_id FROM mercadophone_chaves WHERE ativa = true');
  const resultado = { ok: 0, erro: 0 };
  for (const { cliente_id } of rows) {
    try { await fotoDaLoja(cliente_id, { forcar: true, limiteMP: 120000 }); resultado.ok++; }
    catch (err) { console.error('[fotoLoja] job', cliente_id, err.message); resultado.erro++; }
  }
  return resultado;
}

module.exports = { fotoDaLoja, atualizarFotos };
