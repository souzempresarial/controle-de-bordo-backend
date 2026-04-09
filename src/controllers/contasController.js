const pool = require('../models/db');

// Listar contas de um cliente
async function listar(req, res) {
  try {
    const { clienteId } = req.params;
    const result = await pool.query(
      'SELECT * FROM contas WHERE cliente_id = $1 ORDER BY vencimento ASC, id DESC',
      [clienteId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Criar conta
async function criar(req, res) {
  try {
    const { clienteId } = req.params;
    const { tipo, descricao, valor, vencimento, categoria, subcategoria, status, recorrente, periodicidade } = req.body;
    if (!tipo || !valor) return res.status(400).json({ erro: 'Tipo e valor são obrigatórios' });
    const result = await pool.query(
      `INSERT INTO contas
        (cliente_id, tipo, descricao, valor, vencimento, categoria, subcategoria, status, recorrente, periodicidade)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [clienteId, tipo, descricao||null, valor, vencimento||null, categoria||null, subcategoria||null, status||'pendente', recorrente||false, periodicidade||null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Editar conta
async function editar(req, res) {
  try {
    const { id } = req.params;
    const { tipo, descricao, valor, vencimento, categoria, subcategoria, status, recorrente, periodicidade } = req.body;
    const result = await pool.query(
      `UPDATE contas SET tipo=$1, descricao=$2, valor=$3, vencimento=$4, categoria=$5,
       subcategoria=$6, status=$7, recorrente=$8, periodicidade=$9 WHERE id=$10 RETURNING *`,
      [tipo, descricao||null, valor, vencimento||null, categoria||null, subcategoria||null, status, recorrente||false, periodicidade||null, id]
    );
    if (!result.rows.length) return res.status(404).json({ erro: 'Conta não encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Excluir conta
async function excluir(req, res) {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM contas WHERE id = $1', [id]);
    res.json({ mensagem: 'Conta excluída com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

module.exports = { listar, criar, editar, excluir };
