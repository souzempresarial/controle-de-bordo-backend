const pool    = require('../models/db');
const { GoogleGenAI } = require('@google/genai');

const genAI       = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const EMBED_MODEL = 'text-embedding-004'; // 768 dims
const CHAT_MODEL  = 'gemini-2.0-flash';

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
  const result = await genAI.models.embedContent({
    model:    EMBED_MODEL,
    contents: texto,
  });
  const values = result.embeddings?.[0]?.values;
  if (!values) throw new Error('Embedding vazio');
  return values; // number[]
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

async function responderComContexto(pergunta, resumos) {
  const contexto = resumos
    .map(r => `[${periodoLabel(r.periodo)}]\n${r.resumo}`)
    .join('\n\n');

  const prompt = `Com base nos resumos financeiros abaixo, responda a pergunta de forma direta e objetiva em português. Use os valores reais dos resumos. Se a informação não estiver nos resumos, diga que não tem dados suficientes.

Pergunta: ${pergunta}

Resumos disponíveis:
${contexto}`;

  const result = await genAI.models.generateContent({
    model:    CHAT_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config:   { temperature: 0.2 },
  });

  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? result.text;
  return (text || '').trim();
}

module.exports = { gerarResumoMensal, buscarAnalytics, responderComContexto };
