const pool   = require('../models/db');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

// Login
async function login(req, res) {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });

    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    const usuario = result.rows[0];

    if (!usuario || !await bcrypt.compare(senha, usuario.senha_hash)) {
      return res.status(401).json({ erro: 'Email ou senha incorretos' });
    }

    const token = jwt.sign(
      { id: usuario.id, papel: usuario.papel, clienteId: usuario.cliente_id },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, papel: usuario.papel, clienteId: usuario.cliente_id, nome: usuario.nome });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Criar primeiro admin (só funciona se não existir nenhum admin)
async function registrarAdmin(req, res) {
  try {
    const existe = await pool.query("SELECT id FROM usuarios WHERE papel = 'admin' LIMIT 1");
    if (existe.rows.length) return res.status(403).json({ erro: 'Admin já existe' });

    const { email, senha, nome } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });

    const hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      'INSERT INTO usuarios (email, senha_hash, papel, nome) VALUES ($1,$2,$3,$4) RETURNING id, email, papel',
      [email.toLowerCase(), hash, 'admin', nome || 'Admin']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Email já cadastrado' });
    res.status(500).json({ erro: err.message });
  }
}

// Criar usuário cliente (admin only)
async function criarUsuario(req, res) {
  try {
    const { email, senha, clienteId, nome } = req.body;
    if (!email || !senha || !clienteId) return res.status(400).json({ erro: 'Email, senha e clienteId obrigatórios' });

    const hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      'INSERT INTO usuarios (email, senha_hash, papel, cliente_id, nome) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, papel, cliente_id, nome',
      [email.toLowerCase(), hash, 'cliente', clienteId, nome || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Email já cadastrado' });
    res.status(500).json({ erro: err.message });
  }
}

// Listar usuários (admin only)
async function listarUsuarios(req, res) {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.papel, u.cliente_id, u.nome, u.criado_em, c.nome AS cliente_nome
       FROM usuarios u LEFT JOIN clientes c ON c.id = u.cliente_id
       ORDER BY u.criado_em DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Excluir usuário (admin only)
async function excluirUsuario(req, res) {
  try {
    await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
    res.json({ mensagem: 'Usuário excluído' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Alterar senha (o próprio usuário)
async function alterarSenha(req, res) {
  try {
    const { senhaAtual, novaSenha } = req.body;
    const result = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.usuario.id]);
    const usuario = result.rows[0];

    if (!await bcrypt.compare(senhaAtual, usuario.senha_hash)) {
      return res.status(401).json({ erro: 'Senha atual incorreta' });
    }

    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [hash, req.usuario.id]);
    res.json({ mensagem: 'Senha alterada com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

module.exports = { login, registrarAdmin, criarUsuario, listarUsuarios, excluirUsuario, alterarSenha };
