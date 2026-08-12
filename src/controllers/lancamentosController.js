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
    console.error('[lancamentos.listar]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// Criar lançamento
async function criar(req, res) {
  try {
    const { clienteId } = req.params;
    const { tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, quantidade, is_cmv, grupo_id, valor_recebido, origem, obs, valor_upgrade, qtd_upgrade } = req.body;
    const valorNum = parseFloat(valor);
    if (!tipo || !data || isNaN(valorNum) || valorNum <= 0) return res.status(400).json({ erro: 'Tipo, valor (positivo) e data são obrigatórios' });
    const result = await pool.query(
      `INSERT INTO lancamentos
        (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, quantidade, is_cmv, grupo_id, valor_recebido, origem, obs, valor_upgrade, qtd_upgrade)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [clienteId, tipo, valorNum, data, categoria||null, subcategoria||null, descricao||null, pagamento||null, status||'Confirmado', quantidade||null, is_cmv||false, grupo_id||null, valor_recebido||null, origem||null, obs||null, valor_upgrade||null, qtd_upgrade||null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[lancamentos.criar]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// Editar lançamento
async function editar(req, res) {
  try {
    const { clienteId, id } = req.params;
    const { tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, quantidade, obs, valor_recebido, grupo_id, valor_upgrade, qtd_upgrade } = req.body;
    const result = await pool.query(
      `UPDATE lancamentos SET tipo=$1, valor=$2, data=$3, categoria=$4, subcategoria=$5,
       descricao=$6, pagamento=$7, status=$8, quantidade=$9, obs=$10,
       valor_recebido=$11, grupo_id=$12, valor_upgrade=$13, qtd_upgrade=$14
       WHERE id=$15 AND cliente_id=$16 RETURNING *`,
      [tipo, valor, data, categoria||null, subcategoria||null, descricao||null, pagamento||null, status, quantidade||null, obs||null, valor_recebido||null, grupo_id||null, valor_upgrade||null, qtd_upgrade||null, id, clienteId]
    );
    if (!result.rows.length) return res.status(404).json({ erro: 'Lançamento não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[lancamentos.editar]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// Excluir lançamento
async function excluir(req, res) {
  try {
    const { clienteId, id } = req.params;
    const result = await pool.query('DELETE FROM lancamentos WHERE id = $1 AND cliente_id = $2', [id, clienteId]);
    if (!result.rowCount) return res.status(404).json({ erro: 'Lançamento não encontrado' });
    res.json({ mensagem: 'Lançamento excluído com sucesso' });
  } catch (err) {
    console.error('[lancamentos.excluir]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// Limpar todos os lançamentos de um cliente
async function limpar(req, res) {
  try {
    const { clienteId } = req.params;
    await pool.query('DELETE FROM lancamentos WHERE cliente_id = $1', [clienteId]);
    res.json({ mensagem: 'Lançamentos apagados com sucesso' });
  } catch (err) {
    console.error('[lancamentos.limpar]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

module.exports = { listar, criar, editar, excluir, limpar };
