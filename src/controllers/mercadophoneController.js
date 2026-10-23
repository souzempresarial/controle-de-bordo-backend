const pool  = require('../models/db');
const redis = require('../services/redis');

const MP_BASE  = 'https://platform.mercadophone.tech/api/v1';
const CACHE_TTL = 300; // 5 minutos

// O MP limita as consultas (429 "aguarde Ns"): espera o tempo pedido e tenta de novo, até 2 vezes
async function mpFetch(url, apiKey, timeoutMs = 30000, tentativas = 2) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const resp = await fetch(url, { headers: { 'X-API-Key': apiKey }, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  if (resp.status !== 429 || tentativas <= 0) return resp;
  const corpo = await resp.clone().json().catch(() => ({}));
  const segundos = Math.min(6, parseInt((String(corpo.detail || '').match(/(\d+)\s*s/) || [])[1]) || 4);
  await new Promise(r => setTimeout(r, segundos * 1000 + 300));
  return mpFetch(url, apiKey, timeoutMs, tentativas - 1);
}

// Mensagem para o usuário quando o MP recusa a consulta. O motivo do MP (ex.: "sistema bloqueado, validade
// expirou em 22/10") diz o que fazer; o código HTTP sozinho não diz nada
async function mensagemErroMP(resp, depois = 'Tente de novo em instantes.') {
  if (resp.status === 429) return 'O Mercado Phone está limitando as consultas agora. Aguarde uns segundos e tente de novo.';
  const detalhe = String((await resp.clone().json().catch(() => ({}))).detail || '').trim();
  if (detalhe) return `O Mercado Phone recusou a consulta: ${detalhe.replace(/\s+/g, ' ')}`;
  return `O Mercado Phone não respondeu (${resp.status}). ${depois}`;
}

async function getApiKeys(clienteId) {
  const { rows } = await pool.query(
    'SELECT id, nome, api_key, COALESCE(valor_liquido, false) AS valor_liquido FROM mercadophone_chaves WHERE cliente_id = $1 AND ativa = true ORDER BY id',
    [clienteId]
  );
  return rows;
}

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function ehPagamentoAparelho(p) {
  return normalizar(p.formaPagamentoDescricao).includes('aparelho');
}

// Nomes variam por loja ("PIX - SICOOB", "CREDITO STONE", "STONE"...).
// Maquininha sem crédito/débito no nome só é Crédito quando parcelado; senão fica pro lojista escolher.
function mapFormaVenda(descricao, parcela) {
  const f = normalizar(descricao);
  if (f.includes('pix'))                                                  return 'Pix';
  if (f.includes('debito em conta') || f.includes('transferencia') || /\bted\b/.test(f)) return 'Transferência';
  if (f.includes('credito'))                                              return 'Crédito';
  if (f.includes('debito'))                                               return 'Débito';
  if (f.includes('dinheiro') || f.includes('especie'))                    return 'Dinheiro';
  if (f.includes('boleto'))                                               return 'Boleto';
  // Maquininha com nome da loja ("MAQ FEF CELL", "MAQUINA REDE"), cartão ou link de pagamento
  if (/\bmaq|maquin|cartao|\blink\b|stone|cielo|rede\b|getnet|sumup|pagseguro|infinit/.test(f)) return 'Crédito';
  if (parseInt(parcela) > 1)                                              return 'Crédito';
  return '';
}

function fmtBRL(v) {
  return `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function resumirPagamentos(pagamentos) {
  return pagamentos.map(p => {
    const nome = (p.formaPagamentoDescricao || '').trim().replace(/\s+/g, ' ');
    const extra = ehPagamentoAparelho(p) && p.detalhes ? ` (${p.detalhes.trim().replace(/\s+/g, ' ')})` : '';
    return `${nome} ${fmtBRL(p.valor)}${extra}`;
  }).join(' · ');
}

const DETALHE_TTL      = 60 * 60 * 24 * 90; // venda fechada não muda
const DETALHE_LOTE     = 10;
const DETALHE_ORCAMENTO_MS = 20000;         // API Gateway corta em 29s

// Retorna Map vendaId → pagamentos[]. Vendas que não couberem no orçamento de tempo ficam de fora.
async function buscarPagamentosVendas(vendas, inicio) {
  const resultado = new Map();
  if (!vendas.length) return resultado;

  const chaveCache = v => `mp:venda:${v.chaveId}:${v.vendaId}`;
  try {
    const cached = await redis.mget(...vendas.map(chaveCache));
    cached.forEach((c, i) => { if (Array.isArray(c)) resultado.set(vendas[i].vendaId, c); });
  } catch (e) {
    console.warn('[MP detalhes] Redis mget error:', e.message);
  }

  const faltando = vendas.filter(v => !resultado.has(v.vendaId));
  for (let i = 0; i < faltando.length; i += DETALHE_LOTE) {
    if (Date.now() - inicio > DETALHE_ORCAMENTO_MS) {
      console.warn(`[MP detalhes] Orçamento de tempo esgotado — ${faltando.length - i} vendas sem detalhe`);
      break;
    }
    const lote = faltando.slice(i, i + DETALHE_LOTE);
    await Promise.all(lote.map(async v => {
      try {
        const r = await mpFetch(`${MP_BASE}/sales/${v.vendaId}`, v.apiKey, 10000);
        if (!r.ok) return;
        const pagamentos = (await r.json()).pagamentos || [];
        resultado.set(v.vendaId, pagamentos);
        await redis.set(chaveCache(v), pagamentos, { ex: DETALHE_TTL }).catch(() => {});
      } catch (e) {
        console.warn(`[MP detalhes] venda ${v.vendaId}:`, e.message);
      }
    }));
  }
  return resultado;
}

// tipoProduto = tipo cadastrado no MP; "premium" só vale pelo tipo, porque nomes como "CAPA PREMIUM" são capa
function mapAcessorioSub(str, tipoProduto = '') {
  if (str.includes('brinde') || tipoProduto.includes('brinde')) return 'Brindes';
  if (tipoProduto.includes('premium')) return 'Premium';
  if (str.includes('fonte')) return 'Fonte Turbo';
  if (str.includes('cabo') || str.includes('carregador')) return 'Cabo / Carregador';
  if (str.includes('pelicula') || str.includes('película') || str.includes('capa') || str.includes('case')) return 'Capa e Película';
  return 'Acessórios Geral';
}

function mapOsPagamento(forma) {
  const f = (forma || '').toLowerCase().replace(/[áàãâä]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i').replace(/[óòõôö]/g, 'o').replace(/[úùûü]/g, 'u');
  if (f.includes('pix'))                                           return 'Pix';
  if (f.includes('credito'))                                       return 'Crédito';
  if (f.includes('debito'))                                        return 'Débito';
  if (f.includes('dinheiro') || f.includes('especie'))             return 'Dinheiro';
  if (f.includes('transferencia') || f.includes('ted') || f.includes('doc')) return 'Transferência';
  if (f.includes('boleto'))                                        return 'Boleto';
  return '';
}

function mapAssistenciaSub(descricao) {
  const d = (descricao || '').toLowerCase();
  if (d.includes('tela') || d.includes('display') || d.includes('vidro'))    return 'Conserto de Tela';
  if (d.includes('bateria') || d.includes('battery'))                         return 'Troca de Bateria';
  if (d.includes('traseira') || d.includes('back glass'))                    return 'Troca de Traseira';
  if (d.includes('doc de carga') || d.includes('conector') || d.includes('carga')) return 'Doc de Carga';
  return 'Outro';
}

function mapCategoria(tipoProduto, tipoVenda, aparelho, canalVenda, marca) {
  const tv  = (tipoVenda  || '').toLowerCase();
  const ap  = (aparelho   || '').toLowerCase();
  const tp  = (tipoProduto|| '').toLowerCase();
  const cv  = (canalVenda || '').toLowerCase();
  const ma  = (marca      || '').toLowerCase();
  const str = ap || tp;

  // Assistência técnica — subcategoria baseada na descrição do serviço
  if (tv.includes('assist') || tv.includes('serviço') || tp.includes('serviço') || tp.includes('reparo'))
    return { categoria: 'Assistência Técnica', subcategoria: mapAssistenciaSub(str || tv || tp) };

  // Upgrade — detecta pelo canal de venda, tipo de venda ou descrição
  if (cv.includes('upgrade') || tv.includes('upgrade') || str.includes('upgrade'))
    return { categoria: 'Aparelhos', subcategoria: 'Upgrade' };

  // Brinde e acessório também pelo tipo do produto no MP ("CHOCOLATE - BRINDE", "ACESSÓRIOS PREMIUM"), não só pelo nome
  if (str.includes('brinde') || tp.includes('brinde'))
    return { categoria: 'Acessórios', subcategoria: 'Brindes' };
  // O tipo do produto no MP é o sinal mais confiável; o nome só decide quando o tipo é genérico ou vazio
  const tpn = normalizar(tipoProduto), apn = normalizar(aparelho), nome = apn || tpn;
  const tem = (s, kws) => kws.some(k => s.includes(k));
  const outros = sub => ({ categoria: 'Outros Produtos', subcategoria: sub });
  const acessorioKw = ['cabo', 'pelicula', 'capa', 'case', 'capinha', 'carregador', 'fonte', 'fone', 'power bank',
    'suporte', 'microfone', 'mouse', 'teclado', 'pencil', 'adaptador', 'pop socket', 'kit'];

  // Console antes de tudo: lojas cadastram PS5 como "APARELHO"
  if (tem(nome, ['playstation', 'ps5', 'ps4', 'xbox', 'nintendo', 'videogame', 'video game', 'console']) || tem(tpn, ['playstation', 'console', 'videogame']))
    return outros('Eletrônicos');

  // "CAPA PARA CELULAR" também tem "celular" no tipo: com palavra de acessório não é aparelho
  const ehCelular = tem(tpn, ['celular', 'smartphone', 'aparelho']) && !tem(tpn, acessorioKw) && !tem(tpn, ['acess']);
  // Linha Apple vem pelo nome mesmo quando o MP marca como notebook ou tablet
  const ehAcessorio = tem(tpn, ['acess']) || tem(tpn, acessorioKw) || tem(apn, acessorioKw);
  if (!ehAcessorio && nome.includes('macbook'))                         return { categoria: 'Aparelhos', subcategoria: 'Mac' };
  if (!ehAcessorio && nome.includes('ipad'))                            return { categoria: 'Aparelhos', subcategoria: 'iPad' };

  if (!ehCelular) {
    if (tem(tpn, ['chip']))                                          return outros('Outro');
    if (tem(tpn, ['perfume']))                                       return outros('Perfumes');
    if (tem(tpn, ['bebida']))                                        return outros('Bebidas');
    if (tem(tpn, ['caixa de som', 'jbl']))                           return outros(nome.includes('jbl') ? 'JBL' : 'Eletrônicos');
    if (tem(tpn, ['tablet']))  return nome.includes('ipad') ? { categoria: 'Aparelhos', subcategoria: 'iPad' } : outros('Informática');
    // Relógio de outra marca (Garmin, Amazfit…) é Smartwatch; o genérico barato cadastrado como acessório segue acessório
    if (tem(tpn, ['relogio', 'smartwatch']) && !tem(tpn, ['acess']))
      return { categoria: 'Aparelhos', subcategoria: nome.includes('apple watch') ? 'Apple Watch' : 'Smartwatch' };
    if (tem(tpn, ['bike', 'bicicleta', 'patinete', 'scooter', 'eletric', 'depilador', 'secador']))  return outros('Eletrônicos');
    if (tem(tpn, ['garrafa', 'termic']))                             return outros('Outro');
    if (ehAcessorio)
      return { categoria: 'Acessórios', subcategoria: mapAcessorioSub(str, tp) };
    if (tem(nome, ['notebook']) || tem(tpn, ['notebook']))          return { categoria: 'Aparelhos', subcategoria: 'Notebook' };
    if (tem(tpn, ['informatica', 'computador']))                     return outros('Informática');
    if (tem(tpn, ['eletronic']))                                     return outros('Eletrônicos');
  }

  // Aparelhos — só com sinal de celular/Apple: o tipo "Celular" do MP, o nome ou a marca
  if (nome.includes('iphone') || (ehCelular && ma.includes('apple')))   return { categoria: 'Aparelhos', subcategoria: 'iPhone' };
  // "17 PRO MAX BE/A ANATEL": sem a palavra iPhone, mas com o código de região da Apple (BE/A, LL/A, ZD/A…)
  if (/\b[a-z]{1,2}\/a\b/.test(nome) && /\b(1[1-9]|x[rs]?|se)\b/.test(nome)) return { categoria: 'Aparelhos', subcategoria: 'iPhone' };
  if (tem(nome, ['garmin', 'amazfit', 'smartwatch', 'galaxy watch']))  return { categoria: 'Aparelhos', subcategoria: 'Smartwatch' };
  if (nome.includes('airpods'))                                         return { categoria: 'Aparelhos', subcategoria: 'AirPods' };
  if (nome.includes('apple watch'))                                     return { categoria: 'Aparelhos', subcategoria: 'Apple Watch' };
  if (nome.includes('ipad'))                                            return { categoria: 'Aparelhos', subcategoria: 'iPad' };
  if (nome.includes('macbook'))                                         return { categoria: 'Aparelhos', subcategoria: 'Mac' };
  const androidMarcas = ['samsung', 'galaxy', 'motorola', 'moto g', 'xiaomi', 'redmi', 'poco', 'realme', 'oppo', 'oneplus',
    'huawei', 'positivo', 'multilaser', 'infinix', 'zte', 'nokia', 'lg ', 'asus', 'honor', 'hotwav', 'hot wav', 'tecno', 'itel',
    'blackview', 'doogee', 'ulefone', 'umidigi', 'oukitel', 'cubot'];
  if (nome.includes('android') || androidMarcas.some(m => nome.includes(m) || ma.includes(m.trim())))
    return { categoria: 'Aparelhos', subcategoria: 'Android' };
  // Celular sem marca no nome ("14 PRO", "PREVENDA"): aparelho, sem chutar o sistema
  if (ehCelular)                                                        return { categoria: 'Aparelhos', subcategoria: 'Outro' };
  if (tem(nome, ['perfume']))                                           return outros('Perfumes');

  // Sem sinal de celular: Outros Produtos — errar aqui não infla o faturamento de aparelhos
  return outros('Outro');
}

// Valor da venda = o que o próprio MP conta no faturamento dele (valorTotal do item, já sem desconto e
// sem taxa). Não usa o pagamento: pagamento digitado errado no MP inflava a entrada (NEKTA, out/26).
// valorCliente 0 = item saiu de graça (brinde); nesse caso o valorTotal é o preço de tabela
function valorItemMP(item) {
  if (item.valorCliente != null && item.valorCliente !== '' && parseFloat(item.valorCliente) === 0) return 0;
  const total = parseFloat(item.valorTotal);
  if (!isNaN(total)) return Math.max(0, Math.round(total * 100) / 100);
  return Math.max(0, parseFloat(item.valorCliente || 0) - parseFloat(item.desconto || 0));
}

// Status da API: 'concluido', 'cancelada' ou 'orcamento' — só o primeiro é venda
function vendaConcluida(item) {
  return normalizar(item.statusVenda) === 'concluido';
}

// Chave única por produto dentro de uma venda (vendaId pode ter múltiplos produtos)
function mpItemKey(vendaId, descricao) {
  const slug = (descricao || 'X').slice(0, 20).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  return `${vendaId}:${slug}`;
}

function mapCmvSub(subcategoria, categoria) {
  if (subcategoria === 'Brindes')                          return 'Brindes';
  if ((categoria || '').toLowerCase().includes('acess'))   return 'Acessórios';
  if ((categoria || '').toLowerCase().includes('assist'))  return 'Assistência Técnica';
  const s = (subcategoria || '').toLowerCase();
  if (s.includes('iphone'))                                return 'Aparelhos iPhone';
  if (s.includes('android'))                               return 'Aparelhos Android';
  if (s.includes('airpods'))                               return 'AirPods';
  if (s.includes('smartwatch'))                            return 'Smartwatch';
  if (s.includes('notebook'))                              return 'Notebook';
  if (s.includes('apple watch') || s.includes('watch'))   return 'Apple Watch';
  if (s.includes('ipad'))                                  return 'iPad';
  if (s.includes('mac'))                                   return 'MacBook';
  if (s.includes('upgrade'))                               return 'Upgrade';
  return 'Outros';
}

async function status(req, res) {
  try {
    const keys = await getApiKeys(req.params.clienteId);
    res.json({ configurado: keys.length > 0, total: keys.length });
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function listarChaves(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT id, nome, LEFT(api_key, 6) || \'...\' || RIGHT(api_key, 4) AS api_key_masked, ativa, COALESCE(valor_liquido, false) AS valor_liquido, criado_em FROM mercadophone_chaves WHERE cliente_id = $1 ORDER BY id',
      [req.params.clienteId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[MP listarChaves]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

async function adicionarChave(req, res) {
  try {
    const { clienteId } = req.params;
    const { apiKey, nome } = req.body;
    if (!apiKey) return res.status(400).json({ erro: 'Chave obrigatória' });
    const { rows } = await pool.query(
      'INSERT INTO mercadophone_chaves (cliente_id, nome, api_key) VALUES ($1, $2, $3) RETURNING id, nome',
      [clienteId, nome || 'Principal', apiKey]
    );
    res.json({ ok: true, chave: rows[0] });
  } catch (err) {
    console.error('[MP adicionarChave]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

async function configurarChave(req, res) {
  try {
    const { clienteId, chaveId } = req.params;
    const { rows } = await pool.query(
      'UPDATE mercadophone_chaves SET valor_liquido = $1 WHERE id = $2 AND cliente_id = $3 RETURNING id, COALESCE(valor_liquido, false) AS valor_liquido',
      [!!req.body.valorLiquido, chaveId, clienteId]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Chave não encontrada' });
    res.json({ ok: true, chave: rows[0] });
  } catch (err) {
    console.error('[MP configurarChave]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

async function removerChave(req, res) {
  try {
    const { clienteId, chaveId } = req.params;
    await pool.query(
      'DELETE FROM mercadophone_chaves WHERE id = $1 AND cliente_id = $2',
      [chaveId, clienteId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[MP removerChave]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

// mantido para compatibilidade com chave legada
async function salvarChave(req, res) {
  return adicionarChave(req, res);
}

async function preview(req, res) {
  const inicio = Date.now();
  try {
    const { clienteId } = req.params;
    const { dataInicio, dataFim } = req.body;

    const chaves = await getApiKeys(clienteId);
    if (!chaves.length) return res.status(400).json({ erro: 'Chave do Mercado Phone não configurada' });

    const LIMIT = 300;

    // A API do MP ignora offset e devolve no máximo 300 itens por página; as seguintes vêm com o parâmetro page.
    // Para capturar itens do último dia do mês registrados com atraso no sistema, fazemos duas consultas:
    //   1. Mês completo: dataInicio → dataFim (captura a maioria dos itens)
    //   2. Último dia: dataFim → dataFim+1d (captura itens registrados no dia seguinte)
    // Depois filtramos para só manter itens com dataVenda <= dataFim.
    function buildQueries() {
      const queries = [];
      // Consulta principal do mês
      queries.push({ dataVendaInicial: dataInicio, dataVendaFinal: dataFim });
      // Consulta extra do último dia (para itens registrados com atraso)
      if (dataFim) {
        const [fy, fm, fd] = dataFim.split('-').map(Number);
        const nextDay = new Date(fy, fm - 1, fd + 1).toISOString().slice(0, 10);
        queries.push({ dataVendaInicial: dataFim, dataVendaFinal: nextDay });
      }
      return queries;
    }

    const cacheKey = `mp:preview:${clienteId}:${dataInicio}:${dataFim}`;
    let items;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('[MP preview] Cache hit:', cacheKey);
        items = cached;
      }
    } catch (e) {
      console.warn('[MP preview] Redis get error:', e.message);
    }

    if (!items) {
      const itemsMap = new Map();
      for (const chave of chaves) {
        for (const { dataVendaInicial, dataVendaFinal } of buildQueries()) {
          // Máximo de 300 itens por página: loja com mais vendas no mês precisa das páginas seguintes
          const rawItems = [];
          for (let page = 1; page <= 20; page++) {
            const params = new URLSearchParams({ limit: LIMIT, page });
            if (dataVendaInicial) params.append('dataVendaInicial', dataVendaInicial);
            if (dataVendaFinal)   params.append('dataVendaFinal',   dataVendaFinal);

            const mpResp = await mpFetch(`${MP_BASE}/sales/history?${params}`, chave.api_key);
            if (!mpResp.ok) {
              const err = await mpResp.clone().json().catch(() => ({}));
              console.error(`[MP preview] chave ${chave.id} página ${page} erro:`, err.detail || mpResp.status);
              // Lista incompleta faz venda "sumir" da importação: melhor avisar do que mostrar parte
              return res.status(503).json({ erro: await mensagemErroMP(mpResp, 'Tente de novo em instantes.') });
            }
            const body   = await mpResp.json();
            const doPage = body.items || [];
            rawItems.push(...doPage);
            if (doPage.length < LIMIT || (body.total && rawItems.length >= body.total)) break;
          }

          // Mesmo produto repetido na mesma venda (ex.: 2 MacBooks iguais) não tem id próprio na API:
          // a 1ª ocorrência fica com a chave base e as seguintes ganham "#2", "#3"… na ordem da API
          const ocorrencias = new Map();
          for (const item of rawItems) {
            // Só venda concluída: a API também devolve 'cancelada' e 'orcamento' (orçamento não é venda)
            if (!vendaConcluida(item)) continue;
            if (dataFim && (item.dataVenda || '').slice(0, 10) > dataFim) continue;

            const desc = item.aparelhoDescricao || item.tipoProdutoDescricao || '';
            const base = mpItemKey(item.vendaId, desc);
            const ord  = (ocorrencias.get(base) || 0) + 1;
            ocorrencias.set(base, ord);
            const key  = ord > 1 ? `${base}#${ord}` : base;
            if (!itemsMap.has(key)) {
              itemsMap.set(key, { ...item, _chaveNome: chave.nome, _chaveId: chave.id, _mpItemKey: key });
            }
          }
        }
      }
      items = [...itemsMap.values()];
      try {
        await redis.set(cacheKey, items, { ex: CACHE_TTL });
      } catch (e) {
        console.warn('[MP preview] Redis set error:', e.message);
      }
    }

    // Chaves já importadas — suporta formato novo "vendaId:slug" e legado "vendaId"
    const { rows: existentes } = await pool.query(
      `SELECT obs, descricao FROM lancamentos WHERE cliente_id = $1 AND obs LIKE '[MP-%' AND tipo = 'Entrada'`,
      [clienteId]
    );
    const idsImportados = new Set();
    const antigasPorChave = new Map();
    existentes.forEach(r => {
      const match = r.obs?.match(/\[MP-([^\] ]+)\]/)?.[1];
      if (!match) return;
      idsImportados.add(match);
      if (!match.includes(':') && r.descricao) {
        // Formato antigo "[MP-<venda>]": 2 itens iguais na venda viram base e base#2, como na chave nova
        const k2  = mpItemKey(match, r.descricao);
        const ord = (antigasPorChave.get(k2) || 0) + 1;
        antigasPorChave.set(k2, ord);
        idsImportados.add(ord > 1 ? `${k2}#${ord}` : k2);
      }
    });

    // Lançamentos manuais (sem tag MP) — para detectar possíveis duplicatas
    const { rows: manuais } = await pool.query(
      `SELECT data::text, valor FROM lancamentos
       WHERE cliente_id = $1 AND tipo = 'Entrada'
       AND (obs IS NULL OR obs NOT LIKE '[MP-%')`,
      [clienteId]
    );
    const chavesManuais = new Set(
      manuais.map(r => `${r.data.slice(0, 10)}-${parseFloat(r.valor).toFixed(2)}`)
    );

    const valorFinalItem = valorItemMP;
    const keyDoItem = item => item._mpItemKey || mpItemKey(item.vendaId, item.aparelhoDescricao || item.tipoProdutoDescricao || '');

    // Pagamentos são da venda, não do item: o upgrade fica só no item de maior valor, pra não contar duas vezes
    const itemPrincipal = new Map();
    for (const item of items) {
      const atual = itemPrincipal.get(item.vendaId);
      if (!atual || valorFinalItem(item) > valorFinalItem(atual)) itemPrincipal.set(item.vendaId, item);
    }

    // Categoria que o cliente já usou para o mesmo produto em importações anteriores (inclui correções feitas na mão).
    // "Aparelhos > Outro" era o chute da regra antiga; Upgrade e Brindes dependem da venda (o mesmo carregador
    // sai de brinde numa venda e é vendido em outra), então não valem como histórico
    const { rows: histRows } = await pool.query(
      `SELECT DISTINCT ON (lower(trim(descricao))) lower(trim(descricao)) AS d, categoria, subcategoria
       FROM lancamentos
       WHERE cliente_id = $1 AND tipo = 'Entrada' AND obs LIKE '[MP-%' AND descricao IS NOT NULL
         AND NOT (categoria = 'Aparelhos' AND subcategoria IN ('Outro', 'Upgrade'))
         AND subcategoria IS DISTINCT FROM 'Brindes'
         AND categoria <> 'Assistência Técnica'
       ORDER BY lower(trim(descricao)), id DESC`,
      [clienteId]
    );
    const historicoCat = new Map(histRows.map(r => [r.d, r]));

    const chavePorId   = new Map(chaves.map(c => [c.id, c]));
    const chavePorNome = new Map(chaves.map(c => [c.nome, c]));
    const vendasPendentes = new Map();
    for (const item of items) {
      if (idsImportados.has(keyDoItem(item)) || vendasPendentes.has(item.vendaId)) continue;
      const chave = chavePorId.get(item._chaveId) || chavePorNome.get(item._chaveNome) || chaves[0];
      vendasPendentes.set(item.vendaId, { vendaId: item.vendaId, chaveId: chave.id, apiKey: chave.api_key });
    }
    const pagamentosPorVenda = await buscarPagamentosVendas([...vendasPendentes.values()], inicio);
    console.log(`[MP preview] ${vendasPendentes.size} vendas pendentes, ${pagamentosPorVenda.size} com pagamentos (${Date.now() - inicio}ms)`);

    const transacoes = items.map(item => {
      const regra = mapCategoria(
        item.tipoProdutoDescricao, item.tipoVendaDescricao, item.aparelhoDescricao,
        item.canalVendaDescricao, item.marcaDescricao
      );
      const valorFinal    = valorFinalItem(item);
      // Sinais fortes vencem o histórico: a palavra "brinde", upgrade e assistência
      const sinalForte = ['Upgrade', 'Brindes'].includes(regra.subcategoria) || regra.categoria === 'Assistência Técnica';
      const hist = !sinalForte
        ? historicoCat.get((item.aparelhoDescricao || item.tipoProdutoDescricao || '').trim().toLowerCase())
        : null;
      let { categoria, subcategoria } = hist || regra;
      // Acessório ou produto que saiu de graça na venda é brinde (o custo vai para CMV > Brindes)
      const brindeGratis = valorFinal === 0 && ['Acessórios', 'Outros Produtos'].includes(categoria) && subcategoria !== 'Brindes';
      if (brindeGratis) { categoria = 'Acessórios'; subcategoria = 'Brindes'; }

      const descontoVal   = parseFloat(item.desconto || 0);
      const qty           = parseInt(item.quantidade || 1);
      const chaveMP       = `${(item.dataVenda || '').slice(0, 10)}-${valorFinal.toFixed(2)}`;

      const pagamentos    = pagamentosPorVenda.get(item.vendaId) || [];
      const ehPrincipal   = itemPrincipal.get(item.vendaId) === item;
      const pagDinheiro   = pagamentos.filter(p => !ehPagamentoAparelho(p));
      const pagMaior      = pagDinheiro.reduce((m, p) => (!m || parseFloat(p.valor) > parseFloat(m.valor) ? p : m), null);
      const pagamentoStr  = pagMaior ? mapFormaVenda(pagMaior.formaPagamentoDescricao, pagMaior.parcela) : '';
      const valorAparel   = ehPrincipal
        ? pagamentos.filter(ehPagamentoAparelho).reduce((s, p) => s + parseFloat(p.valor || 0), 0)
        : 0;

      // Entra o valor do MP (já líquido de taxa): sem dedução separada, o faturamento bate com o dashboard do MP
      const valorVenda = valorFinal;
      const deducaoSugerida = null;

      const descricao  = item.aparelhoDescricao || item.tipoProdutoDescricao || '';
      const itemKey    = keyDoItem(item);
      const jaImp      = idsImportados.has(itemKey);

      return {
        mpVendaId:         item.vendaId,
        mpItemKey:         itemKey,
        data:              (item.dataVenda || '').slice(0, 10),
        valor:             valorVenda,
        cmvValor:          parseFloat(item.valorCusto || 0),
        quantidade:        qty,
        categoria,
        subcategoria,
        descricao,
        pagamento:         pagamentoStr,
        status:            (item.statusVenda || '').toLowerCase() === 'cancelado' ? 'Cancelado' : 'Confirmado',
        vendedorNome:      item.vendedorNome        || '',
        clienteNome:       item.clienteNome         || '',
        tipoVendaOriginal: item.tipoVendaDescricao  || '',
        canalOriginal:     item.canalVendaDescricao || '',
        desconto:          descontoVal > 0 ? descontoVal : null,
        deducaoSugerida,
        categoriaPeloHistorico: !!hist && !brindeGratis,
        isUpgrade:         valorAparel > 0,
        valorUpgrade:      valorAparel > 0 ? valorAparel : '',
        resumoPagamentos:  ehPrincipal && pagamentos.length ? resumirPagamentos(pagamentos) : '',
        jaImportado:       jaImp,
        possivelDuplicata: !jaImp && valorFinal > 0 && chavesManuais.has(chaveMP),
        // Pré-venda é venda ainda em aberto (aparelho não entregue, custo provisório): só entra depois de resolvida
        preVenda:          ehPreVenda(descricao),
        chaveNome:         item._chaveNome || '',
      };
    });

    res.json({ transacoes });
  } catch (err) {
    console.error('[MP preview]', err.message);
    res.status(500).json({ erro: err.message || 'Erro interno' });
  }
}

async function importar(req, res) {
  try {
    const { clienteId } = req.params;
    const { transacoes } = req.body;

    if (!transacoes?.length) return res.json({ importados: 0 });

    let importados = 0;
    for (const t of transacoes) {
      if (t.jaImportado) continue;

      const upgradeVal  = t.valorUpgrade && parseFloat(t.valorUpgrade) > 0 ? parseFloat(t.valorUpgrade) : null;
      const isDowngrade = upgradeVal != null && upgradeVal > t.valor;
      const grupoId     = (t.cmvValor > 0 || isDowngrade) ? `g${Date.now()}${t.mpVendaId}` : null;
      const mpKey       = t.mpItemKey || String(t.mpVendaId);
      const obs         = `[MP-${mpKey}]${t.vendedorNome ? ' ' + t.vendedorNome : ''}${t.resumoPagamentos ? ' | Pagamentos: ' + t.resumoPagamentos : ''}`;

      const deducaoVal    = t.deducao && parseFloat(t.deducao) > 0 ? parseFloat(t.deducao) : null;
      const valorRecebido = deducaoVal !== null ? t.valor - deducaoVal : null;

      await pool.query(
        `INSERT INTO lancamentos
          (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, quantidade, obs, grupo_id, is_cmv, valor_upgrade, valor_recebido)
         VALUES ($1,'Entrada',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,$12,$13)`,
        [clienteId, t.valor, t.data, t.categoria, t.subcategoria || null,
         t.descricao || null, t.pagamento || null, t.status || 'Confirmado',
         t.quantidade ?? null, obs, grupoId, upgradeVal, valorRecebido]
      );

      if (t.cmvValor > 0) {
        await pool.query(
          `INSERT INTO lancamentos
            (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, obs, grupo_id, is_cmv)
           VALUES ($1,'Saída',$2,$3,'Custos Variáveis Diretos',$4,$5,$6,$7,$8,$9,true)`,
          [clienteId, t.cmvValor, t.data, mapCmvSub(t.subcategoria, t.categoria),
           'CMV — ' + (t.descricao || ''), t.pagamento || null,
           t.status || 'Confirmado',
           `CMV vinculado ao MP-${t.mpVendaId}`, grupoId]
        );
      }

      if (isDowngrade) {
        await pool.query(
          `INSERT INTO lancamentos
            (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, obs, grupo_id, is_cmv)
           VALUES ($1,'Saída',$2,$3,'Downgrade','Downgrade',$4,$5,$6,$7,$8,false)`,
          [clienteId, upgradeVal - t.valor, t.data,
           'Downgrade — ' + (t.descricao || ''), t.pagamento || null,
           t.status || 'Confirmado',
           `Downgrade vinculado ao MP-${t.mpVendaId}`, grupoId]
        );
      }

      importados++;
    }

    res.json({ importados });
  } catch (err) {
    console.error('[MP importar]', err.message);
    res.status(500).json({ erro: err.message || 'Erro interno' });
  }
}

// ── ORDENS DE SERVIÇO ────────────────────────────────────────────────────────
// Endpoint MP: GET /service-orders (verificar com Bryan se URL/campos estão corretos)

async function osPreview(req, res) {
  try {
    const { clienteId } = req.params;
    const { dataInicio, dataFim } = req.body;

    const chaves = await getApiKeys(clienteId);
    if (!chaves.length) return res.status(400).json({ erro: 'Chave do Mercado Phone não configurada' });

    const STATUS_IMPORTAVEIS = new Set(['finalizado', 'finalizada', 'entregue']);
    const LIMIT = 300;
    const itemsMap = new Map();

    // Mesma estratégia de dupla consulta usada em preview():
    // OS do último dia podem estar registradas no sistema com data do dia seguinte.
    function buildOsQueries() {
      const queries = [];
      queries.push({ dataFinalizacaoInicial: dataInicio, dataFinalizacaoFinal: dataFim });
      if (dataFim) {
        const [fy, fm, fd] = dataFim.split('-').map(Number);
        const nextDay = new Date(fy, fm - 1, fd + 1).toISOString().slice(0, 10);
        queries.push({ dataFinalizacaoInicial: dataFim, dataFinalizacaoFinal: nextDay });
      }
      return queries;
    }

    const osCacheKey = `mp:os:${clienteId}:${dataInicio}:${dataFim}`;
    let items;
    try {
      const cached = await redis.get(osCacheKey);
      if (cached) {
        console.log('[MP osPreview] Cache hit:', osCacheKey);
        items = cached;
      }
    } catch (e) {
      console.warn('[MP osPreview] Redis get error:', e.message);
    }

    if (!items) {
      for (const chave of chaves) {
        for (const { dataFinalizacaoInicial, dataFinalizacaoFinal } of buildOsQueries()) {
          const params = new URLSearchParams({ limit: LIMIT });
          if (dataFinalizacaoInicial) params.append('dataFinalizacaoInicial', dataFinalizacaoInicial);
          if (dataFinalizacaoFinal)   params.append('dataFinalizacaoFinal',   dataFinalizacaoFinal);

          const mpResp = await mpFetch(`${MP_BASE}/service-orders?${params}`, chave.api_key);
          if (!mpResp.ok) {
            const err = await mpResp.json().catch(() => ({}));
            console.error(`[MP osPreview] chave ${chave.id} erro ${mpResp.status}:`, JSON.stringify(err).slice(0, 200));
            continue;
          }
          const body = await mpResp.json();
          const rawItems = body.items || body.data || [];

          for (const item of rawItems) {
            const statusRaw = (item.situacaoDescricao || '').toLowerCase();
            if (!STATUS_IMPORTAVEIS.has(statusRaw)) continue;
            const dataFin = (item.dataFinalizacao || '').slice(0, 10);
            if (dataFim && dataFin && dataFin > dataFim) continue;
            const key = `os:${item.id}`;
            if (!itemsMap.has(key)) itemsMap.set(key, { ...item, _chaveNome: chave.nome, _chaveId: chave.id, _chaveApiKey: chave.api_key });
          }
        }
      }
      items = [...itemsMap.values()];
      try {
        await redis.set(osCacheKey, items, { ex: CACHE_TTL });
      } catch (e) {
        console.warn('[MP osPreview] Redis set error:', e.message);
      }
    }

    const { rows: existentes } = await pool.query(
      `SELECT obs FROM lancamentos WHERE cliente_id = $1 AND obs LIKE '[OS-%' AND tipo = 'Entrada'`,
      [clienteId]
    );
    const idsImportados = new Set(existentes.map(r => r.obs?.match(/\[OS-([^\]]+)\]/)?.[1]).filter(Boolean));

    const ordens = items.map(item => {
      const defeito     = (item.defeito     || '').trim();
      const queixa      = defeito || '';
      const descricao   = (defeito.length > 70 ? defeito.slice(0, 67) + '…' : defeito)
        || 'Assistência Técnica';
      const osId        = String(item.id);
      const valor       = parseFloat(item.valorTotal || 0);
      const data        = (item.dataFinalizacao || item.dataCriacao || '').slice(0, 10);
      const cmvEstimado  = Math.max(0, valor - parseFloat(item.lucro || 0));
      const subcategoria = valor === 0 ? 'Garantia' : mapAssistenciaSub(defeito + ' ' + (item.tipoDescricao || ''));

      return {
        osId,
        codigo:        item.codigo ? `#${item.codigo}` : `#${osId}`,
        data,
        valor,
        cmvEstimado,
        categoria:     'Assistência Técnica',
        subcategoria,
        descricao,
        queixa,
        tipoAparelho:  (item.tipoDescricao || '').trim(),
        status:        'Confirmado',
        clienteNome:   (item.clienteNome || '').trim(),
        tecnicoNome:   (item.tecnicoNome  || '').trim(),
        jaImportado:   idsImportados.has(osId),
        chaveNome:     item._chaveNome || '',
        chaveId:       item._chaveId   || chaves[0].id,
      };
    });

    // Mapa osId → apiKey para usar a chave correta no detalhe
    const chaveApiKeyMap = {};
    for (const item of items) chaveApiKeyMap[String(item.id)] = item._chaveApiKey || chaves[0].api_key;

    // Busca detalhe em lotes de 5 para obter nome da peça/serviço
    const BATCH = 5;
    const pendentesParaDetalhe = ordens.filter(o => !o.jaImportado);
    for (let i = 0; i < pendentesParaDetalhe.length; i += BATCH) {
      const lote = pendentesParaDetalhe.slice(i, i + BATCH);
      await Promise.all(lote.map(async (ordem) => {
        const apiKey = chaveApiKeyMap[ordem.osId] || chaves[0].api_key;
        const rDet = await mpFetch(`${MP_BASE}/service-orders/${ordem.osId}`, apiKey).catch(() => null);
        if (!rDet?.ok) return;
        const det = await rDet.json();
        const pecas = [
          ...(det.produtos || []).map(p => (p.descricao || '').trim()).filter(Boolean),
          ...(det.servicos || []).map(s => (s.descricao || '').trim()).filter(Boolean),
        ];
        if (pecas.length) {
          ordem.descricao = pecas[0];
        }
      }));
    }

    res.json({ ordens });
  } catch (err) {
    console.error('[MP osPreview]', err.message);
    res.status(500).json({ erro: err.message || 'Erro interno' });
  }
}

async function osImportar(req, res) {
  try {
    const { clienteId } = req.params;
    const { ordens } = req.body;

    if (!ordens?.length) return res.json({ importados: 0 });

    const chaves = await getApiKeys(clienteId);
    if (!chaves.length) return res.status(400).json({ erro: 'Chave do Mercado Phone não configurada' });
    const chaveMap = Object.fromEntries(chaves.map(c => [c.id, c.api_key]));
    const getKey = (chaveId) => chaveMap[chaveId] || chaves[0].api_key;

    const pendentes = ordens.filter(os => !os.jaImportado);
    let importados = 0;
    const BATCH = 5;

    for (let i = 0; i < pendentes.length; i += BATCH) {
      const lote = pendentes.slice(i, i + BATCH);

      await Promise.all(lote.map(async (os) => {
        // Busca detalhe para CMV real e forma de pagamento
        let cmvReal = os.cmvEstimado || 0;
        let pagamento = '';
        let descricaoFinal = os.descricao;

        const rDet = await mpFetch(`${MP_BASE}/service-orders/${os.osId}`, getKey(os.chaveId)).catch(() => null);

        if (rDet?.ok) {
          const det = await rDet.json();

          // CMV: usa valor editado pelo usuário se ele alterou explicitamente; senão usa o real da API
          if (!os.cmvEditado) {
            const prods = det.produtos || [];
            const servs = det.servicos || [];
            cmvReal = prods.reduce((s, p) => s + parseFloat(p.valorCusto || 0), 0)
                    + servs.reduce((s, sv) => s + parseFloat(sv.valorCusto || 0), 0);
          }

          // Pagamento: usa seleção do usuário se preencheu; senão usa o da API
          if (!os.pagamento) {
            const formas = (det.financeiros || []).flatMap(f => (f.pagamentos || []).map(p => p.formaPagamentoDescricao));
            pagamento = mapOsPagamento(formas[0] || '');
          } else {
            pagamento = os.pagamento;
          }

          if (!os.descricaoEditada) {
            const pecas = [
              ...(det.produtos || []).map(p => (p.descricao || '').trim()).filter(Boolean),
              ...(det.servicos || []).map(s => (s.descricao || '').trim()).filter(Boolean),
            ];
            if (pecas.length) descricaoFinal = pecas[0];
          }
        }

        const obs     = `[OS-${os.osId}]${os.tecnicoNome ? ' ' + os.tecnicoNome : ''}`;
        const grupoId = cmvReal > 0 ? `g${Date.now()}${os.osId}` : null;

        await pool.query(
          `INSERT INTO lancamentos
            (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, obs, grupo_id, is_cmv, origem)
           VALUES ($1,'Entrada',$2,$3,$4,$5,$6,$7,$8,$9,$10,false,'mp')`,
          [clienteId, os.valor, os.data, 'Assistência Técnica', os.subcategoria || 'Outro',
           descricaoFinal, pagamento || null, os.status || 'Confirmado', obs, grupoId]
        );

        if (cmvReal > 0) {
          await pool.query(
            `INSERT INTO lancamentos
              (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, status, obs, grupo_id, is_cmv, origem)
             VALUES ($1,'Saída',$2,$3,'Custos Variáveis Diretos','Assistência Técnica',$4,$5,$6,$7,true,'mp')`,
            [clienteId, cmvReal, os.data, `CMV — ${os.descricao}`,
             os.status || 'Confirmado', `CMV vinculado ao OS-${os.osId}`, grupoId]
          );
        }

        importados++;
      }));
    }

    res.json({ importados });
  } catch (err) {
    console.error('[MP osImportar]', err.message);
    res.status(500).json({ erro: err.message || 'Erro interno' });
  }
}

// ── CONCILIAÇÃO ──────────────────────────────────────────────────────────────
// A importação é uma foto do MP. Depois dela a loja cancela venda, edita valor/custo, troca o aparelho
// (ex.: PREVENDA vira o iPhone entregue)... conferir() compara o que já foi importado com o MP de agora
// e propõe ajustes; aplicarConciliacao() grava e guarda o "antes" de cada linha para desfazer.

const TOLERANCIA = 0.05;
const ehPreVenda = desc => /pr[eé][\s-]?venda/i.test(desc || '');

// Regra antiga (até out/26): cobrado − desconto. Só para reconhecer lançamentos importados por ela
function valorCobradoItem(item) {
  const cobrado = item.valorCliente != null && item.valorCliente !== '' ? item.valorCliente : item.valorTotal;
  return Math.max(0, parseFloat(cobrado || 0) - parseFloat(item.desconto || 0));
}
const bateValor = (item, valor) =>
  Math.abs(valorItemMP(item) - valor) <= TOLERANCIA || Math.abs(valorCobradoItem(item) - valor) <= TOLERANCIA;

let logPronto = null;
function garantirLogConciliacao() {
  logPronto ||= pool.query(`
    CREATE TABLE IF NOT EXISTS mp_conciliacao_log (
      id             SERIAL PRIMARY KEY,
      lote_id        TEXT NOT NULL,
      cliente_id     INTEGER NOT NULL,
      acao           TEXT NOT NULL,
      lancamento_id  INTEGER NOT NULL,
      antes          JSONB NOT NULL,
      criado_em      TIMESTAMPTZ DEFAULT NOW(),
      desfeito_em    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS mp_conciliacao_log_lote ON mp_conciliacao_log (cliente_id, lote_id);
  `).catch(err => { logPronto = null; throw err; });
  return logPronto;
}

async function lerVendasMP(chaves, inicio, fim) {
  // Venda do último dia às vezes fica registrada com a data do dia seguinte (mesma folga da prévia)
  const [fy, fm, fd] = fim.split('-').map(Number);
  const fimMais1 = new Date(fy, fm - 1, fd + 1).toISOString().slice(0, 10);
  const itens = [];
  const statusVenda = new Map();
  for (const chave of chaves) {
    const brutos = [];
    for (let page = 1; page <= 20; page++) {
      const params = new URLSearchParams({ limit: 300, page, dataVendaInicial: inicio, dataVendaFinal: fimMais1 });
      const resp = await mpFetch(`${MP_BASE}/sales/history?${params}`, chave.api_key);
      if (!resp.ok) {
        const err = new Error(await mensagemErroMP(resp));
        err.status = 503;
        throw err;
      }
      const body = await resp.json();
      const doPage = body.items || [];
      brutos.push(...doPage);
      if (doPage.length < 300 || (body.total && brutos.length >= body.total)) break;
    }
    // Mesma chave da importação, inclusive o "#2", "#3" de produto repetido na mesma venda
    const ocorrencias = new Map();
    for (const item of brutos) {
      statusVenda.set(String(item.vendaId), normalizar(item.statusVenda));
      if (!vendaConcluida(item)) continue;
      const base = mpItemKey(item.vendaId, item.aparelhoDescricao || item.tipoProdutoDescricao || '');
      const ord  = (ocorrencias.get(base) || 0) + 1;
      ocorrencias.set(base, ord);
      itens.push({ ...item, _key: ord > 1 ? `${base}#${ord}` : base, _chave: chave });
    }
  }
  return { itens, statusVenda };
}

async function calcularAjustes(clienteId, inicio, fim) {
  const chaves = await getApiKeys(clienteId);
  if (!chaves.length) { const e = new Error('Chave do Mercado Phone não configurada'); e.status = 400; throw e; }

  const { rows: entradas } = await pool.query(
    `SELECT id, data::text, descricao, valor::float, valor_recebido::float, categoria, subcategoria, obs, grupo_id
     FROM lancamentos
     WHERE cliente_id = $1 AND tipo = 'Entrada' AND obs LIKE '[MP-%' AND data BETWEEN $2 AND $3`,
    [clienteId, inicio, fim]
  );
  if (!entradas.length) return [];

  const chaveDe = l => l.obs.slice(4, l.obs.indexOf(']'));
  const vendaDe = l => chaveDe(l).split(':')[0];
  const vendaIds = [...new Set(entradas.map(vendaDe))];
  const { rows: saidas } = await pool.query(
    `SELECT id, descricao, valor::float, subcategoria, obs, grupo_id, is_cmv
     FROM lancamentos WHERE cliente_id = $1 AND tipo = 'Saída' AND obs = ANY($2)`,
    [clienteId, vendaIds.flatMap(v => [`CMV vinculado ao MP-${v}`, `Downgrade vinculado ao MP-${v}`])]
  );
  // CMV/downgrade gravados junto com a entrada: mesmo grupo e descrição "CMV — <descrição da entrada>"
  const vinculadas = l => saidas.filter(s =>
    s.obs.endsWith(`MP-${vendaDe(l)}`) && s.grupo_id === l.grupo_id &&
    (s.descricao === `CMV — ${l.descricao || ''}` || s.descricao === `Downgrade — ${l.descricao || ''}`));

  const { itens, statusVenda } = await lerVendasMP(chaves, inicio, fim);
  const mpPorChave = new Map(itens.map(i => [i._key, i]));
  const chavesImportadas = new Set(entradas.map(chaveDe));

  const ajustes = [];
  const porVenda = new Map();
  for (const l of entradas) { const v = vendaDe(l); if (!porVenda.has(v)) porVenda.set(v, []); porVenda.get(v).push(l); }

  for (const [vendaId, doSistema] of porVenda) {
    const st    = statusVenda.get(vendaId);
    const data  = doSistema[0].data;
    const desc  = doSistema.map(l => l.descricao).join(' + ');
    const soma  = doSistema.reduce((a, l) => a + l.valor, 0);
    const apagarTudo = () => doSistema.flatMap(l => [l.id, ...vinculadas(l).map(s => s.id)]);

    if (st && st !== 'concluido') {
      ajustes.push({ id: `cancelada:${vendaId}`, tipo: 'cancelada', vendaId, data, descricao: desc,
        valorAtual: soma, valorNovo: 0, marcado: true,
        motivo: st === 'orcamento' ? 'Virou orçamento no Mercado Phone' : 'Venda cancelada no Mercado Phone',
        apagar: apagarTudo(), alterar: [] });
      continue;
    }
    if (!st) {
      ajustes.push({ id: `sumiu:${vendaId}`, tipo: 'sumiu', vendaId, data, descricao: desc,
        valorAtual: soma, valorNovo: 0, marcado: false,
        motivo: 'Não achei essa venda no Mercado Phone neste período (pode ter mudado de data ou sido apagada)',
        apagar: apagarTudo(), alterar: [] });
      continue;
    }

    // Casa cada lançamento com o item do MP pela chave; se não bater (importação antiga gravava só
    // "[MP-<venda>]", sem o item), pela descrição dentro da mesma venda. Só sobra órfão o que mudou de verdade
    const doMP  = itens.filter(i => String(i.vendaId) === vendaId);
    const par   = new Map();
    const usado = new Set();
    for (const l of doSistema) {
      const it = mpPorChave.get(chaveDe(l));
      if (it && String(it.vendaId) === vendaId) { par.set(l, it); usado.add(it); }
    }
    for (const l of doSistema.filter(x => !par.has(x))) {
      const livres = doMP.filter(i => !usado.has(i) && !chavesImportadas.has(i._key) &&
        normalizar(i.aparelhoDescricao || i.tipoProdutoDescricao) === normalizar(l.descricao));
      const it = livres.find(i => bateValor(i, l.valor)) || livres[0];
      if (it) { par.set(l, it); usado.add(it); }
    }
    // Mesmo valor com outro nome = item renomeado (cadastro do MP mudou, ou PREVENDA virou o aparelho entregue):
    // renomeia e confere o custo em vez de apagar e importar de novo
    // Produto que ainda existe na venda do MP, mas já foi casado com outro lançamento = lançado em dobro
    const nomeMP    = i => normalizar(i.aparelhoDescricao || i.tipoProdutoDescricao);
    const mesmoNome = l => doMP.filter(i => nomeMP(i) === normalizar(l.descricao)).length;
    const emDobro   = doSistema.filter(l => !par.has(l) && mesmoNome(l) > 0);
    for (const l of emDobro) {
      const noSistema = doSistema.filter(x => normalizar(x.descricao) === normalizar(l.descricao)).length;
      ajustes.push({ id: `dobro:${l.id}`, tipo: 'dobro', vendaId, data: l.data, descricao: l.descricao,
        valorAtual: l.valor, valorNovo: 0, marcado: true,
        motivo: `Lançado em dobro: a venda tem ${mesmoNome(l)} "${(l.descricao || '').trim()}" no Mercado Phone e o sistema tem ${noSistema}`,
        apagar: [l.id, ...vinculadas(l).map(s => s.id)], alterar: [] });
    }
    const renomeados = new Set();
    for (const l of doSistema.filter(x => !par.has(x) && !emDobro.includes(x))) {
      const it = doMP.find(i => !usado.has(i) && !chavesImportadas.has(i._key) && bateValor(i, l.valor));
      if (it) { par.set(l, it); usado.add(it); renomeados.add(l); }
    }
    const orfaos = doSistema.filter(l => !par.has(l) && !emDobro.includes(l));
    const novos  = doMP.filter(i => !usado.has(i) && !chavesImportadas.has(i._key));
    if (orfaos.length) {
      const trocado = novos.length > 0;
      ajustes.push({ id: `trocado:${vendaId}`, tipo: trocado ? 'trocado' : 'removido', vendaId, data,
        descricao: orfaos.map(l => l.descricao).join(' + '),
        valorAtual: orfaos.reduce((a, l) => a + l.valor, 0),
        valorNovo: trocado ? novos.reduce((a, i) => a + valorItemMP(i), 0) : 0, marcado: true,
        motivo: trocado
          ? `No Mercado Phone o item virou: ${novos.map(i => i.aparelhoDescricao || i.tipoProdutoDescricao).join(' + ')}. Depois de corrigir, importe o item novo em "Buscar no MP"`
          : 'Item tirado da venda no Mercado Phone',
        apagar: orfaos.flatMap(l => [l.id, ...vinculadas(l).map(s => s.id)]), alterar: [] });
    }

    for (const l of doSistema) {
      const it = par.get(l);
      if (!it) continue;
      const valorMP = valorItemMP(it);
      const custo  = parseFloat(it.valorCusto || 0);
      const cmv     = vinculadas(l).find(s => s.is_cmv);
      const campos    = {};   // da entrada
      const camposCmv = {};
      const motivos   = [];

      if (renomeados.has(l)) {
        const nome = it.aparelhoDescricao || it.tipoProdutoDescricao || '';
        // Troca também a chave gravada: senão "Buscar no MP" oferece o item de novo como pendente
        campos.descricao = nome;
        campos.obs = l.obs.replace(`[MP-${chaveDe(l)}]`, `[MP-${it._key}]`);
        if (cmv) camposCmv.descricao = `CMV — ${nome}`;
        motivos.push(`No Mercado Phone o item virou: ${nome}`);
      }

      // Entrada antiga com taxa separada (valor cheio + valor_recebido) também volta para o valor do MP, sem dedução
      if (Math.abs(l.valor - valorMP) > TOLERANCIA || l.valor_recebido != null) {
        if (valorMP === 0) {
          campos.valor = 0; campos.valor_recebido = null;
          if (['Acessórios', 'Outros Produtos'].includes(l.categoria)) { campos.categoria = 'Acessórios'; campos.subcategoria = 'Brindes'; }
          motivos.push('Saiu de brinde (R$ 0) no Mercado Phone');
          if (cmv && campos.subcategoria === 'Brindes') camposCmv.subcategoria = 'Brindes';
        } else {
          campos.valor = valorMP;
          if (l.valor_recebido != null) campos.valor_recebido = null;
          motivos.push(Math.abs(l.valor - valorMP) > TOLERANCIA
            ? `Valor diferente do Mercado Phone (${fmtBRL(l.valor)} aqui, ${fmtBRL(valorMP)} lá)`
            : 'Tira a taxa de cartão separada: vale o valor do Mercado Phone');
        }
      }
      if (cmv && custo > 0 && Math.abs(cmv.valor - custo) > TOLERANCIA) {
        camposCmv.valor = custo;
        motivos.push(`Custo diferente do Mercado Phone (${fmtBRL(cmv.valor)} aqui, ${fmtBRL(custo)} lá)`);
      }
      const alterar = [];
      if (Object.keys(campos).length) alterar.push({ id: l.id, campos });
      if (Object.keys(camposCmv).length) alterar.push({ id: cmv.id, campos: camposCmv });
      if (!alterar.length) continue;
      const novoValor = campos.valor;
      ajustes.push({ id: `alterado:${l.id}`, tipo: 'alterado', vendaId, data: l.data, descricao: l.descricao,
        valorAtual: l.valor, valorNovo: novoValor ?? l.valor, marcado: true,
        motivo: motivos.join(' · '), apagar: [], alterar });
    }
  }
  return ajustes.sort((a, b) => a.data.localeCompare(b.data));
}

async function conferir(req, res) {
  try {
    const { clienteId } = req.params;
    const { dataInicio, dataFim } = req.body;
    if (!dataInicio || !dataFim) return res.status(400).json({ erro: 'Informe o período' });
    const ajustes = await calcularAjustes(clienteId, dataInicio, dataFim);
    // O que vai pro navegador é só pra mostrar; aplicar recalcula no servidor
    res.json({ ajustes: ajustes.map(({ apagar, alterar, ...a }) => ({ ...a, linhasApagadas: apagar.length, linhasAlteradas: alterar.length })) });
  } catch (err) {
    console.error('[MP conferir]', err.message);
    res.status(err.status || 500).json({ erro: err.message || 'Erro interno' });
  }
}

const CAMPOS_EDITAVEIS = new Set(['valor', 'valor_recebido', 'categoria', 'subcategoria', 'descricao', 'obs']);

async function aplicarConciliacao(req, res) {
  const { clienteId } = req.params;
  const { dataInicio, dataFim, ids } = req.body;
  if (!dataInicio || !dataFim || !ids?.length) return res.status(400).json({ erro: 'Nada para corrigir' });
  let client;
  try {
    await garantirLogConciliacao();
    // Recalcula agora: aplica só o que ainda é diferente no MP (não confia na lista que veio da tela)
    const escolhidos = (await calcularAjustes(clienteId, dataInicio, dataFim)).filter(a => ids.includes(a.id));
    if (!escolhidos.length) return res.json({ aplicados: 0 });

    const loteId = `c${Date.now()}`;
    client = await pool.connect();
    await client.query('BEGIN');
    const guardar = (acao, id) => client.query(
      `INSERT INTO mp_conciliacao_log (lote_id, cliente_id, acao, lancamento_id, antes)
       SELECT $1, $2, $3, id, to_jsonb(l) FROM lancamentos l WHERE id = $4 AND cliente_id = $2`,
      [loteId, clienteId, acao, id]);

    for (const a of escolhidos) {
      for (const id of a.apagar) {
        await guardar('apagado', id);
        await client.query('DELETE FROM lancamentos WHERE id = $1 AND cliente_id = $2', [id, clienteId]);
      }
      for (const { id, campos } of a.alterar) {
        const cols = Object.keys(campos).filter(c => CAMPOS_EDITAVEIS.has(c));
        if (!cols.length) continue;
        await guardar('alterado', id);
        await client.query(
          `UPDATE lancamentos SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} WHERE id = $1 AND cliente_id = $2`,
          [id, clienteId, ...cols.map(c => campos[c])]);
      }
    }
    await client.query('COMMIT');
    res.json({ aplicados: escolhidos.length, loteId });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[MP aplicarConciliacao]', err.message);
    res.status(err.status || 500).json({ erro: err.message || 'Erro interno' });
  } finally {
    client?.release();
  }
}

async function desfazerConciliacao(req, res) {
  const { clienteId } = req.params;
  const { loteId } = req.body;
  if (!loteId) return res.status(400).json({ erro: 'Informe o lote' });
  let client;
  try {
    await garantirLogConciliacao();
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, lancamento_id, antes FROM mp_conciliacao_log WHERE cliente_id = $1 AND lote_id = $2 AND desfeito_em IS NULL ORDER BY id DESC',
      [clienteId, loteId]);
    // Volta cada linha exatamente como estava (mesmo id), tanto as apagadas quanto as alteradas
    for (const r of rows) {
      await client.query('DELETE FROM lancamentos WHERE id = $1 AND cliente_id = $2', [r.lancamento_id, clienteId]);
      await client.query('INSERT INTO lancamentos SELECT * FROM jsonb_populate_record(NULL::lancamentos, $1)', [r.antes]);
    }
    await client.query('UPDATE mp_conciliacao_log SET desfeito_em = NOW() WHERE cliente_id = $1 AND lote_id = $2', [clienteId, loteId]);
    await client.query('COMMIT');
    res.json({ desfeitos: rows.length });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[MP desfazerConciliacao]', err.message);
    res.status(500).json({ erro: err.message || 'Erro interno' });
  } finally {
    client?.release();
  }
}

module.exports = { mapCategoria, status, listarChaves, adicionarChave, salvarChave, configurarChave, removerChave, preview, importar, osPreview, osImportar, conferir, aplicarConciliacao, desfazerConciliacao };
