const { processarMensagem } = require('../services/agentService');
const { transcreverAudio }  = require('../services/audio');
const redis = require('../services/redis');

const CHAT_MAX  = 30;    // mensagens por cliente
const CHAT_TTL  = 604800; // 7 dias em segundos

async function chat(req, res) {
  try {
    const { clienteId } = req.params;
    const { mensagem, clienteNome, usuarioNome, somenteConsulta } = req.body;

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

    const telasLiberadas = req.usuario.papel === 'funcionario' ? (req.usuario.permissoes || []) : null;
    const resultado = await processarMensagem(mensagem.trim(), historico, clienteId, clienteNome, usuarioNome, 'dashboard', telasLiberadas, somenteConsulta === true);

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
    res.status(500).json({ erro: 'Erro no assistente. Tente novamente.' });
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

const AUDIO_MAX_BASE64 = 8 * 1024 * 1024; // ~6 MB de áudio; o ditado tem no máximo 1 minuto

async function transcrever(req, res) {
  try {
    const { audio, mimeType, conversa } = req.body;
    if (!audio || typeof audio !== 'string') return res.status(400).json({ erro: 'Áudio não enviado' });
    if (audio.length > AUDIO_MAX_BASE64) return res.status(413).json({ erro: 'Áudio muito longo. Grave até 1 minuto.' });
    if (mimeType && !/^audio\//.test(mimeType)) return res.status(400).json({ erro: 'Formato de áudio inválido' });
    const texto = await transcreverAudio(audio, mimeType, req.params.clienteId, { comVocabulario: conversa !== true });
    res.json({ texto });
  } catch (err) {
    console.error('[Agent] Erro ao transcrever:', err.message);
    res.status(500).json({ erro: 'Não consegui entender o áudio. Tente de novo.' });
  }
}

// Resposta do SOUZ AI em voz: gera o áudio só quando a pessoa clica em "Ouvir"
async function falar(req, res) {
  try {
    const { texto } = req.body;
    if (!texto || typeof texto !== 'string') return res.status(400).json({ erro: 'Texto não enviado' });
    const { falar: gerarFala } = require('../services/voz');
    res.json(await gerarFala(texto, req.params.clienteId));
  } catch (err) {
    console.error('[Agent] Erro ao gerar voz:', err.message);
    res.status(err.status || 500).json({ erro: err.mensagemUsuario || 'Não consegui gerar o áudio agora. Tente de novo.' });
  }
}

// Último resumo semanal da loja (gerado toda segunda) para mostrar no topo do chat
async function resumoSemana(req, res) {
  try {
    const { ultimoResumoSemanal } = require('../services/analyticsService');
    const r = await ultimoResumoSemanal(req.params.clienteId);
    if (!r) return res.json({ resumo: null });
    // periodo '2026W42' → segunda e domingo daquela semana ISO
    const ano = Number(r.periodo.slice(0, 4)), semana = Number(r.periodo.slice(5));
    const jan4 = new Date(Date.UTC(ano, 0, 4));
    const segunda = new Date(jan4); segunda.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (semana - 1) * 7);
    const domingo = new Date(segunda); domingo.setUTCDate(segunda.getUTCDate() + 6);
    res.json({ periodo: r.periodo, inicio: segunda.toISOString().slice(0, 10), fim: domingo.toISOString().slice(0, 10), resumo: r.resumo, geradoEm: r.gerado_em });
  } catch (err) {
    console.error('[Agent] resumo da semana:', err.message);
    res.status(500).json({ erro: 'Não consegui carregar o resumo da semana.' });
  }
}

module.exports = { chat, historico, limpar, transcrever, resumoSemana, falar };
