const pool    = require('../models/db');
const { GoogleGenAI } = require('@google/genai');

const genAI       = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const EMBED_MODEL = 'gemini-embedding-001';
const CHAT_MODEL  = 'gemini-3.8-flash';
const RESPOSTA_MODEL      = 'gemini-3.6-flash';
const RESPOSTA_TIMEOUT_MS = 18000;

// ---------- helpers ----------

function periodoLabel(periodo) {
  const [y, m] = periodo.split('-');
  const nomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                 'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  return `${nomes[Number(m) - 1]} de ${y}`;
}

function agrupar(rows, campo) {
  const grupos = {};
  for (const r of rows) {
    const k = r[campo] || 'Outro';
    grupos[k] = (grupos[k] || 0) + parseFloat(r.valor);
  }
  return Object.entries(grupos)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}: R$ ${v.toFixed(2)}`)
    .join(', ');
}

// ---------- buscar transações do mês ----------

async function buscarTransacoesMes(clienteId, periodo) {
  const [y, m] = periodo.split('-');
  const start  = `${periodo}-01`;
  const end    = new Date(Number(y), Number(m), 0).toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT tipo, valor, categoria, subcategoria, descricao, data
     FROM lancamentos
     WHERE cliente_id = $1 AND status = 'Confirmado' AND COALESCE(is_cmv, false) = false
       AND data >= $2 AND data <= $3
     ORDER BY data`,
    [clienteId, start, end]
  );
  return rows;
}

// ---------- gerar resumo com Gemini ----------

async function gerarResumo(transacoes, periodo) {
  const entradas = transacoes.filter(t => t.tipo === 'Entrada');
  const saidas   = transacoes.filter(t => t.tipo === 'Saída');

  const totEnt = entradas.reduce((s, t) => s + parseFloat(t.valor), 0);
  const totSai = saidas.reduce((s, t) => s + parseFloat(t.valor), 0);
  const saldo  = totEnt - totSai;

  const prompt = `Gere um resumo financeiro objetivo em português para ${periodoLabel(periodo)}.

Dados do período:
- Faturamento total: R$ ${totEnt.toFixed(2)} (${entradas.length} entradas)
- Top categorias de entrada: ${agrupar(entradas, 'categoria') || 'nenhuma'}
- Gastos totais: R$ ${totSai.toFixed(2)} (${saidas.length} saídas)
- Top categorias de saída: ${agrupar(saidas, 'categoria') || 'nenhuma'}
- Resultado: R$ ${saldo.toFixed(2)} (${saldo >= 0 ? 'positivo' : 'negativo'})

Escreva 2-3 frases resumindo o desempenho financeiro. Mencione: faturamento, principal categoria de receita, principais custos e resultado. Seja direto e use os valores reais.`;

  const result = await genAI.models.generateContent({
    model: CHAT_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.3 },
  });

  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? result.text;
  if (!text) throw new Error('Gemini não retornou resumo');
  return text.trim();
}

// ---------- embedding ----------

async function gerarEmbedding(texto) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${process.env.GOOGLE_API_KEY}`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ content: { parts: [{ text: texto }] }, outputDimensionality: 768 }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || 'Erro embedding');
  const values = data.embedding?.values;
  if (!values) throw new Error('Embedding vazio');
  return values;
}

// ---------- API pública ----------

async function gerarResumoMensal(clienteId, periodo) {
  const transacoes = await buscarTransacoesMes(clienteId, periodo);
  if (transacoes.length === 0) {
    console.log(`[Analytics] Sem transações para cliente ${clienteId} em ${periodo}`);
    return null;
  }

  const resumo    = await gerarResumo(transacoes, periodo);
  const embedding = await gerarEmbedding(resumo);

  // Salva como string JSON — pg_vector aceita '[0.1,0.2,...]'
  await pool.query(
    `INSERT INTO analytics_embeddings (cliente_id, periodo, resumo, embedding)
     VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT (cliente_id, periodo)
     DO UPDATE SET resumo = EXCLUDED.resumo, embedding = EXCLUDED.embedding, gerado_em = NOW()`,
    [clienteId, periodo, resumo, JSON.stringify(embedding)]
  );

  console.log(`[Analytics] Resumo salvo — cliente ${clienteId}, ${periodo}: ${resumo.slice(0, 80)}...`);
  return resumo;
}

async function buscarAnalytics(clienteId, pergunta) {
  const embPergunta = await gerarEmbedding(pergunta);

  const { rows } = await pool.query(
    `SELECT periodo, resumo, 1 - (embedding <=> $1::vector) AS similaridade
     FROM analytics_embeddings
     WHERE cliente_id = $2
     ORDER BY embedding <=> $1::vector
     LIMIT 4`,
    [JSON.stringify(embPergunta), clienteId]
  );

  return rows; // [{ periodo, resumo, similaridade }]
}

// contexto: texto com o DRE de cada mês (services/dre.js → textoDRE)
async function responderComContexto(pergunta, contexto, source = 'dashboard') {
  const formato = source === 'whatsapp'
    ? 'Formato: texto simples para WhatsApp, sem markdown, no máximo 6 linhas curtas.'
    : 'Formato: até 12 linhas. Pode usar **negrito** e listas com "- ". Sem títulos com #.';

  const prompt = `Você é a SOUZ, consultora financeira de lojistas de celular. Responda em português, de forma direta.

Os números abaixo são o DRE oficial de cada mês, os mesmos da tela Financeiro do sistema, calculados agora.

Como responder:
- Números: use SOMENTE os valores abaixo, sem recalcular nem arredondar. Faturamento = Receita Bruta. Resultado ou lucro do mês = Lucro Líquido. "Caixa do mês" é dinheiro que entrou e saiu da conta, não é lucro — só use se perguntarem de caixa. Se perguntarem de um mês que não está abaixo, diga que não há lançamentos nele.
- Mês marcado como parcial ainda está em andamento: avise isso ao comparar com meses fechados.
- Conselhos, recomendações e próximos passos: analise os números (margens, peso de cada despesa, comparação entre meses, o que cresceu ou caiu) e dê de 2 a 4 ações práticas e específicas para a loja, cada uma ligada a um número. Não responda que "não há dados suficientes" para recomendar — recomende com base no que existe.
- Projeções: deixe claro que é estimativa e de qual dado partiu.
${formato}

Pergunta: ${pergunta}

DRE por mês:
${contexto}`;

  // Roda dentro do chat: API Gateway corta em 29s e o agente já gastou parte disso
  const inicio = Date.now();
  const gerar = () => genAI.models.generateContent({
    model:    RESPOSTA_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config:   { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
  });
  const limite = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout analytics')), RESPOSTA_TIMEOUT_MS));

  // Gemini sobrecarregado devolve 503 na hora; uma nova tentativa costuma passar
  const comRetentativa = gerar().catch(err => {
    if (/503|high demand|overloaded|UNAVAILABLE/i.test(err.message) && Date.now() - inicio < 4000) return gerar();
    throw err;
  });

  try {
    const result = await Promise.race([comRetentativa, limite]);
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? result.text;
    return (text || '').trim();
  } catch (err) {
    console.warn('[Analytics] Falha ao responder:', err.message);
    return 'A análise demorou mais que o normal. Tente perguntar de novo em alguns segundos.';
  }
}

module.exports = { gerarResumoMensal, buscarAnalytics, responderComContexto };
