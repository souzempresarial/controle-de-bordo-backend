const pool  = require('../models/db');
const redis = require('../services/redis');

const MP_BASE       = 'https://platform.mercadophone.tech/api/v1';
const CACHE_TTL     = 300;
const MAX_PAGINAS   = 15;   // 15 × 300 = 4.500 produtos por loja
const MESES_VENDAS  = 3;    // janela para achar aparelho vendido sem baixa
const QTD_ALTA      = 50;

// Campos do Balanço (capital) que a importação preenche
const DESTINOS = {
  aparelhos:  'cap_estoque_aparelhos',
  acessorios: 'cap_estoque_acessorios',
  manutencao: 'cap_manutencao',
};

function mpFetch(path, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  return fetch(MP_BASE + path, { headers: { 'X-API-Key': apiKey }, signal: ctrl.signal })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`Mercado Phone respondeu ${r.status}`))))
    .finally(() => clearTimeout(timer));
}

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function classificar(item) {
  const tp = norm(item.tipoProdutoDescricao);
  if (/peca|servico/.test(tp) || item.snPeca === 1 || item.snServico === 1) return 'peca';
  if (/aparelho|macbook|ipad|watch|airpods|notebook|celular|smartphone/.test(tp) || item.imei) return 'aparelho';
  return 'acessorio';
}

// Situação no MP → onde entra no Balanço e se vem marcado
function situacao(item) {
  const d = norm(item.disponibilidade);
  if (/disponivel/.test(d))                          return { ok: true };
  if (/laborat|manuten|assist|conserto/.test(d))      return { ok: true, manutencao: true };
  return { ok: false, alerta: `Situação no Mercado Phone: ${(item.disponibilidade || 'sem situação').trim()}` };
}

function limparDescricao(item) {
  return (item.descricao || item.aparelhoDescricao || item.nome || '')
    .replace(/^\d+\s*-\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function lerEstoque(apiKey) {
  const itens = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const b = await mpFetch(`/inventory?limit=300&page=${page}`, apiKey);
    itens.push(...(b.items || []));
    if (!b.items?.length || itens.length >= (b.total || 0)) break;
  }
  return itens.filter(i => !i.excluido);
}

// IMEI → data da venda mais recente nos últimos meses
async function lerVendasPorImei(apiKey) {
  const hoje = new Date();
  const meses = Array.from({ length: MESES_VENDAS }, (_, i) => {
    const ini = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const fim = new Date(hoje.getFullYear(), hoje.getMonth() - i + 1, 0);
    return [ini.toISOString().slice(0, 10), fim.toISOString().slice(0, 10)];
  });
  const respostas = await Promise.all(meses.map(([ini, fim]) =>
    mpFetch(`/sales/history?limit=300&dataVendaInicial=${ini}&dataVendaFinal=${fim}`, apiKey).catch(() => ({ items: [] }))
  ));
  const vendas = new Map();
  for (const r of respostas) for (const s of r.items || []) {
    if ((s.statusVenda || '').toLowerCase() === 'cancelado') continue;
    for (const im of [s.imei1, s.imei2]) {
      if (!im || im.length < 8) continue;
      const data = String(s.dataVenda || '').slice(0, 10);
      if (!vendas.has(im) || vendas.get(im) < data) vendas.set(im, data);
    }
  }
  return vendas;
}

async function preview(req, res) {
  try {
    const { clienteId } = req.params;
    const { rows: chaves } = await pool.query(
      'SELECT id, nome, api_key FROM mercadophone_chaves WHERE cliente_id = $1 AND ativa = true ORDER BY id', [clienteId]
    );
    if (!chaves.length) return res.status(400).json({ erro: 'Este cliente não tem o Mercado Phone conectado.' });

    const cacheKey = `mp:patrimonio:${clienteId}`;
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached?.itens) return res.json(cached);

    const lojas = await Promise.all(chaves.map(async c => {
      const [estoque, vendas] = await Promise.all([lerEstoque(c.api_key), lerVendasPorImei(c.api_key)]);
      return { chave: c, estoque, vendas };
    }));

    const imeisVistos = new Set();
    const itens = [];
    for (const { chave, estoque, vendas } of lojas) {
      for (const item of estoque) {
        const tipo = classificar(item);
        const sit  = situacao(item);
        const alertas = [];
        let aprovado = sit.ok && tipo !== 'peca';
        if (!sit.ok) alertas.push(sit.alerta);
        if (tipo === 'peca') alertas.push('Peça ou serviço — não entra por padrão');

        const imei = (item.imei || '').trim() || null;
        if (imei) {
          if (imeisVistos.has(imei)) { alertas.push('IMEI duplicado no estoque'); aprovado = false; }
          imeisVistos.add(imei);
          const vendidoEm = vendas.get(imei);
          if (vendidoEm && (!item.dataEntrada || vendidoEm >= String(item.dataEntrada).slice(0, 10))) {
            alertas.push(`Consta como vendido em ${vendidoEm.split('-').reverse().join('/')}`);
            aprovado = false;
          }
        }
        const quantidade = Math.max(0, parseInt(item.quantidade ?? 1) || 0);
        if (tipo !== 'aparelho' && quantidade > QTD_ALTA) alertas.push(`Quantidade alta (${quantidade}) — confira`);
        const custo = parseFloat(item.valorCusto || 0);
        if (!custo) alertas.push('Sem custo cadastrado');
        if (!quantidade) aprovado = false;

        itens.push({
          mpId:            item.id,
          loja:            chave.nome,
          descricao:       limparDescricao(item),
          imei,
          tipo,
          destino:         tipo === 'aparelho' ? (sit.manutencao ? 'manutencao' : 'aparelhos') : 'acessorios',
          quantidade,
          custo,
          venda:           item.valorVenda != null ? parseFloat(item.valorVenda) : null,
          disponibilidade: (item.disponibilidade || '').trim(),
          dataEntrada:     item.dataEntrada ? String(item.dataEntrada).slice(0, 10) : null,
          alertas,
          aprovado,
        });
      }
    }

    const ordem = { aparelho: 0, acessorio: 1, peca: 2 };
    itens.sort((a, b) => ordem[a.tipo] - ordem[b.tipo] || b.custo * b.quantidade - a.custo * a.quantidade);
    const resposta = { itens, lojas: chaves.length, geradoEm: new Date().toISOString() };
    await redis.set(cacheKey, resposta, { ex: CACHE_TTL }).catch(() => {});
    res.json(resposta);
  } catch (err) {
    console.error('[patrimonio.preview]', err.message);
    res.status(502).json({ erro: 'Não consegui ler o estoque do Mercado Phone agora. Tente de novo em instantes.' });
  }
}

async function salvar(req, res) {
  const { clienteId } = req.params;
  const { mesChave, itens } = req.body;
  if (!/^\d{4}-\d{2}$/.test(mesChave || '')) return res.status(400).json({ erro: 'Mês inválido' });
  if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ erro: 'Nenhum item aprovado' });
  if (itens.some(i => !DESTINOS[i.destino])) return res.status(400).json({ erro: 'Destino inválido em algum item' });

  const limpos = itens.map(i => ({
    mp_id:           Number.isFinite(+i.mpId) ? +i.mpId : null,
    descricao:       String(i.descricao || '').slice(0, 500),
    imei:            i.imei ? String(i.imei).slice(0, 40) : null,
    tipo:            String(i.tipo || '').slice(0, 20),
    destino:         i.destino,
    quantidade:      Math.max(0, parseInt(i.quantidade) || 0),
    valor_custo:     Math.max(0, parseFloat(i.custo) || 0),
    valor_venda:     i.venda != null && Number.isFinite(+i.venda) ? +i.venda : null,
    disponibilidade: String(i.disponibilidade || '').slice(0, 60),
    data_entrada:    /^\d{4}-\d{2}-\d{2}$/.test(i.dataEntrada || '') ? i.dataEntrada : null,
  }));
  const totais = Object.fromEntries(Object.keys(DESTINOS).map(d => [d,
    limpos.filter(i => i.destino === d).reduce((s, i) => s + i.quantidade * i.valor_custo, 0)]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM patrimonio_itens WHERE cliente_id = $1 AND mes_chave = $2', [clienteId, mesChave]);
    await client.query(
      `INSERT INTO patrimonio_itens (cliente_id, mes_chave, mp_id, descricao, imei, tipo, destino, quantidade, valor_custo, valor_venda, disponibilidade, data_entrada)
       SELECT $1, $2, mp_id, descricao, imei, tipo, destino, quantidade, valor_custo, valor_venda, disponibilidade, data_entrada
       FROM json_to_recordset($3::json) AS x(mp_id bigint, descricao text, imei text, tipo text, destino text, quantidade int,
            valor_custo numeric, valor_venda numeric, disponibilidade text, data_entrada date)`,
      [clienteId, mesChave, JSON.stringify(limpos)]
    );
    for (const [destino, campo] of Object.entries(DESTINOS)) {
      await client.query(
        `INSERT INTO capital (cliente_id, mes_chave, campo, valor) VALUES ($1, $2, $3, $4)
         ON CONFLICT (cliente_id, mes_chave, campo) DO UPDATE SET valor = EXCLUDED.valor`,
        [clienteId, mesChave, campo, totais[destino].toFixed(2)]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, itens: limpos.length, capital: Object.fromEntries(Object.entries(DESTINOS).map(([d, c]) => [c, +totais[d].toFixed(2)])) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[patrimonio.salvar]', err.message);
    res.status(500).json({ erro: 'Não foi possível salvar o patrimônio' });
  } finally {
    client.release();
  }
}

async function resumo(req, res) {
  try {
    const { clienteId, mesChave } = req.params;
    const { rows: [r] } = await pool.query(
      // importado_em é TIMESTAMP sem fuso gravado em UTC; o "Z" faz o navegador converter para o horário local
      `SELECT count(*)::int AS itens, to_char(max(importado_em), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS importado_em
       FROM patrimonio_itens WHERE cliente_id = $1 AND mes_chave = $2`,
      [clienteId, mesChave]
    );
    res.json(r.itens ? r : { itens: 0, importado_em: null });
  } catch (err) {
    console.error('[patrimonio.resumo]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

module.exports = { preview, salvar, resumo, classificar, situacao };
