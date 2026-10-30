const redis = require('./redis');

// SOUZ AI respondendo em voz: Gemini TTS com a mesma chave do Gemini (o Cloud Text-to-Speech/Chirp 3 HD
// exige conta de serviço). Testado em 28/10/2026: ~4s para gerar 17s de fala, voz Kore escolhida pelo Bryan
const MODELO       = 'gemini-3.8-flash-lite-tts';
const MODELO_ROTEIRO = 'gemini-3.6-flash';
const VOZ          = 'Achernar'; // feminina e suave
const MAX_CARACTERES = 1500;
const LIMITE_QUALIDADE = 3 * 1024 * 1024; // base64: acima disso reduz para caber na resposta da Lambda
const MAX_TELA     = 8000; // quanto da resposta da tela vai para o roteiro: a conclusão costuma vir no fim
const MAX_ROTEIRO  = 450;  // ~30s de fala: a voz é o resumo, o detalhe fica nos cards
const AUDIOS_POR_DIA = 80; // por loja: controla o custo
const TIMEOUT_MS   = 20000;
const TIMEOUT_ROTEIRO_MS = 6000;
const PRAZO_MS     = 26000; // a Lambda corta em 29s
const ESPERAS_COTA_MS = [1500, 4000]; // novas tentativas quando o Google responde 429

const REGRAS_ROTEIRO = `Você é a SOUZ AI falando com o dono de uma loja de celulares. Transforme a resposta abaixo, que aparece na tela, no que você diria em voz alta.
Regras:
- Português do Brasil, tom de conversa, como uma pessoa explicando. Fale com o dono usando "você" ("você faturou"), nunca "nós" ou "fechamos".
- No máximo ${MAX_ROTEIRO} caracteres, em frases curtas. Comece pelo que mais importa e, se houver, feche com o que mais pesou.
- Arredonde os números para falar: "uns 288 mil", não "R$ 288.338,00". Não invente nenhum dado nem relação de causa que não esteja na resposta, e não some nem calcule nada: use só números que já estão nela.
- Sem listas, tabelas, markdown ou emojis. Não leia tudo: os detalhes continuam nos cards da tela.
- Não diga "aqui está" nem comente que é um resumo. Devolva só a fala.

Resposta da tela:
`;

// O texto do chat vem com markdown, tabelas e emojis; a voz lê só o conteúdo
function limparTexto(texto) {
  return String(texto || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\p{Extended_Pictographic}|️/gu, '')
    // Linha divisória da tabela some; cada linha vira "coluna: coluna"
    .replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, l) => l.split('|').map(c => c.trim()).filter(Boolean).join(': '))
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean)
    // Cada linha vira uma frase: a voz faz a pausa no ponto
    .map(l => (/[.!?:;]$/.test(l) ? l : `${l}.`))
    .join('\n');
}

function textoParaFala(texto) {
  let t = limparTexto(texto);
  if (t.length > MAX_CARACTERES) {
    const corte = t.lastIndexOf('.', MAX_CARACTERES);
    t = t.slice(0, corte > MAX_CARACTERES / 2 ? corte + 1 : MAX_CARACTERES);
  }
  return t;
}

const chaveLimite = clienteId => `voz:${clienteId}:${new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })}`;

async function dentroDoLimite(clienteId) {
  try {
    return Number(await redis.get(chaveLimite(clienteId))) < AUDIOS_POR_DIA;
  } catch {
    return true; // Redis fora do ar não tira a voz de ninguém
  }
}

// Conta só áudio entregue: tentativa recusada pela cota do Google não gasta o limite da loja
async function contarAudio(clienteId) {
  try {
    const chave = chaveLimite(clienteId);
    if (await redis.incr(chave) === 1) await redis.expire(chave, 26 * 3600);
  } catch (err) {
    console.warn('[Voz] Falha ao contar áudio:', err.message);
  }
}

// Alguns modelos devolvem PCM cru (audio/L16;rate=24000): o navegador só toca com cabeçalho WAV
function comoWav(base64, mimeType) {
  if (!/l16|pcm/i.test(mimeType || '')) return base64;
  const pcm = Buffer.from(base64, 'base64');
  const taxa = +((mimeType.match(/rate=(\d+)/) || [])[1] || 24000);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(taxa, 24);
  h.writeUInt32LE(taxa * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]).toString('base64');
}

// WAV de 24 kHz pesa ~48 KB por segundo; para voz, 12 kHz soa igual e corta o arquivo pela metade
function reduzirWav(base64) {
  const wav = Buffer.from(base64, 'base64');
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt16LE(34) !== 16 || wav.readUInt16LE(22) !== 1) return base64;
  const taxa = wav.readUInt32LE(24);
  if (taxa < 20000) return base64;
  // O Google anexa um bloco C2PA depois do áudio: lido como som, vira ruído alto no fim
  const posData = wav.indexOf('data');
  const ini = posData + 8;
  const amostras = Math.floor(Math.min(wav.readUInt32LE(posData + 4), wav.length - ini) / 2);
  const novo = Buffer.alloc(44 + Math.floor(amostras / 2) * 2);
  wav.copy(novo, 0, 0, 36);
  novo.writeUInt32LE(16, 16); // cabeçalho fmt padrão, mesmo que o original tenha blocos extras
  novo.writeUInt32LE(taxa / 2, 24); novo.writeUInt32LE(taxa, 28);
  novo.write('data', 36); novo.writeUInt32LE(novo.length - 44, 40); novo.writeUInt32LE(novo.length - 8, 4);
  // Média de duas amostras (filtro simples contra chiado) e pula uma
  for (let i = 0, o = 44; i + 1 < amostras; i += 2, o += 2) {
    novo.writeInt16LE((wav.readInt16LE(ini + i * 2) + wav.readInt16LE(ini + i * 2 + 2)) >> 1, o);
  }
  return novo.toString('base64');
}

async function chamarGemini(modelo, corpo, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-goog-api-key': process.env.GOOGLE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(`Gemini ${modelo} ${r.status}: ${j.error?.message || ''}`.slice(0, 200)), { status: r.status });
    return j;
  } finally {
    clearTimeout(timer);
  }
}

// O que a voz vai dizer. Se o roteiro falhar, lê a resposta da tela limpa: a voz não fica muda por isso
async function roteiroDeFala(texto) {
  const fallback = textoParaFala(texto);
  try {
    const j = await chamarGemini(MODELO_ROTEIRO, {
      contents: [{ parts: [{ text: REGRAS_ROTEIRO + limparTexto(texto).slice(0, MAX_TELA) }] }],
      // Sem thinking: 1,2s contra 4,3s, e o texto é simples
      generationConfig: { temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
    }, TIMEOUT_ROTEIRO_MS);
    const roteiro = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    return roteiro ? textoParaFala(roteiro) : fallback;
  } catch (err) {
    console.warn('[Voz] Roteiro falhou, lendo a resposta da tela:', err.message);
    return fallback;
  }
}

async function gerarAudio(fala, inicio) {
  for (let tentativa = 0; ; tentativa++) {
    const resta = PRAZO_MS - (Date.now() - inicio);
    try {
      const j = await chamarGemini(MODELO, {
        // Só o texto: este modelo não aceita instrução separada e, junto da fala, às vezes a lê em voz alta
        contents: [{ parts: [{ text: fala }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOZ } } } },
      }, Math.min(TIMEOUT_MS, resta));
      const parte = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
      if (!parte?.data) throw new Error('Gemini TTS sem áudio');
      return parte;
    } catch (err) {
      const espera = ESPERAS_COTA_MS[tentativa];
      if (err.status !== 429) throw err;
      // Só tenta de novo se ainda couber uma geração inteira dentro do prazo da Lambda
      if (espera === undefined || Date.now() - inicio + espera + 8000 > PRAZO_MS) {
        throw Object.assign(err, { mensagemUsuario: 'Muitos áudios sendo gerados agora. Tente de novo em instantes.' });
      }
      await new Promise(ok => setTimeout(ok, espera));
    }
  }
}

// O Google anexa um bloco C2PA depois do áudio; fora ele, o WAV segue inteiro
function soAudio(base64) {
  const wav = Buffer.from(base64, 'base64');
  const posData = wav.indexOf('data');
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || posData < 0) return base64;
  const fim = Math.min(posData + 8 + wav.readUInt32LE(posData + 4), wav.length);
  const limpo = Buffer.from(wav.subarray(0, fim));
  limpo.writeUInt32LE(limpo.length - 8, 4);
  return limpo.toString('base64');
}

// Devolve { audio: base64 WAV, mimeType } ou lança erro com mensagemUsuario
async function falar(texto, clienteId) {
  if (!textoParaFala(texto)) throw Object.assign(new Error('texto vazio'), { mensagemUsuario: 'Não há texto para ler.' });
  if (!await dentroDoLimite(clienteId)) {
    throw Object.assign(new Error('limite diário'), { status: 429, mensagemUsuario: `A loja chegou ao limite de ${AUDIOS_POR_DIA} áudios por dia. Amanhã libera de novo.` });
  }

  const inicio = Date.now();
  const fala = await roteiroDeFala(texto);
  const parte = await gerarAudio(fala, inicio);
  await contarAudio(clienteId);
  const wav = comoWav(parte.data, parte.mimeType);
  // Reduzir corta os agudos e deixa a voz grave: só em último caso
  return { audio: wav.length > LIMITE_QUALIDADE ? reduzirWav(wav) : soAudio(wav), mimeType: 'audio/wav' };
}

module.exports = { falar, textoParaFala, roteiroDeFala };
