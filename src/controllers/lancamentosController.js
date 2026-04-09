const pool = require('../models/db');

// Listar lançamentos de um cliente
async function listar(req, res) {
  try {
    const { clienteId } = req.params;
    const result = await pool.query(
      'SELECT * FROM lancamentos WHERE cliente_id = $1 ORDER BY data DESC, id DESC',
      [clienteId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Criar lançamento
async function criar(req, res) {
  try {
    const { clienteId } = req.params;
    const { tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, quantidade, is_cmv, grupo_id, valor_recebido, origem, obs } = req.body;
    if (!tipo || !valor || !data) return res.status(400).json({ erro: 'Tipo, valor e data são obrigatórios' });
    const result = await pool.query(
      `INSERT INTO lancamentos
        (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, quantidade, is_cmv, grupo_id, valor_recebido, origem, obs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [clienteId, tipo, valor, data, categoria||null, subcategoria||null, descricao||null, pagamento||null, status||'Confirmado', quantidade||null, is_cmv||false, grupo_id||null, valor_recebido||null, origem||null, obs||null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Editar lançamento
async function editar(req, res) {
  try {
    const { id } = req.params;
    const { tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, quantidade, obs } = req.body;
    const result = await pool.query(
      `UPDATE lancamentos SET tipo=$1, valor=$2, data=$3, categoria=$4, subcategoria=$5,
       descricao=$6, pagamento=$7, status=$8, quantidade=$9, obs=$10 WHERE id=$11 RETURNING *`,
      [tipo, valor, data, categoria||null, subcategoria||null, descricao||null, pagamento||null, status, quantidade||null, obs||null, id]
    );
    if (!result.rows.length) return res.status(404).json({ erro: 'Lançamento não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Excluir lançamento
async function excluir(req, res) {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM lancamentos WHERE id = $1', [id]);
    res.json({ mensagem: 'Lançamento excluído com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

module.exports = { listar, criar, editar, excluir };
