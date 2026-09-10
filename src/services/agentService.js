const { GoogleGenAI } = require('@google/genai');
const { SYSTEM_PROMPT } = require('../prompts/agentPrompt');
const pool = require('../models/db');

const GEMINI_MODEL  = 'gemini-3.6-flash';
const MAX_HISTORICO = 10;

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

async function callGemini(mensagem, historico, clienteNome) {
  const promptComNome = clienteNome
    ? `${SYSTEM_PROMPT}\n\nCliente atual: ${clienteNome}`
    : SYSTEM_PROMPT;

  const contents = [
    { role: 'user',  parts: [{ text: promptComNome }] },
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

async function callDeepSeek(mensagem, historico, clienteNome) {
  const systemContent = clienteNome
    ? `${SYSTEM_PROMPT}\n\nCliente atual: ${clienteNome}`
    : SYSTEM_PROMPT;

  const messages = [
    { role: 'system', content: systemContent },
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

async function callLLM(mensagem, historico, clienteNome) {
  try {
    return await callGemini(mensagem, historico, clienteNome);
  } catch (err) {
    console.warn('[Agent] Gemini falhou:', err.message, '— tentando DeepSeek...');
    if (process.env.DEEPSEEK_API_KEY) {
      try {
        return await callDeepSeek(mensagem, historico, clienteNome);
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

// ---------- ponto de entrada ----------

async function processarMensagem(mensagem, historico, clienteId, clienteNome) {
  console.log('[Agent][1] Mensagem recebida:', mensagem);

  const textoLLM = await callLLM(mensagem, historico, clienteNome);

  const parsed = parseResposta(textoLLM);
  const { intent_type, body, data: dados = {} } = parsed;
  console.log('[Agent][2] Intent:', intent_type, '| Dados:', JSON.stringify(dados));

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

    const resposta = body || `${tipo} de R$ ${valorNum.toLocaleString('pt-BR')} registrada!`;
    console.log('[Agent][5] Resposta final:', resposta);
    return { resposta, acao: tipo, lancamento };
  }

  const resposta = body || 'Como posso ajudar?';
  console.log('[Agent][3] Sem tool. Resposta final:', resposta);
  return { resposta, acao: null };
}

module.exports = { processarMensagem };
