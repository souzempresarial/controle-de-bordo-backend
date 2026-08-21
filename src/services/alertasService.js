const https = require('https');
const pool  = require('../models/db');

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
}

function fmtData(iso) {
  if (!iso) return '';
  // node-postgres retorna DATE como Date UTC meia-noite; extrai YYYY-MM-DD antes de formatar
  const str = iso instanceof Date ? iso.toISOString().slice(0, 10) : String(iso);
  return new Date(str + 'T12:00:00').toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function buscarVencimentosPorCliente() {
  const { rows } = await pool.query(`
    SELECT
      co.id,
      co.vencimento          AS data,
      co.valor,
      co.categoria,
      co.subcategoria,
      co.descricao,
      cl.nome                AS cliente_nome,
      u.email                AS cliente_email,
      u.nome                 AS usuario_nome,
      (co.vencimento::date - CURRENT_DATE) AS dias_restantes
    FROM contas co
    JOIN clientes cl ON cl.id = co.cliente_id
    JOIN usuarios u  ON u.cliente_id = co.cliente_id
                    AND u.papel = 'cliente'
                    AND u.ativo = TRUE
    WHERE co.tipo   = 'pagar'
      AND co.status = 'pendente'
      AND co.vencimento::date IN (
        CURRENT_DATE + INTERVAL '30 days',
        CURRENT_DATE + INTERVAL '7 days',
        CURRENT_DATE + INTERVAL '1 day',
        CURRENT_DATE
      )
    ORDER BY co.vencimento ASC
  `);

  // Agrupar por e-mail do cliente
  const porCliente = {};
  for (const row of rows) {
    const key = row.cliente_email;
    if (!porCliente[key]) {
      porCliente[key] = {
        email:        row.cliente_email,
        nome:         row.usuario_nome || row.cliente_nome,
        cliente_nome: row.cliente_nome,
        contas:       [],
      };
    }
    porCliente[key].contas.push(row);
  }

  return Object.values(porCliente);
}

function buildHTML(cliente, contas, hoje) {
  const grupos = { 0: [], 1: [], 7: [], 30: [] };
  contas.forEach(c => {
    const d = Number(c.dias_restantes);
    if (grupos[d] !== undefined) grupos[d].push(c);
  });

  const tituloGrupo = {
    0:  '🔴 Vence hoje',
    1:  '🔴 Vence amanhã',
    7:  '🟡 Vence em 7 dias',
    30: '🔵 Vence em 30 dias',
  };

  const tabela = (rows) => `
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Categoria</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Descrição</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e5e7eb">Valor</th>
          <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #e5e7eb">Vencimento</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr style="border-bottom:1px solid #f3f4f6">
            <td style="padding:8px 12px;color:#555">${escHtml(r.categoria) || '—'}</td>
            <td style="padding:8px 12px;color:#555">${escHtml(r.descricao || r.subcategoria) || '—'}</td>
            <td style="padding:8px 12px;text-align:right;font-weight:700;color:#dc2626">${fmtBRL(r.valor)}</td>
            <td style="padding:8px 12px;text-align:center">${fmtData(r.data)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  const secoes = [0, 1, 7, 30]
    .filter(d => grupos[d].length > 0)
    .map(d => `
      <h3 style="margin:24px 0 10px;font-size:15px">${tituloGrupo[d]}</h3>
      ${tabela(grupos[d])}
    `).join('');

  const totalValor = contas.reduce((s, c) => s + parseFloat(c.valor || 0), 0);

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:700px;margin:0 auto">
      <div style="background:#16a34a;padding:20px 28px;border-radius:10px 10px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px;font-weight:800">SOUZ Finance</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">Alertas de Vencimento — ${fmtData(hoje)}</p>
      </div>
      <div style="background:#fff;padding:24px 28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px">
        <p style="margin:0 0 20px;font-size:14px;color:#374151">
          Olá, <strong>${escHtml(cliente.nome)}</strong>! Você tem <strong>${contas.length} conta(s)</strong> a pagar nos próximos dias,
          totalizando <strong style="color:#dc2626">${fmtBRL(totalValor)}</strong>.
        </p>
        ${secoes}
        <p style="font-size:11px;color:#9ca3af;margin-top:24px;border-top:1px solid #f3f4f6;padding-top:12px">
          Este e-mail foi gerado automaticamente pelo SOUZ Finance. Acesse o sistema para mais detalhes.
        </p>
      </div>
    </div>`;
}

function enviarEmail(destinatario, html, totalAlertas) {
  return new Promise((resolve, reject) => {
    const hoje = new Date().toLocaleDateString('pt-BR');
    const body = JSON.stringify({
      sender:      { name: 'SOUZ Finance', email: 'contato@souzempresarial.com' },
      to:          [{ email: destinatario.email, name: destinatario.nome }],
      subject:     `[SOUZ Finance] ${totalAlertas} vencimento(s) próximo(s) — ${hoje}`,
      htmlContent: html,
    });

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
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Brevo error ${res.statusCode}: ${data}`));
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function executarAlertas() {
  const hoje    = new Date();
  const clientes = await buscarVencimentosPorCliente();

  if (!clientes.length) {
    console.log('[Alertas] Nenhum vencimento para hoje.');
    return { enviado: false, total: 0, clientes: 0 };
  }

  let totalEnviados = 0;
  for (const cliente of clientes) {
    try {
      const html = buildHTML(cliente, cliente.contas, hoje);
      await enviarEmail(cliente, html, cliente.contas.length);
      console.log(`[Alertas] E-mail enviado para ${cliente.email} (${cliente.contas.length} conta(s)).`);
      totalEnviados++;
    } catch (err) {
      console.error(`[Alertas] Erro ao enviar para ${cliente.email}:`, err.message);
    }
  }

  console.log(`[Alertas] Concluído: ${totalEnviados}/${clientes.length} e-mails enviados.`);
  return { enviado: totalEnviados > 0, total: clientes.reduce((s, c) => s + c.contas.length, 0), clientes: totalEnviados };
}

module.exports = { executarAlertas };
