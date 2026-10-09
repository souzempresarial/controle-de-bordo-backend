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

async function callLLM(mensagem, historico, clienteNome, usuarioNome, source, telasLiberadas) {
  const promptBase   = buildSystemPrompt(dataHoraBrasilia(), usuarioNome, source, telasLiberadas);
  const systemPrompt = clienteNome
    ? `${promptBase}\n\nNome da loja/empresa: ${clienteNome}`
    : promptBase;

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

async function buscarLancamentos(clienteId, startDate, endDate, tipo, categoria, subcategoria) {
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
  if (categoria) {
    params.push(categoria);
    where += ` AND categoria ILIKE $${params.length}`;
  }
  if (subcategoria) {
    params.push(`%${subcategoria}%`);
    const idx = params.length;
    where += ` AND (subcategoria ILIKE $${idx} OR descricao ILIKE $${idx})`;
  }

  // Total e contagem sem LIMIT: a lista mostra só alguns, mas a soma tem que ser do período inteiro
  const [{ rows }, { rows: [agg] }] = await Promise.all([
    pool.query(
      `SELECT id, tipo, valor, data, categoria, subcategoria, descricao, pagamento
       FROM lancamentos WHERE ${where} ORDER BY data DESC LIMIT 20`,
      params
    ),
    pool.query(`SELECT count(*)::int AS quantidade, COALESCE(sum(valor), 0)::float AS total FROM lancamentos WHERE ${where}`, params),
  ]);
  return { rows, quantidade: agg.quantidade, total: agg.total };
}

function formatarResultadoConsulta({ rows, quantidade, total }, periodo, tipo) {
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
  texto += `\n\nTotal: R$ ${total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

  return texto;
}

// ---------- ponto de entrada ----------

// telasLiberadas: slugs que um funcionário pode ver; null = dono (vê tudo)
async function processarMensagem(mensagem, historico, clienteId, clienteNome, usuarioNome, source = 'dashboard', telasLiberadas = null) {
  console.log('[Agent][1] Mensagem recebida:', mensagem, '| usuario:', usuarioNome, '| source:', source);

  const textoLLM = await callLLM(mensagem, historico, clienteNome, usuarioNome, source, telasLiberadas);

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
    const categoria   = dados.categoria    || null;
    const subcategoria = dados.subcategoria || null;
    console.log('[Agent][3] Tool: buscarLancamentos | tipo=%s start=%s end=%s cat=%s sub=%s', tipo, startDate, endDate, categoria, subcategoria);

    const consulta = await buscarLancamentos(clienteId, startDate, endDate, tipo, categoria, subcategoria);
    console.log('[Agent][4] Lançamentos encontrados:', consulta.quantidade, '| total:', consulta.total);

    const resposta = formatarResultadoConsulta(consulta, periodo, tipo);
    console.log('[Agent][5] Resposta final (consulta):', resposta.slice(0, 200));
    return { resposta, acao: null };
  }

  // ── CONSULTAR ANALYTICS (RAG) ─────────────────────────────────────────────
  if (intent_type === 'consultar_analytics') {
    const { responderComContexto } = require('./analyticsService');
    const { dreMensal, textoDRE } = require('./dre');
    const pergunta = dados.pergunta || body || mensagem;
    console.log('[Agent][3] Tool: dreMensal | pergunta=%s', pergunta);

    // Números calculados na hora com a mesma conta da tela Financeiro; o resumo salvo pelo cron fica velho e usa outra conta
    const hoje  = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const desde = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 13, 1).toLocaleDateString('sv-SE');
    const meses = await dreMensal(clienteId, desde);
    console.log('[Agent][4] Meses com DRE:', meses.map(m => m.mes).join(','));

    if (meses.length === 0) {
      return { resposta: 'Ainda não há lançamentos suficientes nesta conta para analisar os resultados.', acao: null };
    }

    const resposta = await responderComContexto(pergunta, meses.map(d => textoDRE(d, hoje)).join('\n\n'), source);
    console.log('[Agent][5] Resposta analytics:', resposta.slice(0, 200));
    return { resposta, acao: null };
  }

  // ── OUTRO ─────────────────────────────────────────────────────────────────
  const resposta = body || 'Como posso ajudar?';
  console.log('[Agent][3] Sem tool. Resposta final:', resposta);
  return { resposta, acao: null };
}

module.exports = { processarMensagem };
