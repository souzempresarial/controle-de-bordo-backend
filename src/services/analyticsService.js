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

const hojeBR = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const brl    = v => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dm     = dataISO => `${dataISO.slice(8, 10)}/${dataISO.slice(5, 7)}`;

async function gerarTexto(prompt) {
  const result = await genAI.models.generateContent({
    model: CHAT_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.3 },
  });
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? result.text;
  if (!text) throw new Error('Gemini não retornou resumo');
  return text.trim();
}

async function salvarResumo(clienteId, periodo, resumo) {
  // Sem o embedding o resumo continua útil (o chat lê pelo período); só a busca por similaridade fica sem ele
  let embedding = null;
  try { embedding = JSON.stringify(await gerarEmbedding(resumo)); }
  catch (e) { console.warn('[Analytics] Embedding falhou:', e.message); }
  await pool.query(
    `INSERT INTO analytics_embeddings (cliente_id, periodo, resumo, embedding)
     VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT (cliente_id, periodo)
     DO UPDATE SET resumo = EXCLUDED.resumo, embedding = EXCLUDED.embedding, gerado_em = NOW()`,
    [clienteId, periodo, resumo, embedding]
  );
}

async function contasDaSemana(clienteId, inicio, fim) {
  const { rows } = await pool.query(
    `SELECT vencimento::text AS data, valor::float, COALESCE(NULLIF(descricao, ''), subcategoria, categoria) AS nome
     FROM contas WHERE cliente_id = $1 AND tipo = 'pagar' AND status = 'pendente' AND vencimento BETWEEN $2 AND $3
     ORDER BY vencimento`,
    [clienteId, inicio, fim]
  );
  return rows;
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

// Resumo do mês com os números do DRE da tela (mesma conta do chat); refeito toda semana enquanto o mês ainda recebe correções
async function gerarResumoMensal(clienteId, periodo) {
  const { dreMensal, textoDRE } = require('./dre');
  const [mesAnterior] = new Date(Number(periodo.slice(0, 4)), Number(periodo.slice(5, 7)) - 2, 1).toLocaleDateString('sv-SE').split('T');
  const meses = await dreMensal(clienteId, mesAnterior.slice(0, 8) + '01');
  const atual = meses.find(m => m.mes === periodo);
  if (!atual || !atual.recBruta) {
    console.log(`[Analytics] Sem faturamento para cliente ${clienteId} em ${periodo}`);
    return null;
  }
  const anterior = meses.find(m => m.mes < periodo);
  const hoje = hojeBR();
  const prompt = `Resuma em português, em 2 a 3 frases objetivas, o resultado de ${periodoLabel(periodo)} de uma loja de celulares.
Use SOMENTE os números abaixo (DRE oficial do sistema), sem recalcular. Faturamento = Receita Bruta; lucro = Lucro Líquido.
Cite: faturamento, lucro bruto e margem, o grupo de despesa que mais pesou e o lucro líquido.${anterior ? ' Compare com o mês anterior.' : ''}${hoje.startsWith(periodo) ? ' O mês ainda está em andamento: deixe isso claro.' : ''}

${textoDRE(atual, hoje)}${anterior ? `\n\nMês anterior:\n${textoDRE(anterior, hoje)}` : ''}`;
  const resumo = await gerarTexto(prompt);
  await salvarResumo(clienteId, periodo, resumo);
  console.log(`[Analytics] Resumo mensal — cliente ${clienteId}, ${periodo}: ${resumo.slice(0, 80)}...`);
  return resumo;
}

// Resumo escrito da semana (segunda a domingo) para o dono: o que vendeu, o que sobrou, o que mudou e o que vence
async function gerarResumoSemanal(clienteId, segundaISO) {
  const { dreSemanal, textoSemana, textoDetalhe, somaDias } = require('./dre');
  const domingo = somaDias(segundaISO, 6);
  const semanas = await dreSemanal(clienteId, domingo, 5);
  const atual = semanas[semanas.length - 1];
  if (!atual.vendas && !atual.sga) {
    console.log(`[Analytics] Sem lançamentos para cliente ${clienteId} na semana ${segundaISO}`);
    return null;
  }
  const anteriores = semanas.slice(0, -1).filter(s => s.vendas);
  const media = anteriores.length ? anteriores.reduce((a, s) => a + s.recBruta, 0) / anteriores.length : null;
  const contas = await contasDaSemana(clienteId, somaDias(domingo, 1), somaDias(domingo, 7));
  const totContas = contas.reduce((a, c) => a + c.valor, 0);

  const prompt = `Escreva o resumo da semana de ${dm(segundaISO)} a ${dm(domingo)} de uma loja de celulares, para o dono ler no sistema.
Português, tom de alguém da equipe financeira: direto, próximo e profissional. Sem cumprimentar, sem chamar pelo nome, sem títulos com #.
Use SOMENTE os números abaixo (DRE oficial do sistema, mesma conta da tela), sem recalcular.

Formato (no máximo 8 linhas):
- 1ª linha: faturamento da semana e resultado (lucro ou prejuízo), comparando com a semana anterior${media != null ? ' e com a média das semanas anteriores' : ''}.
- Depois, em "- " itens curtos: margem bruta, a despesa que mais pesou (use o detalhe por subcategoria) e qualquer variação forte.
- Se houver contas a pagar na próxima semana, uma linha com o total e as maiores.
- Feche com 1 ponto de atenção prático ligado a um número.
Lançamentos às vezes entram com atraso: se a semana estiver muito abaixo das outras, diga que pode faltar lançamento em vez de afirmar queda.

Semana do resumo:
${textoSemana(atual, domingo)}${textoDetalhe(atual)}

Semanas anteriores:
${semanas.slice(0, -1).map(s => textoSemana(s, domingo)).join('\n')}${media != null ? `\nMédia de faturamento das semanas anteriores com venda: ${brl(media)}` : ''}

Contas a pagar de ${dm(somaDias(domingo, 1))} a ${dm(somaDias(domingo, 7))}: ${contas.length ? `${contas.length} conta(s), total ${brl(totContas)} — ${contas.slice(0, 5).map(c => `${c.nome} ${brl(c.valor)} (${dm(c.data)})`).join('; ')}` : 'nenhuma cadastrada'}`;

  const resumo = await gerarTexto(prompt);
  await salvarResumo(clienteId, atual.chave, resumo);
  console.log(`[Analytics] Resumo semanal — cliente ${clienteId}, ${atual.chave}: ${resumo.slice(0, 80)}...`);
  return { periodo: atual.chave, inicio: segundaISO, fim: domingo, resumo };
}

async function ultimoResumoSemanal(clienteId) {
  const { rows: [r] } = await pool.query(
    `SELECT periodo, resumo, gerado_em FROM analytics_embeddings
     WHERE cliente_id = $1 AND periodo LIKE '____W__' ORDER BY periodo DESC LIMIT 1`,
    [clienteId]
  );
  return r || null;
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

// Cada item "- **Nome:** ..." vira um card na tela do chat (TextoFormatado.jsx)
const formatoTela = linhas => `Formato (até ${linhas} linhas, sem títulos com #):
- Comece com uma frase curta que já responde a pergunta, com o número principal em **negrito**.
- Se a resposta tiver mais de um número ou mais de uma parte, NUNCA escreva em parágrafo corrido: coloque cada parte em um item, exatamente assim: - **Nome da parte:** R$ 0,00 e um complemento curto. Use um único valor em R$ por item sempre que possível.
- Se precisar concluir, feche com uma frase curta depois dos itens.`;

// contexto: texto com o DRE de cada mês (services/dre.js → textoDRE)
async function responderComContexto(pergunta, contexto, source = 'dashboard') {
  const formato = source === 'whatsapp'
    ? 'Formato: texto simples para WhatsApp, sem markdown, no máximo 6 linhas curtas.'
    : formatoTela(12);

  const prompt = `Você é a SOUZ, consultora financeira de lojistas de celular. Responda em português, de forma direta.
Esta resposta continua uma conversa que já está acontecendo: não cumprimente, não se apresente e não chame a pessoa pelo nome. Fale como alguém da equipe que entende de finanças — natural e próxima, mas profissional, sem gírias e sem bajulação.

Os números abaixo são o DRE oficial de cada mês e de cada semana (segunda a domingo), com a mesma conta da tela Financeiro do sistema, calculados agora.

Como responder:
- Responda exatamente o que foi perguntado. Pergunta de número (ex: "qual foi meu faturamento?") se responde com o número e, no máximo, uma frase de contexto — sem lista de conselhos.
- Números: use SOMENTE os valores abaixo, sem recalcular nem arredondar. Faturamento = Receita Bruta. Resultado ou lucro do mês = Lucro Líquido. "Caixa do mês" é dinheiro que entrou e saiu da conta, não é lucro — só use se perguntarem de caixa. Se perguntarem de um mês que não está abaixo, diga que não há lançamentos nele.
- Mês marcado como parcial ainda está em andamento: avise isso ao comparar com meses fechados.
- Pergunta sobre semana ("essa semana", "semana passada", "últimas semanas") se responde pelo bloco "DRE por semana". Na semana, o lucro é o "Resultado" (não tem depreciação nem IRPJ, que são do mês). Semana "em andamento" está incompleta: avise ao comparar.
- Lançamento costuma entrar com alguns dias de atraso: semana muito abaixo das outras pode ser falta de lançamento, não queda real. Diga isso quando for o caso, sem afirmar queda.
- Se pedirem "o resumo da semana" (ou "resumo semanal"), entregue o "Resumo escrito da última semana fechada" que está abaixo, ajustando só o formato pedido; os números dele valem como estão. Fora isso, não cite esse resumo por conta própria.
- Só quando a pessoa pedir conselho, recomendação, análise ou próximos passos: analise os números (margens, peso de cada despesa, comparação entre meses, o que cresceu ou caiu) e dê de 2 a 4 ações práticas e específicas para a loja, cada uma ligada a um número. Não responda que "não há dados suficientes" para recomendar — recomende com base no que existe.
  - Use o "Detalhe por subcategoria": ao falar de um grupo de despesa, diga qual subcategoria pesa mais dentro dele (ex: "Pessoal R$ 22 mil, sendo metade pró-labore"), em vez de citar só o total do grupo.
  - Compare sempre a retirada dos sócios (pró-labore) com o lucro: se a retirada for maior que o lucro líquido, ou o mês fechou no prejuízo com retirada alta, isso é um dos pontos principais da análise — os sócios estão tirando mais do que a loja gera.
- Projeções: deixe claro que é estimativa e de qual dado partiu.
${formato}

Pergunta: ${pergunta}

DRE por mês:
${contexto}`;


  return gerarResposta(prompt, RESPOSTA_TIMEOUT_MS);
}

// Roda dentro do chat: API Gateway corta em 29s e o agente já gastou parte disso
async function gerarResposta(prompt, timeoutMs) {
  const inicio = Date.now();
  const gerar = () => genAI.models.generateContent({
    model:    RESPOSTA_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config:   { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
  });
  const limite = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout analytics')), timeoutMs));

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

// Pergunta sobre a loja que não cabe numa consulta pronta: responde com a "foto da loja" (DRE do SOUZ + Mercado Phone).
// `dadoPrincipal` é o resultado de uma consulta já feita (ex.: estoque parado) quando a pessoa pediu análise em cima dela
async function responderSobreLoja(pergunta, foto, source = 'dashboard', timeoutMs = RESPOSTA_TIMEOUT_MS, dadoPrincipal = null) {
  const formato = source === 'whatsapp'
    ? 'Formato: texto simples para WhatsApp, sem markdown, no máximo 8 linhas curtas.'
    : formatoTela(14);

  const prompt = `Você é a SOUZ, consultora financeira de lojistas de celular. Responda em português, de forma direta.
Esta resposta continua uma conversa que já está acontecendo: não cumprimente, não se apresente e não chame a pessoa pelo nome. Fale como alguém da equipe que entende de finanças e de loja de celular — natural e próxima, mas profissional, sem gírias e sem bajulação.

Abaixo está a foto atual da loja: o DRE do SOUZ e os dados do Mercado Phone (sistema de vendas), já calculados agora.

Como responder:
- Responda exatamente o que foi perguntado, usando os números da foto. Pergunta de número (ex.: "quanto tenho a receber?", "quanto tenho de estoque?") se responde com o número, a composição dele e no máximo um ponto de atenção — SEM lista de ações e sem puxar outros assuntos.
- Números: use SOMENTE os valores abaixo, sem inventar nem recalcular. Se o dado pedido não estiver na foto, diga em uma frase o que não tem e responda com o que é mais próximo (ex.: perguntou de um modelo específico e só há o total de estoque).
- Nunca responda apenas "não há dados". Sempre entregue algo útil com o que existe.
- Só quando a pessoa pedir conselho, estratégia ou "o que fazer": dê de 2 a 4 ações práticas e específicas para a loja, cada uma ligada a um número da foto (ex.: "os R$ 37 mil parados há mais de 180 dias…"). Nada de dica genérica que serviria para qualquer loja.
- Valores do MP marcados como "a conferir" (títulos vencidos há meses, produtos sem custo) não são dinheiro certo: cite como ponto de atenção.
- Estoque do MP é pelo preço de custo. Faturamento do mês pode aparecer no DRE (SOUZ) e nas vendas do MP; se forem diferentes, use o do DRE e diga que o MP mostra outro valor.
${formato}

Pergunta: ${pergunta}
${dadoPrincipal ? `
Resultado da consulta que a pessoa pediu (use como base principal da resposta):
${dadoPrincipal}
` : ''}
Foto da loja:
${foto}`;

  return gerarResposta(prompt, timeoutMs);
}

module.exports = { gerarResumoMensal, gerarResumoSemanal, ultimoResumoSemanal, buscarAnalytics, responderComContexto, responderSobreLoja };
