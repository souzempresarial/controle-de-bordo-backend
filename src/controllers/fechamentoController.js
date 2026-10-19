const pool = require('../models/db');

// Fechamento do mês: no último dia a equipe informa quanto a loja tem em cada conta e no caixa em espécie.
// O saldo inicial de cada conta é o final do mês anterior (só o primeiro fechamento pede os dois).
// Ao fechar, o total vira o "Capital Liq em Caixa" do Balanço Patrimonial daquele mês.

const TIPOS = ['banco', 'maquininha', 'especie'];
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

let tabelasProntas = null;
function garantirTabelas() {
  tabelasProntas ||= pool.query(`
    CREATE TABLE IF NOT EXISTS fechamento_contas (
      id         SERIAL PRIMARY KEY,
      cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      nome       VARCHAR(80) NOT NULL,
      tipo       VARCHAR(20) NOT NULL DEFAULT 'banco',
      ativa      BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS fechamento_saldos (
      id             SERIAL PRIMARY KEY,
      cliente_id     INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      conta_id       INTEGER NOT NULL REFERENCES fechamento_contas(id) ON DELETE CASCADE,
      mes_chave      VARCHAR(7) NOT NULL,
      saldo_inicial  DECIMAL(14,2),
      saldo_final    DECIMAL(14,2),
      atualizado_em  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (conta_id, mes_chave)
    );
    CREATE TABLE IF NOT EXISTS fechamentos (
      id           SERIAL PRIMARY KEY,
      cliente_id   INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      mes_chave    VARCHAR(7) NOT NULL,
      fechado_em   TIMESTAMPTZ DEFAULT NOW(),
      fechado_por  TEXT,
      UNIQUE (cliente_id, mes_chave)
    );
  `).catch(err => { tabelasProntas = null; throw err; });
  return tabelasProntas;
}

const num = v => (v == null ? null : parseFloat(v));

async function montarMes(clienteId, mesChave) {
  const { rows: contas } = await pool.query(
    'SELECT id, nome, tipo, ativa FROM fechamento_contas WHERE cliente_id = $1 ORDER BY ativa DESC, id',
    [clienteId]
  );
  const { rows: doMes } = await pool.query(
    'SELECT conta_id, saldo_inicial, saldo_final FROM fechamento_saldos WHERE cliente_id = $1 AND mes_chave = $2',
    [clienteId, mesChave]
  );
  // Último saldo final de cada conta antes deste mês (o mês anterior pode ter ficado em branco)
  const { rows: anteriores } = await pool.query(
    `SELECT DISTINCT ON (conta_id) conta_id, mes_chave, saldo_final
     FROM fechamento_saldos
     WHERE cliente_id = $1 AND mes_chave < $2 AND saldo_final IS NOT NULL
     ORDER BY conta_id, mes_chave DESC`,
    [clienteId, mesChave]
  );
  const { rows: [fech] } = await pool.query(
    'SELECT fechado_em, fechado_por FROM fechamentos WHERE cliente_id = $1 AND mes_chave = $2',
    [clienteId, mesChave]
  );

  const linhas = contas
    .map(c => {
      const atual = doMes.find(s => s.conta_id === c.id);
      const ant   = anteriores.find(s => s.conta_id === c.id);
      const digitado = num(atual?.saldo_inicial);
      return {
        id: c.id, nome: c.nome, tipo: c.tipo, ativa: c.ativa,
        inicial: digitado ?? num(ant?.saldo_final),
        inicialOrigem: digitado != null ? 'digitado' : ant ? ant.mes_chave : null,
        final: num(atual?.saldo_final),
      };
    })
    // Conta desativada só aparece enquanto ainda tem dinheiro (saldo herdado diferente de zero ou digitado no mês)
    .filter(c => c.ativa || (c.inicial != null && c.inicial !== 0) || c.final != null);

  return { mesChave, contas: linhas, fechado: fech ? { em: fech.fechado_em, por: fech.fechado_por } : null };
}

async function nomeUsuario(id) {
  const { rows: [u] } = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [id]);
  return u?.nome || null;
}

async function mesFechado(clienteId, mesChave) {
  const { rows } = await pool.query('SELECT 1 FROM fechamentos WHERE cliente_id = $1 AND mes_chave = $2', [clienteId, mesChave]);
  return rows.length > 0;
}

async function buscar(req, res) {
  try {
    const { clienteId, mesChave } = req.params;
    if (!MES_RE.test(mesChave)) return res.status(400).json({ erro: 'Mês inválido' });
    await garantirTabelas();
    res.json(await montarMes(clienteId, mesChave));
  } catch (err) {
    console.error('[fechamento.buscar]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function criarConta(req, res) {
  try {
    const { clienteId } = req.params;
    const nome = String(req.body.nome || '').trim().slice(0, 80);
    const tipo = TIPOS.includes(req.body.tipo) ? req.body.tipo : 'banco';
    if (!nome) return res.status(400).json({ erro: 'Informe o nome da conta' });
    await garantirTabelas();
    const { rows: [dup] } = await pool.query(
      'SELECT id FROM fechamento_contas WHERE cliente_id = $1 AND ativa AND lower(nome) = lower($2)', [clienteId, nome]);
    if (dup) return res.status(409).json({ erro: `Já existe a conta "${nome}"` });
    const { rows: [c] } = await pool.query(
      'INSERT INTO fechamento_contas (cliente_id, nome, tipo) VALUES ($1, $2, $3) RETURNING id, nome, tipo, ativa',
      [clienteId, nome, tipo]);
    res.status(201).json(c);
  } catch (err) {
    console.error('[fechamento.criarConta]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function editarConta(req, res) {
  try {
    const { clienteId, contaId } = req.params;
    await garantirTabelas();
    const campos = [];
    const vals   = [];
    if (req.body.nome !== undefined) {
      const nome = String(req.body.nome).trim().slice(0, 80);
      if (!nome) return res.status(400).json({ erro: 'Informe o nome da conta' });
      vals.push(nome); campos.push(`nome = $${vals.length + 2}`);
    }
    if (req.body.tipo !== undefined && TIPOS.includes(req.body.tipo)) { vals.push(req.body.tipo); campos.push(`tipo = $${vals.length + 2}`); }
    if (req.body.ativa !== undefined) { vals.push(!!req.body.ativa); campos.push(`ativa = $${vals.length + 2}`); }
    if (!campos.length) return res.status(400).json({ erro: 'Nada para alterar' });
    const { rows: [c] } = await pool.query(
      `UPDATE fechamento_contas SET ${campos.join(', ')} WHERE id = $1 AND cliente_id = $2 RETURNING id, nome, tipo, ativa`,
      [contaId, clienteId, ...vals]);
    if (!c) return res.status(404).json({ erro: 'Conta não encontrada' });
    res.json(c);
  } catch (err) {
    console.error('[fechamento.editarConta]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function salvarSaldo(req, res) {
  try {
    const { clienteId, mesChave } = req.params;
    const { contaId, campo } = req.body;
    if (!MES_RE.test(mesChave)) return res.status(400).json({ erro: 'Mês inválido' });
    if (!['inicial', 'final'].includes(campo)) return res.status(400).json({ erro: 'Campo inválido' });
    const valor = req.body.valor === null || req.body.valor === '' ? null : Number(req.body.valor);
    if (valor !== null && !Number.isFinite(valor)) return res.status(400).json({ erro: 'Valor inválido' });
    await garantirTabelas();
    if (await mesFechado(clienteId, mesChave)) return res.status(409).json({ erro: 'Este mês já foi fechado. Reabra para alterar.' });
    const { rows: [conta] } = await pool.query('SELECT id FROM fechamento_contas WHERE id = $1 AND cliente_id = $2', [contaId, clienteId]);
    if (!conta) return res.status(404).json({ erro: 'Conta não encontrada' });
    const col = campo === 'inicial' ? 'saldo_inicial' : 'saldo_final';
    await pool.query(
      `INSERT INTO fechamento_saldos (cliente_id, conta_id, mes_chave, ${col}) VALUES ($1, $2, $3, $4)
       ON CONFLICT (conta_id, mes_chave) DO UPDATE SET ${col} = $4, atualizado_em = NOW()`,
      [clienteId, contaId, mesChave, valor]);
    res.json(await montarMes(clienteId, mesChave));
  } catch (err) {
    console.error('[fechamento.salvarSaldo]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function fechar(req, res) {
  let client;
  try {
    const { clienteId, mesChave } = req.params;
    if (!MES_RE.test(mesChave)) return res.status(400).json({ erro: 'Mês inválido' });
    await garantirTabelas();
    const mes = await montarMes(clienteId, mesChave);
    const ativas = mes.contas.filter(c => c.ativa);
    if (!ativas.length) return res.status(400).json({ erro: 'Cadastre ao menos uma conta antes de fechar.' });
    const faltando = ativas.filter(c => c.inicial == null || c.final == null).map(c => c.nome);
    if (faltando.length) return res.status(400).json({ erro: `Falta saldo em: ${faltando.join(', ')}` });

    const total = Math.round(mes.contas.reduce((a, c) => a + (c.final || 0), 0) * 100) / 100;
    const por = await nomeUsuario(req.usuario.id);
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO fechamentos (cliente_id, mes_chave, fechado_por) VALUES ($1, $2, $3)
       ON CONFLICT (cliente_id, mes_chave) DO UPDATE SET fechado_em = NOW(), fechado_por = $3`,
      [clienteId, mesChave, por]);
    // Contas e espécie do fechamento = caixa da loja no Balanço Patrimonial daquele mês
    await client.query(
      `INSERT INTO capital (cliente_id, mes_chave, campo, valor) VALUES ($1, $2, 'cap_caixa', $3)
       ON CONFLICT (cliente_id, mes_chave, campo) DO UPDATE SET valor = $3`,
      [clienteId, mesChave, total]);
    await client.query('COMMIT');
    res.json(await montarMes(clienteId, mesChave));
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[fechamento.fechar]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  } finally {
    client?.release();
  }
}

async function reabrir(req, res) {
  try {
    const { clienteId, mesChave } = req.params;
    await garantirTabelas();
    await pool.query('DELETE FROM fechamentos WHERE cliente_id = $1 AND mes_chave = $2', [clienteId, mesChave]);
    res.json(await montarMes(clienteId, mesChave));
  } catch (err) {
    console.error('[fechamento.reabrir]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

module.exports = { buscar, criarConta, editarConta, salvarSaldo, fechar, reabrir, garantirTabelas };
