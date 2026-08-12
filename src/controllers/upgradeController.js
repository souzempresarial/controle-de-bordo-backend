const pool = require('../models/db');

function calcStatus(ap) {
  if (ap.status === 'vendido') return 'VENDIDO';
  const dias = Math.max(0, Math.floor((Date.now() - new Date(ap.criado_em)) / (1000 * 60 * 60 * 24)));
  if (dias < 7)  return 'NO PRAZO';
  if (dias < 10) return 'ALERTA';
  if (dias < 15) return 'ATENÇÃO';
  return 'URGENTE';
}

async function listar(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM aparelhos_upgrade WHERE cliente_id = $1 ORDER BY criado_em DESC',
      [req.params.clienteId]
    );
    res.json(rows.map(a => ({ ...a, statusAuto: calcStatus(a) })));
  } catch (err) {
    console.error('[upgrade.listar]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function criar(req, res) {
  try {
    const { clienteId } = req.params;
    const { modelo, cor, armazenamento, bateria, email_aparelho, observacoes, valor_avaliado, valor_pretendido, data_entrada, imei } = req.body;
    if (!modelo) return res.status(400).json({ erro: 'Modelo obrigatório' });
    const criadoEm = data_entrada || new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `INSERT INTO aparelhos_upgrade (cliente_id, modelo, cor, armazenamento, bateria, email_aparelho, observacoes, valor_avaliado, valor_pretendido, criado_em, imei)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [clienteId, modelo, cor||null, armazenamento||null, bateria||null, email_aparelho||null, observacoes||null, valor_avaliado||null, valor_pretendido||null, criadoEm, imei||null]
    );
    res.status(201).json({ ...rows[0], statusAuto: calcStatus(rows[0]) });
  } catch (err) {
    console.error('[upgrade.criar]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function editar(req, res) {
  try {
    const { clienteId, aparelhoId } = req.params;
    const { modelo, cor, armazenamento, bateria, email_aparelho, observacoes, valor_avaliado, valor_pretendido, data_entrada, imei } = req.body;
    const params = [modelo, cor||null, armazenamento||null, bateria||null, email_aparelho||null, observacoes||null, valor_avaliado||null, valor_pretendido||null, imei||null];
    let set = 'modelo=$1, cor=$2, armazenamento=$3, bateria=$4, email_aparelho=$5, observacoes=$6, valor_avaliado=$7, valor_pretendido=$8, imei=$9';
    if (data_entrada) {
      params.push(data_entrada);
      set += `, criado_em=$${params.length}`;
    }
    params.push(aparelhoId, clienteId);
    const { rows } = await pool.query(
      `UPDATE aparelhos_upgrade SET ${set} WHERE id=$${params.length - 1} AND cliente_id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ erro: 'Aparelho não encontrado' });
    res.json({ ...rows[0], statusAuto: calcStatus(rows[0]) });
  } catch (err) {
    console.error('[upgrade.editar]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function excluir(req, res) {
  try {
    const result = await pool.query(
      'DELETE FROM aparelhos_upgrade WHERE id=$1 AND cliente_id=$2',
      [req.params.aparelhoId, req.params.clienteId]
    );
    if (!result.rowCount) return res.status(404).json({ erro: 'Aparelho não encontrado' });
    res.json({ mensagem: 'Aparelho excluído' });
  } catch (err) {
    console.error('[upgrade.excluir]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function vender(req, res) {
  try {
    const { clienteId, aparelhoId } = req.params;
    const { valor_venda, data, pagamento, valor_recebido } = req.body;
    if (!valor_venda || parseFloat(valor_venda) <= 0) return res.status(400).json({ erro: 'Valor de venda obrigatório' });

    const { rows } = await pool.query('SELECT * FROM aparelhos_upgrade WHERE id=$1 AND cliente_id=$2', [aparelhoId, clienteId]);
    if (!rows.length) return res.status(404).json({ erro: 'Aparelho não encontrado' });
    const ap = rows[0];
    if (ap.status === 'vendido') return res.status(400).json({ erro: 'Aparelho já vendido' });

    const dataVenda = data || new Date().toISOString().slice(0, 10);
    const descricao = [ap.modelo, ap.armazenamento, ap.cor].filter(Boolean).join(' ');
    const grupoId   = 'upg' + Date.now();
    const recebido  = valor_recebido != null && parseFloat(valor_recebido) > 0 ? parseFloat(valor_recebido) : null;

    await pool.query(
      `INSERT INTO lancamentos (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, grupo_id, is_cmv, valor_recebido)
       VALUES ($1,'Entrada',$2,$3,'Receita de Vendas','Upgrade',$4,$5,'Confirmado',$6,false,$7)`,
      [clienteId, parseFloat(valor_venda), dataVenda, descricao, pagamento||null, grupoId, recebido]
    );

    if (ap.valor_avaliado && parseFloat(ap.valor_avaliado) > 0) {
      await pool.query(
        `INSERT INTO lancamentos (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, grupo_id, is_cmv)
         VALUES ($1,'Saída',$2,$3,'Custos Variáveis Diretos','Upgrade',$4,$5,'Confirmado',$6,true)`,
        [clienteId, parseFloat(ap.valor_avaliado), dataVenda, 'CMV — ' + descricao, pagamento||null, grupoId]
      );
    }

    const { rows: updated } = await pool.query(
      `UPDATE aparelhos_upgrade SET status='vendido', vendido_em=NOW() WHERE id=$1 AND cliente_id=$2 RETURNING *`,
      [aparelhoId, clienteId]
    );

    res.json({ ...updated[0], statusAuto: 'VENDIDO' });
  } catch (err) {
    console.error('[upgrade.vender]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function limpar(req, res) {
  try {
    await pool.query('DELETE FROM aparelhos_upgrade WHERE cliente_id=$1', [req.params.clienteId]);
    res.json({ mensagem: 'Aparelhos removidos' });
  } catch (err) {
    console.error('[upgrade.limpar]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

module.exports = { listar, criar, editar, excluir, vender, limpar };
