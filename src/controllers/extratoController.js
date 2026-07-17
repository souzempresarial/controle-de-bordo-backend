const { processarExtrato } = require('../services/extratoService');

async function processar(req, res) {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
    const transacoes = await processarExtrato(req.file);
    res.json({ transacoes });
  } catch (err) {
    console.error('[Extrato]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

module.exports = { processar };