const { processarMensagem } = require('../services/agentService');
const redis = require('../services/redis');

const CHAT_MAX  = 30;    // mensagens por cliente
const CHAT_TTL  = 604800; // 7 dias em segundos

async function chat(req, res) {
  try {
    const { clienteId } = req.params;
    const { mensagem, clienteNome, usuarioNome } = req.body;

    if (!mensagem || typeof mensagem !== 'string' || !mensagem.trim()) {
      return res.status(400).json({ erro: 'Mensagem não pode ser vazia' });
    }

    // Carrega histórico do Redis (ignora o historico enviado pelo frontend)
    const chatKey = `chat:${clienteId}`;
    let historico = [];
    try {
      const cached = await redis.get(chatKey);
      if (Array.isArray(cached)) historico = cached;
    } catch (e) {
      console.warn('[Agent] Redis get historico error:', e.message);
    }

    const resultado = await processarMensagem(mensagem.trim(), historico, clienteId, clienteNome, usuarioNome, 'dashboard');

    // Salva histórico atualizado no Redis
    try {
      const atualizado = [
        ...historico,
        { role: 'user',      content: mensagem.trim(),    source: 'dashboard' },
        { role: 'assistant', content: resultado.resposta, source: 'dashboard' },
      ].slice(-CHAT_MAX);
      await redis.set(chatKey, atualizado, { ex: CHAT_TTL });
    } catch (e) {
      console.warn('[Agent] Redis set historico error:', e.message);
    }

    res.json(resultado);
  } catch (err) {
    console.error('[Agent] Erro:', err.message, err.stack);
    res.status(500).json({ erro: 'Erro no assistente. Tente novamente.', detalhe: err.message });
  }
}

async function historico(req, res) {
  try {
    const cached = await redis.get(`chat:${req.params.clienteId}`);
    const mensagens = (Array.isArray(cached) ? cached : [])
      .map(m => ({ role: m.role, content: m.content, source: m.source || 'dashboard' }));
    res.json({ mensagens });
  } catch (err) {
    console.warn('[Agent] Redis historico error:', err.message);
    res.json({ mensagens: [] });
  }
}

async function limpar(req, res) {
  try {
    await redis.del(`chat:${req.params.clienteId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Agent] Redis limpar error:', err.message);
    res.status(500).json({ erro: 'Não foi possível limpar a conversa' });
  }
}

module.exports = { chat, historico, limpar };
