const pool   = require('../models/db');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const axios  = require('axios');

// ─── helpers ────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function enviarEmailVerificacao(email, nome, token) {
  const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://www.souzfinance.com';
  const link = `${frontendUrl}/verificar?token=${token}`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#16a34a;padding:20px 28px;border-radius:10px 10px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px;font-weight:800">SOUZ Finance</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">Verificação de e-mail</p>
      </div>
      <div style="background:#fff;padding:24px 28px;border:1px solid #e5e7eb;border-radius:0 0 10px 10px">
        <p style="font-size:15px;color:#111">Olá, <strong>${escHtml(nome)}</strong>!</p>
        <p style="font-size:14px;color:#555">Clique no botão abaixo para verificar seu e-mail e ativar sua conta no SOUZ Finance:</p>
        <div style="text-align:center;margin:28px 0">
          <a href="${link}" style="background:#16a34a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
            Verificar e-mail
          </a>
        </div>
        <p style="font-size:12px;color:#9ca3af">Este link expira em 24 horas. Se você não criou uma conta, ignore este e-mail.</p>
      </div>
    </div>`;

  const emailData = {
    sender:      { name: 'SOUZ Finance', email: 'erpsouz@gmail.com' },
    to:          [{ email, name: nome }],
    subject:     'Verifique seu e-mail — SOUZ Finance',
    htmlContent: html,
  };

  await axios.post(
    process.env.BRAVE_SMTP_SENDEMAIL_ENDPOINT_URL,
    emailData,
    { headers: { 'Content-Type': 'application/json', 'api-key': process.env.BRAVE_ENDPOINT_KEY } }
  );
}

async function avisarAdminNovaConta(nome, email) {
  const { rows: admins } = await pool.query("SELECT email FROM usuarios WHERE papel = 'admin' AND COALESCE(ativo, true)");
  if (!admins.length) return;
  await axios.post(
    process.env.BRAVE_SMTP_SENDEMAIL_ENDPOINT_URL,
    {
      sender:      { name: 'SOUZ Finance', email: 'erpsouz@gmail.com' },
      to:          admins.map(a => ({ email: a.email })),
      subject:     `Nova conta aguardando aprovação — ${nome}`,
      htmlContent: `<p>Uma nova conta confirmou o e-mail e está aguardando sua aprovação:</p>
        <p><strong>${escHtml(nome)}</strong> — ${escHtml(email)}</p>
        <p>Para liberar, abra o painel admin, aba Usuários, e mude de <strong>Inativo</strong> para <strong>Ativo</strong>. Se não reconhecer, exclua a conta.</p>`,
    },
    { headers: { 'Content-Type': 'application/json', 'api-key': process.env.BRAVE_ENDPOINT_KEY } }
  );
}

// ─── Proteção contra força bruta ─────────────────────────────────────────────
// Guardado no banco porque o rate limit em memória vale só por instância do Lambda
const MAX_FALHAS = 5;
const JANELA_FALHAS_MIN = 15;

// Cadastro público ainda não aprovado ≠ conta que o admin desativou
function msgContaInativa(usuario) {
  return usuario.aguardando_aprovacao
    ? 'Sua conta está aguardando aprovação da equipe SOUZ Finance. Você vai conseguir entrar assim que for liberada.'
    : 'Conta desativada. Entre em contato com o suporte.';
}

function ipDe(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
}

function registrarFalha(email, ip, motivo) {
  pool.query('INSERT INTO log_tentativas (email, ip, motivo) VALUES ($1, $2, $3)', [(email || '').toLowerCase().slice(0, 255), ip, motivo])
    .catch(err => console.error('[Auth] log_tentativas:', err.message));
  console.warn(`[Auth] Falha de login: ${motivo} | ${email} | ${ip}`);
}

async function emailBloqueado(email) {
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n FROM log_tentativas
     WHERE email = $1 AND motivo = 'senha_incorreta' AND data_hora > NOW() - ($2 || ' minutes')::interval`,
    [email.toLowerCase(), String(JANELA_FALHAS_MIN)]
  );
  return r.n >= MAX_FALHAS;
}

// ─── Login com Google ────────────────────────────────────────────────────────

async function loginGoogle(req, res) {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ erro: 'Token Google obrigatório' });

    const verifyResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    const info = await verifyResp.json();

    if (!verifyResp.ok || info.error_description) {
      return res.status(401).json({ erro: 'Token Google inválido' });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId && info.aud !== clientId) {
      return res.status(401).json({ erro: 'Token não autorizado' });
    }

    const { email, name } = info;
    if (!email) return res.status(401).json({ erro: 'E-mail não disponível' });

    // Google só entra em conta já criada pelo admin; não cria conta nova
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    const usuario = rows[0];

    if (!usuario) {
      registrarFalha(email, ipDe(req), 'google_sem_conta');
      return res.status(403).json({ erro: 'Não encontramos uma conta com este e-mail. Fale com a equipe SOUZ Finance para liberar seu acesso.' });
    }

    if (usuario.ativo === false) {
      registrarFalha(email, ipDe(req), 'conta_inativa');
      return res.status(403).json({ erro: msgContaInativa(usuario) });
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

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    pool.query('UPDATE usuarios SET ultimo_acesso = NOW(), ultimo_ip = $1 WHERE id = $2', [ip, usuario.id]).catch(() => {});
    pool.query('INSERT INTO log_acessos (usuario_id, email, nome, ip) VALUES ($1, $2, $3, $4)', [usuario.id, usuario.email, usuario.nome || null, ip]).catch(() => {});

    let cliente = null;
    if ((usuario.papel === 'cliente' || usuario.papel === 'funcionario') && usuario.cliente_id) {
      const { rows: cRows } = await pool.query('SELECT id, nome, cor, obs FROM clientes WHERE id = $1', [usuario.cliente_id]);
      cliente = cRows[0] || null;
    }

    res.json({ papel: usuario.papel, clienteId: usuario.cliente_id, nome: usuario.nome, cliente, permissoes: usuario.permissoes || null });
  } catch (err) {
    console.error('[loginGoogle]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// ─── Login ───────────────────────────────────────────────────────────────────

async function login(req, res) {
  try {
    const { email, senha, turnstileToken } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });

    if (process.env.TURNSTILE_SECRET_KEY && turnstileToken) {
      const verify = await axios.post(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: turnstileToken, remoteip: req.ip }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      if (!verify.data.success) {
        console.warn('[Turnstile] token inválido:', verify.data['error-codes'], 'ip:', req.ip);
        return res.status(403).json({ erro: 'Verificação de segurança falhou. Recarregue a página e tente novamente.' });
      }
    }

    const ip = ipDe(req);
    if (await emailBloqueado(email)) {
      registrarFalha(email, ip, 'bloqueado');
      return res.status(429).json({ erro: `Muitas tentativas com senha errada. Aguarde ${JANELA_FALHAS_MIN} minutos e tente de novo. Se esqueceu a senha, use "Esqueci minha senha".` });
    }

    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    const usuario = result.rows[0];

    if (!usuario || !await bcrypt.compare(senha, usuario.senha_hash)) {
      registrarFalha(email, ip, usuario ? 'senha_incorreta' : 'email_inexistente');
      return res.status(401).json({ erro: 'Email ou senha incorretos' });
    }

    if (!usuario.email_verificado) {
      registrarFalha(email, ip, 'email_nao_verificado');
      return res.status(403).json({ erro: 'Confirme seu e-mail antes de fazer login. Verifique sua caixa de entrada.' });
    }

    if (usuario.ativo === false) {
      registrarFalha(email, ip, 'conta_inativa');
      return res.status(403).json({ erro: msgContaInativa(usuario) });
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

    // Registrar acesso
    pool.query(
      'UPDATE usuarios SET ultimo_acesso = NOW(), ultimo_ip = $1 WHERE id = $2',
      [ip, usuario.id]
    ).catch(() => {});
    pool.query(
      'INSERT INTO log_acessos (usuario_id, email, nome, ip) VALUES ($1, $2, $3, $4)',
      [usuario.id, usuario.email, usuario.nome || null, ip]
    ).catch(() => {});

    let cliente = null;
    if ((usuario.papel === 'cliente' || usuario.papel === 'funcionario') && usuario.cliente_id) {
      const { rows } = await pool.query(
        'SELECT id, nome, cor, obs FROM clientes WHERE id = $1',
        [usuario.cliente_id]
      );
      cliente = rows[0] || null;
    }

    res.json({
      papel: usuario.papel,
      clienteId: usuario.cliente_id,
      nome: usuario.nome,
      cliente,
      permissoes: usuario.permissoes || null,
    });
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// ─── Cadastro público ─────────────────────────────────────────────────────────

async function registrarPublico(req, res) {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ erro: 'Nome, e-mail e senha obrigatórios' });
  if (senha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });

  const hash  = await bcrypt.hash(senha, 10);
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [cliente] } = await client.query(
      'INSERT INTO clientes (nome) VALUES ($1) RETURNING id',
      [nome]
    );

    // Nasce inativa: só entra depois que o admin aprovar no painel
    await client.query(
      `INSERT INTO usuarios (email, senha_hash, papel, cliente_id, nome, email_verificado, token_verificacao, token_expira_em, ativo, aguardando_aprovacao)
       VALUES ($1,$2,'cliente',$3,$4,false,$5,$6,false,true)`,
      [email.toLowerCase(), hash, cliente.id, nome, token, expira]
    );

    await client.query('COMMIT');

    try {
      await enviarEmailVerificacao(email, nome, token);
    } catch (err) {
      console.error('[Auth] Erro ao enviar e-mail de verificação:', err.message);
    }

    res.status(201).json({ mensagem: 'Conta criada! Confirme seu e-mail; depois disso a equipe SOUZ Finance libera seu acesso.' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(400).json({ erro: 'E-mail já cadastrado' });
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
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
       RETURNING id, nome, email, COALESCE(ativo, true) AS ativo`,
      [token]
    );

    if (!result.rows.length) {
      return res.status(400).json({ erro: 'Link inválido ou expirado. Solicite um novo.' });
    }

    const u = result.rows[0];
    if (!u.ativo) {
      avisarAdminNovaConta(u.nome, u.email).catch(err => console.error('[Auth] Aviso ao admin falhou:', err.message));
      return res.json({ mensagem: 'E-mail confirmado! Agora a equipe SOUZ Finance vai liberar seu acesso.' });
    }
    res.json({ mensagem: 'E-mail verificado com sucesso! Você já pode fazer login.' });
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
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

    try { await enviarEmailVerificacao(usuario.email, usuario.nome || '', token); } catch (emailErr) {
      console.error('[reenviarVerificacao] email falhou:', emailErr.message);
    }
    res.json({ mensagem: 'Novo link de verificação enviado.' });
  } catch (err) {
    console.error('[reenviarVerificacao]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// ─── Criar primeiro admin ─────────────────────────────────────────────────────

async function registrarAdmin(req, res) {
  try {
    const { email, senha, nome } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });

    const hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (email, senha_hash, papel, nome, email_verificado)
       SELECT $1, $2, 'admin', $3, true
       WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE papel = 'admin')
       RETURNING id, email, papel`,
      [email.toLowerCase(), hash, nome || 'Admin']
    );
    if (!result.rows.length) return res.status(403).json({ erro: 'Admin já existe' });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Email já cadastrado' });
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// ─── Gestão de usuários (admin) ───────────────────────────────────────────────

async function criarUsuario(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  try {
    const { email, senha, clienteId, nome, papel: papelBody, permissoes } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });
  const PAPEIS_VALIDOS = ['cliente', 'funcionario', 'admin'];
  const papelFinal = PAPEIS_VALIDOS.includes(papelBody) ? papelBody : 'cliente';
    if (papelFinal === 'funcionario' && !clienteId) return res.status(400).json({ erro: 'Selecione o cliente do funcionário' });
  const permFinal  = papelFinal === 'funcionario' && Array.isArray(permissoes) ? JSON.stringify(permissoes) : null;

    const hash = await bcrypt.hash(senha, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Cliente sem empresa escolhida ganha a própria empresa, como no cadastro público — sem isso o login abre sem cliente
      let clienteFinal = clienteId || null;
      if (papelFinal === 'cliente' && !clienteFinal) {
        const { rows: [novo] } = await client.query(
          'INSERT INTO clientes (nome) VALUES ($1) RETURNING id',
          [(nome || email).trim()]
        );
        clienteFinal = novo.id;
      }
      const result = await client.query(
        `INSERT INTO usuarios (email, senha_hash, papel, cliente_id, nome, email_verificado, permissoes)
         VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id, email, papel, cliente_id, nome`,
        [email.toLowerCase(), hash, papelFinal, clienteFinal, nome || null, permFinal]
      );
      await client.query('COMMIT');
      res.status(201).json(result.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Email já cadastrado' });
    if (err.code === '23503') return res.status(400).json({ erro: 'Cliente não encontrado' });
    console.error('[criarUsuario]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function atualizarPermissoes(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  const { permissoes } = req.body;
  if (!Array.isArray(permissoes)) return res.status(400).json({ erro: 'permissoes deve ser um array' });
  try {
    const { rows } = await pool.query(
      'UPDATE usuarios SET permissoes = $1 WHERE id = $2 RETURNING id, permissoes',
      [JSON.stringify(permissoes), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json({ permissoes: rows[0].permissoes });
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function listarUsuarios(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.papel, u.cliente_id, u.nome, u.criado_em, u.email_verificado,
              COALESCE(u.ativo, true) AS ativo, COALESCE(u.plano, 'trial') AS plano,
              c.nome AS cliente_nome, u.permissoes, u.ultimo_acesso,
              COALESCE(u.aguardando_aprovacao, false) AS aguardando_aprovacao
       FROM usuarios u LEFT JOIN clientes c ON c.id = u.cliente_id
       ORDER BY u.criado_em DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function excluirUsuario(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  try {
    const { rows } = await pool.query('DELETE FROM usuarios WHERE id = $1 RETURNING cliente_id', [req.params.id]);
    if (rows[0]?.cliente_id) {
      const { rowCount } = await pool.query('SELECT 1 FROM usuarios WHERE cliente_id = $1', [rows[0].cliente_id]);
      if (rowCount === 0) {
        await pool.query('DELETE FROM clientes WHERE id = $1', [rows[0].cliente_id]);
      }
    }
    res.json({ mensagem: 'Usuário excluído' });
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function toggleAtivo(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  try {
    const { rows } = await pool.query(
      // Qualquer decisão do admin (aprovar ou desativar) tira a conta da fila de aprovação
      'UPDATE usuarios SET ativo = NOT COALESCE(ativo, true), aguardando_aprovacao = false WHERE id = $1 RETURNING COALESCE(ativo, true) AS ativo',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json({ ativo: rows[0].ativo });
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function atualizarPlano(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  const { plano } = req.body;
  if (!['trial', 'ativo', 'suspenso'].includes(plano)) return res.status(400).json({ erro: 'Plano inválido' });
  try {
    await pool.query('UPDATE usuarios SET plano = $1 WHERE id = $2', [plano, req.params.id]);
    res.json({ plano });
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function atualizarEmail(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ erro: 'Email inválido' });
  try {
    const { rows } = await pool.query(
      'UPDATE usuarios SET email = $1 WHERE id = $2 RETURNING email',
      [email.toLowerCase().trim(), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json({ email: rows[0].email });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Este email já está em uso' });
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// ─── Log de acessos (admin) ───────────────────────────────────────────────────

async function listarLogAcessos(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.email, l.nome, l.ip, l.data_hora,
              c.nome AS cliente_nome
       FROM log_acessos l
       LEFT JOIN usuarios u ON u.id = l.usuario_id
       LEFT JOIN clientes c ON c.id = u.cliente_id
       ORDER BY l.data_hora DESC
       LIMIT 300`
    );
    res.json(rows);
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// ─── Perfil do próprio usuário ────────────────────────────────────────────────

async function minhaInfo(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, papel, cliente_id, nome, email_verificado, telefone, criado_em FROM usuarios WHERE id = $1',
      [req.usuario.id]
    );
    res.json(rows[0] || {});
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function editarPerfil(req, res) {
  try {
    const { nome, email, telefone, senhaAtual, novaSenha } = req.body;
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.usuario.id]);
    const usuario = rows[0];
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const sets = []; const vals = []; let idx = 1;

    if (nome !== undefined) { sets.push(`nome = $${idx++}`); vals.push(nome); }

    if (telefone !== undefined) {
      const tel = telefone ? telefone.replace(/\D/g, '') : null;
      sets.push(`telefone = $${idx++}`); vals.push(tel || null);
    }

    if (email && email.toLowerCase() !== usuario.email) {
      if (!email.includes('@') || !email.split('@')[1]?.includes('.'))
        return res.status(400).json({ erro: 'Formato de e-mail inválido' });
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
    if (err.code === '23505') {
      const msg = err.constraint?.includes('telefone') ? 'Número de WhatsApp já cadastrado' : 'E-mail já cadastrado';
      return res.status(400).json({ erro: msg });
    }
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// ─── Esqueci minha senha ──────────────────────────────────────────────────────

async function esqueceuSenha(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'E-mail obrigatório' });

  try {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length) return res.json({ mensagem: 'Se o e-mail existir, você receberá um link em breve.' });

    const usuario = rows[0];
    const token  = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await pool.query(
      'UPDATE usuarios SET token_reset_senha = $1, token_reset_expira_em = $2 WHERE id = $3',
      [token, expira, usuario.id]
    );

    const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://www.souzfinance.com';
    const link = `${frontendUrl}/redefinir?token=${token}`;

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#16a34a;padding:20px 28px;border-radius:10px 10px 0 0">
          <h1 style="color:#fff;margin:0;font-size:20px;font-weight:800">SOUZ Finance</h1>
          <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">Redefinição de senha</p>
        </div>
        <div style="background:#fff;padding:24px 28px;border:1px solid #e5e7eb;border-radius:0 0 10px 10px">
          <p style="font-size:15px;color:#111">Olá, <strong>${escHtml(usuario.nome || 'usuário')}</strong>!</p>
          <p style="font-size:14px;color:#555">Recebemos uma solicitação para redefinir a senha da sua conta. Clique no botão abaixo para criar uma nova senha:</p>
          <div style="text-align:center;margin:28px 0">
            <a href="${link}" style="background:#16a34a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
              Redefinir senha
            </a>
          </div>
          <p style="font-size:12px;color:#9ca3af">Este link expira em 1 hora. Se você não solicitou a redefinição, ignore este e-mail.</p>
        </div>
      </div>`;

    const emailData = {
      sender:      { name: 'SOUZ Finance', email: 'erpsouz@gmail.com' },
      to:          [{ email: usuario.email, name: usuario.nome || '' }],
      subject:     'Redefinição de senha — SOUZ Finance',
      htmlContent: html,
    };

    try {
      await axios.post(
        process.env.BRAVE_SMTP_SENDEMAIL_ENDPOINT_URL,
        emailData,
        { headers: { 'Content-Type': 'application/json', 'api-key': process.env.BRAVE_ENDPOINT_KEY } }
      );
    } catch (emailErr) {
      console.error('[esqueceuSenha] email falhou:', emailErr.message);
    }

    res.json({ mensagem: 'Se o e-mail existir, você receberá um link em breve.' });
  } catch (err) {
    console.error('[esqueceuSenha]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function redefinirSenhaPorToken(req, res) {
  const { token, novaSenha } = req.body;
  if (!token || !novaSenha) return res.status(400).json({ erro: 'Token e nova senha obrigatórios' });
  if (novaSenha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE token_reset_senha = $1 AND token_reset_expira_em > NOW()',
      [token]
    );
    if (!rows.length) return res.status(400).json({ erro: 'Link inválido ou expirado. Solicite um novo.' });

    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query(
      'UPDATE usuarios SET senha_hash = $1, token_reset_senha = NULL, token_reset_expira_em = NULL WHERE id = $2',
      [hash, rows[0].id]
    );

    res.json({ mensagem: 'Senha redefinida com sucesso! Você já pode fazer login.' });
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// ─── Alterar / redefinir senha ────────────────────────────────────────────────

async function alterarSenha(req, res) {
  try {
    const { senhaAtual, novaSenha } = req.body;
    if (!senhaAtual || !novaSenha) return res.status(400).json({ erro: 'Senha atual e nova senha são obrigatórias' });
    if (novaSenha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });

    const result = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.usuario.id]);
    const usuario = result.rows[0];
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });

    if (!await bcrypt.compare(senhaAtual, usuario.senha_hash)) {
      return res.status(401).json({ erro: 'Senha atual incorreta' });
    }

    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [hash, req.usuario.id]);
    res.json({ mensagem: 'Senha alterada com sucesso' });
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function redefinirSenha(req, res) {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  try {
    const { novaSenha } = req.body;
    if (!novaSenha || novaSenha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });
    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [hash, req.params.id]);
    res.json({ mensagem: 'Senha redefinida com sucesso' });
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
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
    console.error('[auth]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

module.exports = {
  login, loginGoogle, logout, tokenExtrato,
  registrarPublico, verificarEmail, reenviarVerificacao,
  esqueceuSenha, redefinirSenhaPorToken,
  registrarAdmin, criarUsuario, listarUsuarios, excluirUsuario, toggleAtivo, atualizarPlano, atualizarEmail, atualizarPermissoes,
  minhaInfo, editarPerfil, alterarSenha, redefinirSenha,
  listarLogAcessos,
};