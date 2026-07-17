const pool = require('../models/db');
const { processarExtrato } = require('../services/extratoService');

async function processar(req, res) {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
    const transacoes = await processarExtrato(req.file, req.params.clienteId);
    res.json({ transacoes });
  } catch (err) {
    console.error('[Extrato]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

async function salvarRegras(req, res) {
  try {
    const { clienteId } = req.params;
    const { transacoes } = req.body;
    if (!transacoes?.length) return res.json({ ok: true });

    for (const t of transacoes) {
      if (!t.descricao || !t.categoria) continue;
      const palavraChave = extrairPalavraChave(t.descricao);
      if (palavraChave.length < 4) continue;
      await pool.query(
        `INSERT INTO regras_extrato (cliente_id, palavra_chave, categoria, subcategoria)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cliente_id, palavra_chave) DO UPDATE
         SET categoria = EXCLUDED.categoria, subcategoria = EXCLUDED.subcategoria`,
        [clienteId, palavraChave, t.categoria, t.subcategoria || null]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Regras]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

const PREFIXOS = [
  'transferência enviada pelo pix ',
  'transf enviada pelo pix ',
  'pix enviado para ',
  'pix enviado ',
  'compra no débito ',
  'compra no crédito ',
  'pagamento efetuado ',
  'débito automático ',
  'ted enviada ',
  'doc enviado ',
];

function extrairPalavraChave(descricao) {
  let d = descricao.trim().toLowerCase();
  for (const p of PREFIXOS) {
    if (d.startsWith(p)) return d.slice(p.length).trim();
  }
  return d;
}

module.exports = { processar, salvarRegras, extrairPalavraChave };