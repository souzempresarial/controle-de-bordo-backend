const { processarMensagem } = require('../services/agentService');
const { GoogleGenAI }      = require('@google/genai');
const redis  = require('../services/redis');
const pool   = require('../models/db');
const sender = require('./sender');

const CHAT_MAX = 30;
const CHAT_TTL = 604800;

const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// ---------- helpers ----------

function extrairTelefone(remoteJid) {
  return (remoteJid || '').split('@')[0].replace(/\D/g, '');
}

async function resolverCliente(telefone) {
  const { rows } = await pool.query(
    `SELECT u.cliente_id, u.nome AS usuario_nome, c.nome AS cliente_nome
     FROM usuarios u
     JOIN clientes c ON c.id = u.cliente_id
     WHERE u.telefone = $1 AND u.ativo = true AND u.cliente_id IS NOT NULL
     LIMIT 1`,
    [telefone]
  );
  return rows[0] || null;
}

async function transcreverAudio(base64, mimeType) {
  const result = await genAI.models.generateContent({
    model:    'gemini-3.6-flash',
    contents: [{
      role:  'user',
      parts: [
        { inlineData: { mimeType: (mimeType || 'audio/ogg').split(';')[0], data: base64 } },
        { text: 'Transcreva exatamente o que foi dito neste áudio em português. Retorne apenas a transcrição, sem explicações.' },
      ],
    }],
    config: { temperature: 0.1 },
  });
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? result.text;
  return (text || '').trim();
}

// ---------- histórico Redis ----------

async function carregarHistorico(clienteId) {
  try {
    const cached = await redis.get(`chat:${clienteId}`);
    return Array.isArray(cached) ? cached : [];
  } catch { return []; }
}

async function salvarHistorico(clienteId, historico, mensagem, resposta) {
  try {
    const atualizado = [
      ...historico,
      { role: 'user',      content: mensagem },
      { role: 'assistant', content: resposta  },
    ].slice(-CHAT_MAX);
    await redis.set(`chat:${clienteId}`, atualizado, { ex: CHAT_TTL });
  } catch (e) {
    console.warn('[WhatsApp] Redis set error:', e.message);
  }
}

// ---------- webhook ----------

async function webhook(req, res) {
  res.sendStatus(200); // responde imediatamente para a Evolution não reenviar

  try {
    const evento = req.body;
    if (evento.event !== 'messages.upsert') return;

    const data = evento.data;
    if (!data || data.key?.fromMe) return;

    const remoteJid = data.key?.remoteJid || '';
    if (remoteJid.includes('@g.us')) return; // ignora grupos

    const telefone = extrairTelefone(remoteJid);
    if (!telefone) return;

    // Resolve usuário pelo número
    const cliente = await resolverCliente(telefone);
    if (!cliente) {
      await sender.enviarTexto(telefone, 'Seu número não está cadastrado no sistema. Entre em contato com o suporte.');
      return;
    }

    const { cliente_id: clienteId, usuario_nome: usuarioNome, cliente_nome: clienteNome } = cliente;

    // Extrai mensagem (texto ou áudio)
    let mensagem = '';
    const msgType = data.messageType;

    if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
      mensagem = data.message?.conversation || data.message?.extendedTextMessage?.text || '';
    } else if (msgType === 'audioMessage') {
      const audioMsg = data.message?.audioMessage;
      const base64   = audioMsg?.base64 || data.message?.base64;
      if (!base64) {
        await sender.enviarTexto(telefone, 'Não consegui processar o áudio. Pode enviar em texto?');
        return;
      }
      mensagem = await transcreverAudio(base64, audioMsg?.mimetype);
      if (!mensagem) {
        await sender.enviarTexto(telefone, 'Não entendi o áudio. Pode repetir em texto?');
        return;
      }
      console.log('[WhatsApp] Áudio transcrito:', mensagem.slice(0, 100));
    } else {
      return; // ignora imagens, stickers, etc.
    }

    if (!mensagem.trim()) return;
    console.log('[WhatsApp] Mensagem de', telefone, '→ clienteId', clienteId, ':', mensagem.slice(0, 80));

    // Pipeline do agente (igual à dashboard)
    const historico = await carregarHistorico(clienteId);
    const resultado = await processarMensagem(mensagem.trim(), historico, clienteId, clienteNome, usuarioNome);

    await salvarHistorico(clienteId, historico, mensagem.trim(), resultado.resposta);
    await sender.enviarTexto(telefone, resultado.resposta);

    console.log('[WhatsApp] Resposta enviada para', telefone, ':', resultado.resposta.slice(0, 80));

  } catch (err) {
    console.error('[WhatsApp] Erro no webhook:', err.message);
  }
}

module.exports = { webhook };
