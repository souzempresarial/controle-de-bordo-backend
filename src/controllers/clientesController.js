const pool = require('../models/db');

// Listar todos os clientes
async function listar(req, res) {
  try {
    const result = await pool.query('SELECT * FROM clientes ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Buscar um cliente por ID
async function buscar(req, res) {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (!result.rows.length) return res.status(404).json({ erro: 'Cliente não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Criar cliente
async function criar(req, res) {
  try {
    const { nome, cor, obs } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const result = await pool.query(
      'INSERT INTO clientes (nome, cor, obs) VALUES ($1, $2, $3) RETURNING *',
      [nome, cor || null, obs || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Editar cliente
async function editar(req, res) {
  try {
    const { id } = req.params;
    const { nome, cor, obs } = req.body;
    const result = await pool.query(
      'UPDATE clientes SET nome=$1, cor=$2, obs=$3 WHERE id=$4 RETURNING *',
      [nome, cor || null, obs || null, id]
    );
    if (!result.rows.length) return res.status(404).json({ erro: 'Cliente não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Excluir cliente
async function excluir(req, res) {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM clientes WHERE id = $1', [id]);
    res.json({ mensagem: 'Cliente excluído com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

module.exports = { listar, buscar, criar, editar, excluir };
