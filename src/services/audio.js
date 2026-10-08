const { GoogleGenAI } = require('@google/genai');

const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const MODELO = 'gemini-3.6-flash';

async function transcreverAudio(base64, mimeType) {
  const tipo = (mimeType || 'audio/ogg').split(';')[0];
  const gerar = () => genAI.models.generateContent({
    model: MODELO,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: tipo, data: base64 } },
        { text: 'Transcreva exatamente o que foi dito neste áudio em português do Brasil. Escreva valores em reais com números (ex: R$ 1.800). Retorne apenas a transcrição, sem explicações. Se não houver fala, retorne vazio.' },
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

module.exports = { transcreverAudio };
