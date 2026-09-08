const pool = require('../models/db');

const MP_BASE = 'https://platform.mercadophone.tech/api/v1';

async function getApiKey(clienteId) {
  const { rows } = await pool.query('SELECT mercadophone_api_key FROM clientes WHERE id = $1', [clienteId]);
  return rows[0]?.mercadophone_api_key || null;
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
  if (str.includes('cabo') || str.includes('carregador') || str.includes('fonte')) return 'Cabo / Carregador';
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
  const acessorioKw = ['cabo', 'pelicula', 'película', 'capa', 'case', 'capinha', 'carregador', 'película 3d'];
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
    const apiKey = await getApiKey(req.params.clienteId);
    res.json({ configurado: !!apiKey });
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
}

async function salvarChave(req, res) {
  try {
    const { clienteId } = req.params;
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ erro: 'Chave obrigatória' });
    await pool.query('UPDATE clientes SET mercadophone_api_key = $1 WHERE id = $2', [apiKey, clienteId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[MP salvarChave]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

async function preview(req, res) {
  try {
    const { clienteId } = req.params;
    const { dataInicio, dataFim } = req.body;

    const apiKey = await getApiKey(clienteId);
    if (!apiKey) return res.status(400).json({ erro: 'Chave do Mercado Phone não configurada' });

    const params = new URLSearchParams({ limit: 300, direction: 'desc' });
    if (dataInicio) params.append('dataVendaInicial', dataInicio);
    if (dataFim)    params.append('dataVendaFinal',   dataFim);

    const mpResp = await fetch(`${MP_BASE}/sales/history?${params}`, {
      headers: { 'X-API-Key': apiKey },
    });
    if (!mpResp.ok) {
      const err = await mpResp.json().catch(() => ({}));
      throw new Error(err.detail || err.message || `Erro ${mpResp.status} no Mercado Phone`);
    }
    const { items = [] } = await mpResp.json();

    // IDs já importados
    const { rows: existentes } = await pool.query(
      `SELECT obs FROM lancamentos WHERE cliente_id = $1 AND obs LIKE '[MP-%'`,
      [clienteId]
    );
    const idsImportados = new Set(
      existentes.map(r => r.obs?.match(/\[MP-(\d+)\]/)?.[1]).filter(Boolean)
    );

    const transacoes = items.map(item => {
      const { categoria, subcategoria } = mapCategoria(
        item.tipoProdutoDescricao, item.tipoVendaDescricao, item.aparelhoDescricao,
        item.canalVendaDescricao, item.marcaDescricao
      );

      const isUpgradeAuto = (item.tipoVendaDescricao || '').toLowerCase().includes('upgrade') ||
                            (item.saudeBateria != null && item.saudeBateria !== '');
      const descontoVal   = parseFloat(item.desconto || 0);

      return {
        mpVendaId:         item.vendaId,
        data:              (item.dataVenda || '').slice(0, 10),
        valor:             parseFloat(item.valorCliente || item.valorTotal || 0),
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

module.exports = { status, salvarChave, preview, importar };
