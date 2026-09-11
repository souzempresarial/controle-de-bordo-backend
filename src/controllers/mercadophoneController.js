const pool = require('../models/db');

const MP_BASE = 'https://platform.mercadophone.tech/api/v1';

async function getApiKeys(clienteId) {
  const { rows } = await pool.query(
    'SELECT id, nome, api_key FROM mercadophone_chaves WHERE cliente_id = $1 AND ativa = true ORDER BY id',
    [clienteId]
  );
  return rows;
}

function mapPagamento(canal) {
  if (!canal) return '';
  const c = canal.toLowerCase();
  if (c.includes('pix'))                              return 'Pix';
  if (c.includes('crédito') || c.includes('credito')) return 'Crédito';
  if (c.includes('débito')  || c.includes('debito'))  return 'Débito';
  if (c.includes('dinheiro') || c.includes('espécie') || c.includes('especie')) return 'Dinheiro';
  if (c.includes('boleto'))                           return 'Boleto';
  if (c.includes('transferência') || c.includes('ted') || c.includes('doc'))    return 'Transferência';
  // canal pode ser "Aparelho", "Upgrade" etc — nesses casos retorna vazio para usuário definir
  return '';
}

function mapAcessorioSub(str) {
  if (str.includes('fonte')) return 'Fonte Turbo';
  if (str.includes('cabo') || str.includes('carregador')) return 'Cabo / Carregador';
  if (str.includes('pelicula') || str.includes('película') || str.includes('capa') || str.includes('case')) return 'Capa e Película';
  return 'Acessórios Geral';
}

function mapCategoria(tipoProduto, tipoVenda, aparelho, canalVenda, marca) {
  const tv  = (tipoVenda  || '').toLowerCase();
  const ap  = (aparelho   || '').toLowerCase();
  const tp  = (tipoProduto|| '').toLowerCase();
  const cv  = (canalVenda || '').toLowerCase();
  const ma  = (marca      || '').toLowerCase();
  const str = ap || tp;

  // Assistência técnica
  if (tv.includes('assist') || tv.includes('serviço') || tp.includes('serviço') || tp.includes('reparo'))
    return { categoria: 'Assistência Técnica', subcategoria: 'Outro' };

  // Upgrade — detecta pelo canal de venda, tipo de venda ou descrição
  if (cv.includes('upgrade') || tv.includes('upgrade') || str.includes('upgrade'))
    return { categoria: 'Aparelhos', subcategoria: 'Upgrade' };

  // Acessórios — detecta pela descrição do produto
  const acessorioKw = ['cabo', 'pelicula', 'película', 'capa', 'case', 'capinha', 'carregador', 'película 3d', 'fonte'];
  if (acessorioKw.some(k => str.includes(k)))
    return { categoria: 'Acessórios', subcategoria: mapAcessorioSub(str) };

  // Aparelhos — usa marca (marcaDescricao) como sinal adicional
  if (str.includes('iphone') || (ma.includes('apple') && str.includes('iphone'))) return { categoria: 'Aparelhos', subcategoria: 'iPhone' };
  if (str.includes('airpods'))                                                      return { categoria: 'Aparelhos', subcategoria: 'AirPods' };
  if (str.includes('apple watch') || str.includes('watch'))                         return { categoria: 'Aparelhos', subcategoria: 'Apple Watch' };
  if (str.includes('ipad'))                                                          return { categoria: 'Aparelhos', subcategoria: 'iPad' };
  if (str.includes('macbook') || str.includes('mac'))                               return { categoria: 'Aparelhos', subcategoria: 'Mac' };
  const androidMarcas = ['samsung', 'motorola', 'xiaomi', 'redmi', 'lg', 'sony', 'asus', 'realme', 'oppo', 'oneplus', 'huawei', 'positivo', 'multilaser'];
  if (str.includes('android') || androidMarcas.some(m => str.includes(m) || ma.includes(m)))
    return { categoria: 'Aparelhos', subcategoria: 'Android' };
  if (ma.includes('apple')) return { categoria: 'Aparelhos', subcategoria: 'iPhone' };

  return { categoria: 'Aparelhos', subcategoria: 'Outro' };
}

function mapCmvSub(subcategoria, categoria) {
  if ((categoria || '').toLowerCase().includes('acess'))   return 'Acessórios';
  if ((categoria || '').toLowerCase().includes('assist'))  return 'Assistência Técnica';
  const s = (subcategoria || '').toLowerCase();
  if (s.includes('iphone'))                                return 'Aparelhos iPhone';
  if (s.includes('android'))                               return 'Aparelhos Android';
  if (s.includes('airpods'))                               return 'AirPods';
  if (s.includes('apple watch') || s.includes('watch'))   return 'Apple Watch';
  if (s.includes('ipad'))                                  return 'iPad';
  if (s.includes('mac'))                                   return 'MacBook';
  if (s.includes('upgrade'))                               return 'Upgrade';
  return 'Outros';
}

async function status(req, res) {
  try {
    const keys = await getApiKeys(req.params.clienteId);
    res.json({ configurado: keys.length > 0, total: keys.length });
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function listarChaves(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT id, nome, LEFT(api_key, 6) || \'...\' || RIGHT(api_key, 4) AS api_key_masked, ativa, criado_em FROM mercadophone_chaves WHERE cliente_id = $1 ORDER BY id',
      [req.params.clienteId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[MP listarChaves]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

async function adicionarChave(req, res) {
  try {
    const { clienteId } = req.params;
    const { apiKey, nome } = req.body;
    if (!apiKey) return res.status(400).json({ erro: 'Chave obrigatória' });
    const { rows } = await pool.query(
      'INSERT INTO mercadophone_chaves (cliente_id, nome, api_key) VALUES ($1, $2, $3) RETURNING id, nome',
      [clienteId, nome || 'Principal', apiKey]
    );
    res.json({ ok: true, chave: rows[0] });
  } catch (err) {
    console.error('[MP adicionarChave]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

async function removerChave(req, res) {
  try {
    const { clienteId, chaveId } = req.params;
    await pool.query(
      'DELETE FROM mercadophone_chaves WHERE id = $1 AND cliente_id = $2',
      [chaveId, clienteId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[MP removerChave]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

// mantido para compatibilidade com chave legada
async function salvarChave(req, res) {
  return adicionarChave(req, res);
}

async function preview(req, res) {
  try {
    const { clienteId } = req.params;
    const { dataInicio, dataFim } = req.body;

    const chaves = await getApiKeys(clienteId);
    if (!chaves.length) return res.status(400).json({ erro: 'Chave do Mercado Phone não configurada' });

    const params = new URLSearchParams({ limit: 300, direction: 'desc' });
    if (dataInicio) params.append('dataVendaInicial', dataInicio);
    if (dataFim)    params.append('dataVendaFinal',   dataFim);

    // Busca em todas as chaves e merge por vendaId; guarda nome da unidade de origem
    const itemsMap = new Map();
    for (const chave of chaves) {
      const mpResp = await fetch(`${MP_BASE}/sales/history?${params}`, {
        headers: { 'X-API-Key': chave.api_key },
      });
      if (!mpResp.ok) {
        const err = await mpResp.json().catch(() => ({}));
        console.error(`[MP preview] chave ${chave.id} erro:`, err.detail || mpResp.status);
        continue;
      }
      const { items = [] } = await mpResp.json();
      for (const item of items) {
        if (!itemsMap.has(item.vendaId)) {
          itemsMap.set(item.vendaId, { ...item, _chaveNome: chave.nome });
        }
      }
    }
    const items = [...itemsMap.values()];

    // IDs já importados via MP
    const { rows: existentes } = await pool.query(
      `SELECT obs FROM lancamentos WHERE cliente_id = $1 AND obs LIKE '[MP-%'`,
      [clienteId]
    );
    const idsImportados = new Set(
      existentes.map(r => r.obs?.match(/\[MP-(\d+)\]/)?.[1]).filter(Boolean)
    );

    // Lançamentos manuais (sem tag MP) — para detectar possíveis duplicatas
    const { rows: manuais } = await pool.query(
      `SELECT data::text, valor FROM lancamentos
       WHERE cliente_id = $1 AND tipo = 'Entrada'
       AND (obs IS NULL OR obs NOT LIKE '[MP-%')`,
      [clienteId]
    );
    const chavesManuais = new Set(
      manuais.map(r => `${r.data.slice(0, 10)}-${parseFloat(r.valor).toFixed(2)}`)
    );

    const transacoes = items.map(item => {
      const { categoria, subcategoria } = mapCategoria(
        item.tipoProdutoDescricao, item.tipoVendaDescricao, item.aparelhoDescricao,
        item.canalVendaDescricao, item.marcaDescricao
      );

      const isUpgradeAuto = (item.tipoVendaDescricao || '').toLowerCase().includes('upgrade') ||
                            (item.saudeBateria != null && item.saudeBateria !== '');
      const descontoVal   = parseFloat(item.desconto || 0);
      const valorBruto    = parseFloat(item.valorCliente || item.valorTotal || 0);
      const valorFinal    = Math.max(0, valorBruto - descontoVal);
      const chaveMP       = `${(item.dataVenda || '').slice(0, 10)}-${valorFinal.toFixed(2)}`;

      return {
        mpVendaId:         item.vendaId,
        data:              (item.dataVenda || '').slice(0, 10),
        valor:             valorFinal,
        cmvValor:          parseFloat(item.valorCusto || 0),
        quantidade:        item.quantidade || null,
        categoria,
        subcategoria,
        descricao:         item.aparelhoDescricao || item.tipoProdutoDescricao || '',
        pagamento:         '',
        status:            (item.statusVenda || '').toLowerCase() === 'cancelado' ? 'Cancelado' : 'Confirmado',
        vendedorNome:      item.vendedorNome        || '',
        clienteNome:       item.clienteNome         || '',
        tipoVendaOriginal: item.tipoVendaDescricao  || '',
        canalOriginal:     item.canalVendaDescricao || '',
        desconto:          descontoVal > 0 ? descontoVal : null,
        isUpgrade:         isUpgradeAuto,
        valorUpgrade:      '',
        jaImportado:       idsImportados.has(String(item.vendaId)),
        possivelDuplicata: !idsImportados.has(String(item.vendaId)) && valorFinal > 0 && chavesManuais.has(chaveMP),
        chaveNome:         item._chaveNome || '',
      };
    });

    res.json({ transacoes });
  } catch (err) {
    console.error('[MP preview]', err.message);
    res.status(500).json({ erro: err.message || 'Erro interno' });
  }
}

async function importar(req, res) {
  try {
    const { clienteId } = req.params;
    const { transacoes } = req.body;

    if (!transacoes?.length) return res.json({ importados: 0 });

    let importados = 0;
    for (const t of transacoes) {
      if (t.jaImportado) continue;

      const upgradeVal  = t.valorUpgrade && parseFloat(t.valorUpgrade) > 0 ? parseFloat(t.valorUpgrade) : null;
      const isDowngrade = upgradeVal != null && upgradeVal > t.valor;
      const grupoId     = (t.cmvValor > 0 || isDowngrade) ? `g${Date.now()}${t.mpVendaId}` : null;
      const obs         = `[MP-${t.mpVendaId}]${t.vendedorNome ? ' ' + t.vendedorNome : ''}`;

      await pool.query(
        `INSERT INTO lancamentos
          (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, quantidade, obs, grupo_id, is_cmv, valor_upgrade)
         VALUES ($1,'Entrada',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,$12)`,
        [clienteId, t.valor, t.data, t.categoria, t.subcategoria || null,
         t.descricao || null, t.pagamento || null, t.status || 'Confirmado',
         t.quantidade ?? null, obs, grupoId, upgradeVal]
      );

      if (t.cmvValor > 0) {
        await pool.query(
          `INSERT INTO lancamentos
            (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, obs, grupo_id, is_cmv)
           VALUES ($1,'Saída',$2,$3,'Custos Variáveis Diretos',$4,$5,$6,$7,$8,$9,true)`,
          [clienteId, t.cmvValor, t.data, mapCmvSub(t.subcategoria, t.categoria),
           'CMV — ' + (t.descricao || ''), t.pagamento || null,
           t.status || 'Confirmado',
           `CMV vinculado ao MP-${t.mpVendaId}`, grupoId]
        );
      }

      if (isDowngrade) {
        await pool.query(
          `INSERT INTO lancamentos
            (cliente_id, tipo, valor, data, categoria, subcategoria, descricao, pagamento, status, obs, grupo_id, is_cmv)
           VALUES ($1,'Saída',$2,$3,'Downgrade','Downgrade',$4,$5,$6,$7,$8,false)`,
          [clienteId, upgradeVal - t.valor, t.data,
           'Downgrade — ' + (t.descricao || ''), t.pagamento || null,
           t.status || 'Confirmado',
           `Downgrade vinculado ao MP-${t.mpVendaId}`, grupoId]
        );
      }

      importados++;
    }

    res.json({ importados });
  } catch (err) {
    console.error('[MP importar]', err.message);
    res.status(500).json({ erro: err.message || 'Erro interno' });
  }
}

module.exports = { status, listarChaves, adicionarChave, salvarChave, removerChave, preview, importar };
