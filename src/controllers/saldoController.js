const pool = require('../models/db');

// Buscar saldo inicial de um ano
async function buscar(req, res) {
  try {
    const { clienteId, ano } = req.params;
    const result = await pool.query(
      'SELECT * FROM saldo_inicial WHERE cliente_id = $1 AND ano = $2',
      [clienteId, ano]
    );
    res.json(result.rows[0] || { valor: 0, mes: 0 });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Salvar ou atualizar saldo inicial
async function salvar(req, res) {
  try {
    const { clienteId, ano } = req.params;
    const { valor, mes } = req.body;
    const result = await pool.query(
      `INSERT INTO saldo_inicial (cliente_id, ano, valor, mes)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (cliente_id, ano) DO UPDATE SET valor=$3, mes=$4 RETURNING *`,
      [clienteId, ano, valor, mes]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

module.exports = { buscar, salvar };
