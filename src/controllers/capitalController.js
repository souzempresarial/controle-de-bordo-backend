const pool = require('../models/db');

async function buscar(req, res) {
  try {
    const { clienteId, mesChave } = req.params;
    const result = await pool.query(
      'SELECT campo, valor FROM capital WHERE cliente_id = $1 AND mes_chave = $2',
      [clienteId, mesChave]
    );
    const dados = {};
    result.rows.forEach(r => { dados[r.campo] = parseFloat(r.valor); });
    res.json(dados);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

async function salvar(req, res) {
  try {
    const { clienteId, mesChave } = req.params;
    const { campo, valor } = req.body;
    await pool.query(
      `INSERT INTO capital (cliente_id, mes_chave, campo, valor)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cliente_id, mes_chave, campo) DO UPDATE SET valor = $4`,
      [clienteId, mesChave, campo, valor]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

module.exports = { buscar, salvar };