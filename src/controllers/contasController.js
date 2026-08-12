const pool = require('../models/db');

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

async function criar(req, res) {
  try {
    const { clienteId } = req.params;
    const { tipo, descricao, valor, vencimento, categoria, subcategoria, status, recorrente, periodicidade, valor_juros } = req.body;
    if (!tipo || !valor) return res.status(400).json({ erro: 'Tipo e valor são obrigatórios' });
    const result = await pool.query(
      `INSERT INTO contas
        (cliente_id, tipo, descricao, valor, vencimento, categoria, subcategoria, status, recorrente, periodicidade, valor_juros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [clienteId, tipo, descricao||null, valor, vencimento||null, categoria||null, subcategoria||null, status||'pendente', recorrente||false, periodicidade||null, valor_juros||null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

async function editar(req, res) {
  try {
    const { clienteId, id } = req.params;
    const { tipo, descricao, valor, vencimento, categoria, subcategoria, status, recorrente, periodicidade, valor_juros } = req.body;
    const result = await pool.query(
      `UPDATE contas SET tipo=$1, descricao=$2, valor=$3, vencimento=$4, categoria=$5,
       subcategoria=$6, status=$7, recorrente=$8, periodicidade=$9, valor_juros=$10
       WHERE id=$11 AND cliente_id=$12 RETURNING *`,
      [tipo, descricao||null, valor, vencimento||null, categoria||null, subcategoria||null, status, recorrente||false, periodicidade||null, valor_juros||null, id, clienteId]
    );
    if (!result.rows.length) return res.status(404).json({ erro: 'Conta não encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

async function excluir(req, res) {
  try {
    const { clienteId, id } = req.params;
    await pool.query('DELETE FROM contas WHERE id = $1 AND cliente_id = $2', [id, clienteId]);
    res.json({ mensagem: 'Conta excluída com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

async function excluirEmMassa(req, res) {
  try {
    const { clienteId } = req.params;
    const { categoria } = req.query;
    const result = await pool.query(
      `DELETE FROM contas WHERE cliente_id = $1 AND status = 'pendente'${categoria ? " AND categoria = $2" : ""} RETURNING id`,
      categoria ? [clienteId, categoria] : [clienteId]
    );
    res.json({ deletados: result.rowCount });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

module.exports = { listar, criar, editar, excluir, excluirEmMassa };