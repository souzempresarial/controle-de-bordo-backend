const pool = require('../models/db');

// Listar metas de um cliente
async function listar(req, res) {
  try {
    const { clienteId } = req.params;
    const result = await pool.query(
      'SELECT * FROM metas WHERE cliente_id = $1 ORDER BY mes_chave',
      [clienteId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Salvar ou atualizar meta
async function salvar(req, res) {
  try {
    const { clienteId } = req.params;
    const { mes_chave, campo, valor } = req.body;
    if (!mes_chave || !campo || valor === undefined) return res.status(400).json({ erro: 'mes_chave, campo e valor são obrigatórios' });
    const result = await pool.query(
      `INSERT INTO metas (cliente_id, mes_chave, campo, valor)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (cliente_id, mes_chave, campo) DO UPDATE SET valor=$4 RETURNING *`,
      [clienteId, mes_chave, campo, valor]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

module.exports = { listar, salvar };
