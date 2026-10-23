const { GoogleGenAI } = require('@google/genai');
const { buildSystemPrompt, dataHoraBrasilia } = require('../prompts/agentPrompt');
const pool = require('../models/db');

const GEMINI_MODEL  = 'gemini-3.6-flash';
const MAX_HISTORICO = 30;

const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// ---------- utilidades ----------

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeValor(v) {
  if (v == null) return null;
  if (typeof v === 'number' && !isNaN(v)) return v;
  const s = String(v).replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function normalizeData(d) {
  if (!d) return hojeISO();
  if (/hoje/i.test(d)) return hojeISO();
  if (/ontem/i.test(d)) {
    const dt = new Date();
    dt.setDate(dt.getDate() - 1);
    return dt.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m1 = d.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  const m2 = d.match(/(\d{1,2})\/(\d{1,2})/);
  if (m2) {
    const ano = new Date().getFullYear();
    return `${ano}-${String(m2[2]).padStart(2,'0')}-${String(m2[1]).padStart(2,'0')}`;
  }
  return hojeISO();
}

// ---------- historico para o modelo ----------

function montarHistorico(historico) {
  return historico.slice(-MAX_HISTORICO).map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.role === 'assistant'
      ? JSON.stringify({ intent_type: 'outro', body: h.content, data: {} })
      : h.content }],
  }));
}

// ---------- Gemini via @google/genai SDK ----------

async function callGemini(mensagem, historico, systemPrompt) {
  const contents = [
    { role: 'user',  parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'Entendido. Responderei sempre em JSON conforme o formato especificado.' }] },
    ...montarHistorico(historico),
    { role: 'user',  parts: [{ text: mensagem }] },
  ];

  const resultPromise = genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: { temperature: 0.2 },
  });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout Gemini')), 15000)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? result.text;
  if (!text) throw new Error('Gemini sem resposta');
  console.log('[Agent][Gemini] Resposta bruta:', text.slice(0, 300));
  return text;
}

// ---------- DeepSeek fallback ----------

async function callDeepSeek(mensagem, historico, systemPrompt) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historico.slice(-MAX_HISTORICO).map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.role === 'assistant'
        ? JSON.stringify({ intent_type: 'outro', body: h.content, data: {} })
        : h.content,
    })),
    { role: 'user', content: mensagem },
  ];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);

  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.1, max_tokens: 500 }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'DeepSeek error');
    const text = data.choices[0].message.content;
    console.log('[Agent][DeepSeek] Resposta bruta:', text.slice(0, 300));
    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ---------- orquestrador com fallback ----------

// Nome da loja fica no campo obs do cliente (o mesmo que Relatório e Exportar usam como nome da empresa)
async function identificacaoLoja(clienteId, clienteNome) {
  try {
    const { rows: [c] } = await pool.query('SELECT trim(nome) AS nome, trim(obs) AS loja FROM clientes WHERE id = $1', [clienteId]);
    if (c?.loja) return `Loja: ${c.loja} (responsável: ${c.nome}). Quem fala "${c.loja}" está falando desta loja; chame a loja por esse nome.`;
    if (c?.nome) return `Nome da loja/empresa: ${c.nome}`;
  } catch (e) {
    console.warn('[Agent] nome da loja:', e.message);
  }
  return clienteNome ? `Nome da loja/empresa: ${clienteNome}` : '';
}

async function callLLM(mensagem, historico, clienteId, clienteNome, usuarioNome, source, telasLiberadas) {
  const promptBase   = buildSystemPrompt(dataHoraBrasilia(), usuarioNome, source, telasLiberadas, !historico?.length);
  const loja         = await identificacaoLoja(clienteId, clienteNome);
  const systemPrompt = loja ? `${promptBase}\n\n${loja}` : promptBase;

  try {
    return await callGemini(mensagem, historico, systemPrompt).catch(err => {
      // Gemini sobrecarregado devolve 503 na hora; uma nova tentativa costuma passar
      if (/503|high demand|overloaded|UNAVAILABLE/i.test(err.message)) {
        console.warn('[Agent] Gemini 503 — tentando de novo');
        return callGemini(mensagem, historico, systemPrompt);
      }
      throw err;
    });
  } catch (err) {
    console.warn('[Agent] Gemini falhou:', err.message, '— tentando DeepSeek...');
    if (process.env.DEEPSEEK_API_KEY) {
      try {
        return await callDeepSeek(mensagem, historico, systemPrompt);
      } catch (err2) {
        console.warn('[Agent] DeepSeek também falhou:', err2.message);
      }
    }
    throw new Error('Assistente indisponível no momento. Tente novamente em alguns segundos.');
  }
}

// ---------- parser ----------

function parseResposta(texto) {
  const limpo = texto.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    return JSON.parse(limpo);
  } catch {
    const match = limpo.match(/\{[\s\S]+\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return { intent_type: 'outro', body: 'Não entendi, pode reformular?', data: {} };
  }
}

// ---------- tool: criar lançamento ----------

async function criarLancamento(clienteId, tipo, dados) {
  const { rows } = await pool.query(
    `INSERT INTO lancamentos
      (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, origem)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Confirmado','ia') RETURNING *`,
    [
      clienteId,
      tipo,
      dados.valor,
      dados.data,
      dados.categoria    || null,
      dados.subcategoria || null,
      dados.descricao    || null,
      dados.metodo       || null,
    ]
  );
  return rows[0];
}

// ---------- tool: consultar lançamentos ----------

// Sem acento e minúsculo dos dois lados: "patrocínios" acha "Patrocínio", "midia" acha "Mídia"
const SEM_ACENTO = col => `translate(lower(${col}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
const semAcento  = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Cada filtro vira um grupo (categoria/subcategoria exatas ou termo livre); a busca junta todos com OU
function montarFiltro(f, params) {
  const partes = [];
  if (f.categoria) {
    params.push(f.categoria);
    partes.push(`categoria ILIKE $${params.length}`);
  }
  if (f.subcategoria) {
    params.push(`%${semAcento(f.subcategoria)}%`);
    const idx = params.length;
    partes.push(`(${SEM_ACENTO('subcategoria')} LIKE $${idx} OR ${SEM_ACENTO("COALESCE(descricao, '')")} LIKE $${idx})`);
  }
  if (f.termo) {
    // Plural vira singular ("patrocínios" → "patrocinio") pra achar a subcategoria no singular
    const termo = semAcento(f.termo).trim().replace(/(?<=\w{4})s$/, '');
    params.push(`%${termo}%`);
    const idx = params.length;
    partes.push(`(${SEM_ACENTO("COALESCE(descricao, '')")} LIKE $${idx} OR ${SEM_ACENTO("COALESCE(subcategoria, '')")} LIKE $${idx} OR ${SEM_ACENTO('categoria')} LIKE $${idx})`);
  }
  return partes.length ? `(${partes.join(' AND ')})` : null;
}

const nomeFiltro = f => { const n = String(f.termo || f.subcategoria || f.categoria); return n[0].toUpperCase() + n.slice(1); };

async function buscarLancamentos(clienteId, startDate, endDate, tipo, filtros = []) {
  const params  = [clienteId];
  let   where   = 'cliente_id = $1 AND is_cmv = false AND status != \'Cancelado\'';

  if (startDate) {
    params.push(startDate);
    where += ` AND data >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    where += ` AND data <= $${params.length}`;
  }
  if (tipo) {
    params.push(tipo);
    where += ` AND tipo = $${params.length}`;
  }
  const grupos = filtros.map(f => ({ f, sql: montarFiltro(f, params) })).filter(g => g.sql);
  if (grupos.length) where += ` AND (${grupos.map(g => g.sql).join(' OR ')})`;

  // Total e contagem sem LIMIT: a lista mostra só alguns, mas a soma tem que ser do período inteiro
  const [{ rows }, { rows: [agg] }, porGrupo, { rows: porCategoria }] = await Promise.all([
    pool.query(
      `SELECT id, tipo, valor, data, categoria, subcategoria, descricao, pagamento
       FROM lancamentos WHERE ${where} ORDER BY data DESC LIMIT 20`,
      params
    ),
    pool.query(`SELECT count(*)::int AS quantidade, COALESCE(sum(valor), 0)::float AS total FROM lancamentos WHERE ${where}`, params),
    // Mais de um filtro: soma de cada um separado. Lançamento que cai em dois filtros conta só no primeiro,
    // senão os subtotais somam mais que o total (ex.: "Assessoria de Marketing" e o termo "marketing")
    grupos.length > 1
      ? Promise.all(grupos.map((g, i) => pool.query(
          `SELECT count(*)::int AS quantidade, COALESCE(sum(valor), 0)::float AS total FROM lancamentos
           WHERE ${where} AND ${g.sql}${i ? ` AND NOT (${grupos.slice(0, i).map(x => x.sql).join(' OR ')})` : ''}`, params)
          .then(({ rows: [r] }) => ({ nome: nomeFiltro(g.f), ...r }))))
          .then(gs => gs.filter(g => g.quantidade > 0))
      : [],
    // Sem filtro: totais por categoria, que dizem mais que uma lista de 100+ lançamentos
    grupos.length
      ? { rows: [] }
      : pool.query(`SELECT categoria, count(*)::int AS quantidade, COALESCE(sum(valor), 0)::float AS total FROM lancamentos
                    WHERE ${where} GROUP BY categoria ORDER BY total DESC`, params),
  ]);
  return { rows, quantidade: agg.quantidade, total: agg.total, porGrupo, porCategoria };
}

const fmtBRL = v => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function formatarResultadoConsulta({ rows, quantidade, total, porGrupo = [], porCategoria = [] }, periodo, tipo) {
  const singular = tipo === 'Entrada' ? 'entrada' : tipo === 'Saída' ? 'saída' : 'lançamento';
  const plural   = tipo === 'Entrada' ? 'entradas' : tipo === 'Saída' ? 'saídas' : 'lançamentos';
  const label    = quantidade === 1 ? singular : plural;

  const periodoPrep = periodo
    ? ' ' + (`de ${periodo}`)
        .replace('de esta ', 'desta ')
        .replace('de esse ', 'desse ')
        .replace('de este ', 'deste ')
    : '';
  const periodoStr = periodoPrep;

  if (!rows.length) {
    return `Nenhum lançamento encontrado${periodoStr.trim() ? ' ' + periodoStr.trim() : ''}. Tente ajustar o período ou verifique se há dados cadastrados.`;
  }

  // Pedido sem filtro com muita coisa: mostra o resumo por categoria em vez de despejar a lista
  if (porCategoria.length && quantidade > 20) {
    const linhasCat = porCategoria.map(c => `• ${c.categoria || 'Sem categoria'} — ${c.quantidade} — ${fmtBRL(c.total)}`);
    return `${quantidade} ${label}${periodoStr}, por categoria:\n\n${linhasCat.join('\n')}\n\nTotal: ${fmtBRL(total)}\n\nQuer ver os lançamentos de alguma delas?`;
  }

  const exibir = rows.slice(0, 8);

  const linhas = exibir.map(r => {
    const dataISO  = r.data instanceof Date ? r.data.toISOString().slice(0, 10) : String(r.data || '').slice(0, 10);
    const [, mes, dia] = dataISO.split('-');
    const dataStr  = `${dia}/${mes}`;
    const descStr  = r.descricao || r.subcategoria || r.categoria || '—';
    const valorStr = `R$ ${parseFloat(r.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    return `• ${dataStr} — ${descStr} — ${valorStr}`;
  });

  let texto = `${quantidade} ${label}${periodoStr}:\n\n${linhas.join('\n')}`;
  if (quantidade > 8) texto += `\n... e mais ${quantidade - 8} lançamentos`;
  if (porGrupo.length) texto += `\n\n${porGrupo.map(g => `${g.nome}: ${g.quantidade} — ${fmtBRL(g.total)}`).join('\n')}`;
  texto += `\n\nTotal: ${fmtBRL(total)}`;

  return texto;
}

// ---------- ponto de entrada ----------

// telasLiberadas: slugs que um funcionário pode ver; null = dono (vê tudo)
async function processarMensagem(mensagem, historico, clienteId, clienteNome, usuarioNome, source = 'dashboard', telasLiberadas = null) {
  console.log('[Agent][1] Mensagem recebida:', mensagem, '| usuario:', usuarioNome, '| source:', source);

  const textoLLM = await callLLM(mensagem, historico, clienteId, clienteNome, usuarioNome, source, telasLiberadas);

  const parsed = parseResposta(textoLLM);
  const { intent_type, body, data: dados = {} } = parsed;
  console.log('[Agent][2] Intent:', intent_type, '| Dados:', JSON.stringify(dados));

  // ── CRIAR LANÇAMENTO ──────────────────────────────────────────────────────
  if (intent_type === 'criar_entrada' || intent_type === 'criar_saida') {
    const valorNum = normalizeValor(dados.valor);
    console.log('[Agent][3] Tool: criarLancamento | valor normalizado:', valorNum, '| data raw:', dados.data);

    if (!valorNum || valorNum <= 0) {
      console.log('[Agent][4] Valor inválido, retornando sem lançamento');
      return { resposta: body || 'Qual foi o valor?', acao: null };
    }

    const tipo       = intent_type === 'criar_entrada' ? 'Entrada' : 'Saída';
    const dataISO    = normalizeData(dados.data);
    console.log('[Agent][3] Params: tipo=%s valor=%s data=%s categoria=%s', tipo, valorNum, dataISO, dados.categoria);

    const lancamento = await criarLancamento(clienteId, tipo, { ...dados, valor: valorNum, data: dataISO });
    console.log('[Agent][4] Lançamento criado:', JSON.stringify(lancamento));

    // Diz onde o lançamento ficou, pra pessoa saber onde conferir ou corrigir
    const resposta = `${body || `${tipo} de R$ ${valorNum.toLocaleString('pt-BR')} registrada!`} Já aparece em Conciliações Bancárias.`;
    console.log('[Agent][5] Resposta final:', resposta);
    return { resposta, acao: tipo, lancamento };
  }

  // ── CONSULTAR LANÇAMENTOS ─────────────────────────────────────────────────
  if (intent_type === 'consultar_entrada' || intent_type === 'consultar_saida') {
    const tipo        = intent_type === 'consultar_entrada' ? 'Entrada' : 'Saída';
    const startDate   = dados.start_date   || null;
    const endDate     = dados.end_date     || null;
    const periodo     = dados.periodo      || null;
    // Formato antigo (categoria/subcategoria soltos) ainda vale como um filtro só
    const filtros = (Array.isArray(dados.filtros) ? dados.filtros : [{ categoria: dados.categoria, subcategoria: dados.subcategoria }])
      .filter(f => f && (f.categoria || f.subcategoria || f.termo));
    console.log('[Agent][3] Tool: buscarLancamentos | tipo=%s start=%s end=%s filtros=%s', tipo, startDate, endDate, JSON.stringify(filtros));

    const consulta = await buscarLancamentos(clienteId, startDate, endDate, tipo, filtros);
    console.log('[Agent][4] Lançamentos encontrados:', consulta.quantidade, '| total:', consulta.total);

    const resposta = formatarResultadoConsulta(consulta, periodo, tipo);
    console.log('[Agent][5] Resposta final (consulta):', resposta.slice(0, 200));
    return { resposta, acao: null };
  }

  // ── CONSULTAR ANALYTICS (RAG) ─────────────────────────────────────────────
  if (intent_type === 'consultar_analytics') {
    const { responderComContexto, ultimoResumoSemanal } = require('./analyticsService');
    const { dreMensal, textoDRE, dreSemanal, textoSemana } = require('./dre');
    const pergunta = dados.pergunta || body || mensagem;
    console.log('[Agent][3] Tool: dreMensal | pergunta=%s', pergunta);

    // Números calculados na hora com a mesma conta da tela Financeiro; o resumo salvo pelo cron fica velho e usa outra conta
    const hoje  = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const desde = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 13, 1).toLocaleDateString('sv-SE');
    // Semanas também calculadas na hora; o resumo escrito da última semana entra como contexto do que já foi dito ao dono
    const [meses, semanas, resumoSemana] = await Promise.all([
      dreMensal(clienteId, desde),
      dreSemanal(clienteId, hoje, 8),
      ultimoResumoSemanal(clienteId).catch(() => null),
    ]);
    console.log('[Agent][4] Meses com DRE:', meses.map(m => m.mes).join(','));

    if (meses.length === 0) {
      return { resposta: 'Ainda não há lançamentos suficientes nesta conta para analisar os resultados.', acao: null };
    }

    const contexto = `${meses.map(d => textoDRE(d, hoje)).join('\n\n')}

DRE por semana (segunda a domingo), mesma conta da tela:
${semanas.map(s => textoSemana(s, hoje)).join('\n')}${resumoSemana ? `

Resumo escrito da última semana fechada, gerado pelo sistema (${resumoSemana.periodo}):
${resumoSemana.resumo}` : ''}`;
    const resposta = await responderComContexto(pergunta, contexto, source);
    console.log('[Agent][5] Resposta analytics:', resposta.slice(0, 200));
    return { resposta, acao: null };
  }

  // ── CONSULTAR MERCADO PHONE ───────────────────────────────────────────────
  // A conta é feita no servidor (mpConsultas) e o texto já vai pronto: a IA só escolheu qual consulta e o período
  if (intent_type === 'consultar_mercadophone') {
    const { consultarMercadoPhone } = require('./mpConsultas');
    console.log('[Agent][3] Tool: consultarMercadoPhone | %s', JSON.stringify(dados));
    try {
      const resposta = await consultarMercadoPhone(clienteId, dados);
      console.log('[Agent][4] Resposta MP:', resposta.slice(0, 200));
      return { resposta, acao: null };
    } catch (err) {
      console.error('[Agent][MP]', err.message);
      return { resposta: /recusou/.test(err.message) ? err.message : 'Não consegui consultar o Mercado Phone agora. Tente de novo em alguns instantes.', acao: null };
    }
  }

  // ── OUTRO ─────────────────────────────────────────────────────────────────
  const resposta = body || 'Como posso ajudar?';
  console.log('[Agent][3] Sem tool. Resposta final:', resposta);
  return { resposta, acao: null };
}

module.exports = { processarMensagem };
