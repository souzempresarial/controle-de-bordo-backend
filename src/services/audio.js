const { GoogleGenAI } = require('@google/genai');
const pool = require('../models/db');

const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const MODELO = 'gemini-3.6-flash';

// Vocabulário fixo do ramo (testado em 20/10/2026: acerta modelo de aparelho, valores e parcelas)
const INSTRUCAO = `Você transcreve áudios de donos e funcionários de lojas de celular no Brasil falando com a SOUZ, assistente financeira do sistema. Transcreva fielmente, em português do Brasil, o que a pessoa disse.

Como escrever:
- Valores em reais com números no formato brasileiro: "três mil oitocentos e cinquenta" → R$ 3.850; "trezentos e quinze e setenta e três" → R$ 315,73; "cinquenta conto" → R$ 50.
- Quantidades, parcelas e memória em número: "doze vezes" → 12x; "duzentos e cinquenta e seis gigas" → 256GB.
- Produtos como as lojas escrevem: iPhone 15 Pro Max, iPhone 13 Pro, iPhone 11, Redmi Note 14S, Poco X7, Galaxy A55, Apple Watch Series 6, AirPods Pro, MacBook Air, iPad, capinha MagSafe, película 3D, película de privacidade, carregador turbo, fonte 20W.
- Termos do financeiro: Pix, cartão, débito, crédito, maquininha, boleto, upgrade, downgrade, troca, pró-labore, retirada, CMV, DRE, faturamento, margem bruta, lucro, fornecedor, frete, motoboy, sinal, pré-venda, comissão.
- Bancos e maquininhas: Sicoob, Sicredi, PagBank, Stone, Nubank, Itaú, Bradesco, Santander, Banco do Brasil, Inter, C6, Mercado Pago, InfinitePay, SumUp, Cielo, Rede.
- Nomes de pessoas e lojas com inicial maiúscula.`;

const FINAL = 'Não responda à pergunta, não corrija nem complete o que a pessoa disse, não explique nada. Retorne só a transcrição. Se não houver fala, retorne vazio.';

// Nomes próprios da loja (dono, equipe, fornecedores) são o que mais erra na transcrição: vão como referência de grafia
const cacheVocab = new Map(); // clienteId → { texto, ate }
async function vocabularioDaLoja(clienteId) {
  if (!clienteId) return '';
  const guardado = cacheVocab.get(String(clienteId));
  if (guardado && guardado.ate > Date.now()) return guardado.texto;
  try {
    const [{ rows: [c] }, { rows: pessoas }, { rows: descricoes }] = await Promise.all([
      pool.query('SELECT trim(nome) AS nome, trim(obs) AS loja FROM clientes WHERE id = $1', [clienteId]),
      pool.query('SELECT DISTINCT trim(nome) AS nome FROM usuarios WHERE cliente_id = $1 AND ativo AND nome IS NOT NULL', [clienteId]),
      // Saídas digitadas (fornecedor, funcionário, despesa) mais frequentes nos últimos 4 meses
      pool.query(
        `SELECT trim(descricao) AS d, count(*) AS n FROM lancamentos
         WHERE cliente_id = $1 AND tipo = 'Saída' AND NOT COALESCE(is_cmv, false) AND data >= CURRENT_DATE - 120
           AND descricao IS NOT NULL AND length(trim(descricao)) BETWEEN 3 AND 40 AND descricao NOT LIKE 'CMV —%'
         GROUP BY 1 ORDER BY n DESC LIMIT 40`, [clienteId]),
    ]);
    const nomes = [c?.loja, c?.nome, ...pessoas.map(p => p.nome)].filter(Boolean);
    const texto = [
      nomes.length ? `Loja e pessoas desta conta: ${[...new Set(nomes)].join(', ')}.` : '',
      descricoes.length ? `Nomes e descrições que esta loja costuma lançar (use esta grafia quando ouvir algo parecido): ${descricoes.map(d => d.d).join('; ')}.` : '',
    ].filter(Boolean).join('\n');
    cacheVocab.set(String(clienteId), { texto, ate: Date.now() + 10 * 60 * 1000 });
    return texto;
  } catch (e) {
    console.warn('[audio] vocabulário da loja:', e.message);
    return '';
  }
}

async function transcreverAudio(base64, mimeType, clienteId) {
  const tipo = (mimeType || 'audio/ogg').split(';')[0];
  const vocab = await vocabularioDaLoja(clienteId);
  const instrucao = [INSTRUCAO, vocab, FINAL].filter(Boolean).join('\n\n');
  const gerar = () => genAI.models.generateContent({
    model: MODELO,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: tipo, data: base64 } },
        { text: instrucao },
      ],
    }],
    config: { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
  });
  // Gemini sobrecarregado devolve 503 na hora; uma nova tentativa costuma passar
  const result = await gerar().catch(err => {
    if (/503|high demand|overloaded|UNAVAILABLE/i.test(err.message)) return gerar();
    throw err;
  });
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? result.text;
  return (text || '').trim();
}

module.exports = { transcreverAudio, vocabularioDaLoja };
