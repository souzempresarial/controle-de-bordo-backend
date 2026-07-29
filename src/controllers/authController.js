const pool   = require('../models/db');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const https  = require('https');

// ─── helpers ────────────────────────────────────────────────────────────────

function enviarEmailVerificacao(email, nome, token) {
  const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://www.souzfinance.com';
  const link = `${frontendUrl}/verificar?token=${token}`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#16a34a;padding:20px 28px;border-radius:10px 10px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px;font-weight:800">SOUZ Finance</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">Verificação de e-mail</p>
      </div>
      <div style="background:#fff;padding:24px 28px;border:1px solid #e5e7eb;border-radius:0 0 10px 10px">
        <p style="font-size:15px;color:#111">Olá, <strong>${nome}</strong>!</p>
        <p style="font-size:14px;color:#555">Clique no botão abaixo para verificar seu e-mail e ativar sua conta no SOUZ Finance:</p>
        <div style="text-align:center;margin:28px 0">
          <a href="${link}" style="background:#16a34a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
            Verificar e-mail
          </a>
        </div>
        <p style="font-size:12px;color:#9ca3af">Este link expira em 24 horas. Se você não criou uma conta, ignore este e-mail.</p>
      </div>
    </div>`;

  const body = JSON.stringify({
    sender:      { name: 'SOUZ Finance', email: 'contato@souzempresarial.com' },
    to:          [{ email, name: nome }],
    subject:     'Verifique seu e-mail — SOUZ Finance',
    htmlContent: html,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers:  {
        'api-key':        process.env.BREVO_API_KEY,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Brevo ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Login ───────────────────────────────────────────────────────────────────

async function login(req, res) {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });

    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    const usuario = result.rows[0];

    if (!usuario || !await bcrypt.compare(senha, usuario.senha_hash)) {
      return res.status(401).json({ erro: 'Email ou senha incorretos' });
    }

    if (!usuario.email_verificado) {
      return res.status(403).json({ erro: 'Confirme seu e-mail antes de fazer login. Verifique sua caixa de entrada.' });
    }

    const token = jwt.sign(
      { id: usuario.id, papel: usuario.papel, clienteId: usuario.cliente_id },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('sf_token', token, {
      httpOnly: true,
      secure:   isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge:   8 * 60 * 60 * 1000,
    });

    let cliente = null;
    if (usuario.papel === 'cliente' && usuario.cliente_id) {
      const { rows } = await pool.query(
        'SELECT id, nome, cor, obs FROM clientes WHERE id = $1',
        [usuario.cliente_id]
      );
      cliente = rows[0] || null;
    }

    res.json({ papel: usuario.papel, clienteId: usuario.cliente_id, nome: usuario.nome, cliente });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// ─── Cadastro público ─────────────────────────────────────────────────────────

async function registrarPublico(req, res) {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ erro: 'Nome, e-mail e senha obrigatórios' });
  if (senha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [cliente] } = await client.query(
      'INSERT INTO clientes (nome) VALUES ($1) RETURNING id',
      [nome]
    );

    const hash  = await bcrypt.hash(senha, 10);
    const token = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO usuarios (email, senha_hash, papel, cliente_id, nome, email_verificado, token_verificacao, token_expira_em)
       VALUES ($1,$2,'cliente',$3,$4,false,$5,$6)`,
      [email.toLowerCase(), hash, cliente.id, nome, token, expira]
    );

    await client.query('COMMIT');

    try {
      await enviarEmailVerificacao(email, nome, token);
    } catch (err) {
      console.error('[Auth] Erro ao enviar e-mail de verificação:', err.message);
    }

    res.status(201).json({ mensagem: 'Conta criada! Verifique seu e-mail para ativar o acesso.' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(400).json({ erro: 'E-mail já cadastrado' });
    res.status(500).json({ erro: err.message });
  } finally {
    client.release();
  }
}

// ─── Verificar e-mail ─────────────────────────────────────────────────────────

async function verificarEmail(req, res) {
  const { token } = req.params;
  try {
    const result = await pool.query(
      `UPDATE usuarios
       SET email_verificado = true, token_verificacao = null, token_expira_em = null
       WHERE token_verificacao = $1 AND token_expira_em > NOW() AND email_verificado = false
       RETURNING id, nome`,
      [token]
    );

    if (!result.rows.length) {
      return res.status(400).json({ erro: 'Link inválido ou expirado. Solicite um novo.' });
    }

    res.json({ mensagem: 'E-mail verificado com sucesso! Você já pode fazer login.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// ─── Reenviar verificação ─────────────────────────────────────────────────────

async function reenviarVerificacao(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'E-mail obrigatório' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1 AND email_verificado = false',
      [email.toLowerCase()]
    );
    if (!rows.length) return res.json({ mensagem: 'Se o e-mail existir e ainda não estiver verificado, um novo link será enviado.' });

    const usuario = rows[0];
    const token   = crypto.randomBytes(32).toString('hex');
    const expira  = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      'UPDATE usuarios SET token_verificacao = $1, token_expira_em = $2 WHERE id = $3',
      [token, expira, usuario.id]
    );

    await enviarEmailVerificacao(usuario.email, usuario.nome || '', token);
    res.json({ mensagem: 'Novo link de verificação enviado.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// ─── Criar primeiro admin ─────────────────────────────────────────────────────

async function registrarAdmin(req, res) {
  try {
    const existe = await pool.query("SELECT id FROM usuarios WHERE papel = 'admin' LIMIT 1");
    if (existe.rows.length) return res.status(403).json({ erro: 'Admin já existe' });

    const { email, senha, nome } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });

    const hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      'INSERT INTO usuarios (email, senha_hash, papel, nome, email_verificado) VALUES ($1,$2,$3,$4,true) RETURNING id, email, papel',
      [email.toLowerCase(), hash, 'admin', nome || 'Admin']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Email já cadastrado' });
    res.status(500).json({ erro: err.message });
  }
}

// ─── Gestão de usuários (admin) ───────────────────────────────────────────────

async function criarUsuario(req, res) {
  try {
    const { email, senha, clienteId, nome } = req.body;
    if (!email || !senha || !clienteId) return res.status(400).json({ erro: 'Email, senha e clienteId obrigatórios' });

    const hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (email, senha_hash, papel, cliente_id, nome, email_verificado)
       VALUES ($1,$2,'cliente',$3,$4,true) RETURNING id, email, papel, cliente_id, nome`,
      [email.toLowerCase(), hash, clienteId, nome || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Email já cadastrado' });
    res.status(500).json({ erro: err.message });
  }
}

async function listarUsuarios(req, res) {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.papel, u.cliente_id, u.nome, u.criado_em, u.email_verificado, c.nome AS cliente_nome
       FROM usuarios u LEFT JOIN clientes c ON c.id = u.cliente_id
       ORDER BY u.criado_em DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

async function excluirUsuario(req, res) {
  try {
    await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
    res.json({ mensagem: 'Usuário excluído' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// ─── Perfil do próprio usuário ────────────────────────────────────────────────

async function minhaInfo(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, papel, cliente_id, nome, email_verificado, criado_em FROM usuarios WHERE id = $1',
      [req.usuario.id]
    );
    res.json(rows[0] || {});
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

async function editarPerfil(req, res) {
  try {
    const { nome, email, senhaAtual, novaSenha } = req.body;
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.usuario.id]);
    const usuario = rows[0];
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const sets = []; const vals = []; let idx = 1;

    if (nome !== undefined) { sets.push(`nome = $${idx++}`); vals.push(nome); }

    if (email && email.toLowerCase() !== usuario.email) {
      if (!senhaAtual || !await bcrypt.compare(senhaAtual, usuario.senha_hash))
        return res.status(401).json({ erro: 'Senha atual incorreta' });
      sets.push(`email = $${idx++}`); vals.push(email.toLowerCase());
    }

    if (novaSenha) {
      if (!senhaAtual || !await bcrypt.compare(senhaAtual, usuario.senha_hash))
        return res.status(401).json({ erro: 'Senha atual incorreta' });
      if (novaSenha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });
      const hash = await bcrypt.hash(novaSenha, 10);
      sets.push(`senha_hash = $${idx++}`); vals.push(hash);
    }

    if (!sets.length) return res.json({ mensagem: 'Nenhuma alteração' });

    vals.push(req.usuario.id);
    await pool.query(`UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
    res.json({ mensagem: 'Perfil atualizado com sucesso' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'E-mail já cadastrado' });
    res.status(500).json({ erro: err.message });
  }
}

// ─── Alterar / redefinir senha ────────────────────────────────────────────────

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

async function redefinirSenha(req, res) {
  try {
    const { novaSenha } = req.body;
    if (!novaSenha || novaSenha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });
    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [hash, req.params.id]);
    res.json({ mensagem: 'Senha redefinida com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

function logout(req, res) {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('sf_token', {
    httpOnly: true,
    secure:   isProd,
    sameSite: isProd ? 'none' : 'lax',
  });
  res.json({ mensagem: 'Logout realizado' });
}

function tokenExtrato(req, res) {
  try {
    const token = jwt.sign(
      { id: req.usuario.id, papel: req.usuario.papel, clienteId: req.usuario.clienteId },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    res.json({ token });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

module.exports = {
  login, logout, tokenExtrato,
  registrarPublico, verificarEmail, reenviarVerificacao,
  registrarAdmin, criarUsuario, listarUsuarios, excluirUsuario,
  minhaInfo, editarPerfil, alterarSenha, redefinirSenha,
};