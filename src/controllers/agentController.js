const { processarMensagem } = require('../services/agentService');

async function chat(req, res) {
  try {
    const { clienteId } = req.params;
    const { mensagem, historico = [], clienteNome } = req.body;

    if (!mensagem || typeof mensagem !== 'string' || !mensagem.trim()) {
      return res.status(400).json({ erro: 'Mensagem não pode ser vazia' });
    }
    if (!Array.isArray(historico)) {
      return res.status(400).json({ erro: 'Histórico inválido' });
    }

    const resultado = await processarMensagem(mensagem.trim(), historico, clienteId, clienteNome);
    res.json(resultado);
  } catch (err) {
    console.error('[Agent] Erro:', err.message, err.stack);
    res.status(500).json({ erro: 'Erro no assistente. Tente novamente.', detalhe: err.message });
  }
}

module.exports = { chat };
