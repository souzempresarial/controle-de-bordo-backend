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
  const [y, m, d] = iso.toISOString ? iso.toISOString().slice(0, 10).split('-') : iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

async function buscarVencimentos() {
  const result = await pool.query(`
    SELECT
      l.id, l.data, l.valor, l.categoria, l.subcategoria, l.descricao, l.pagamento,
      c.nome AS cliente_nome,
      (l.data::date - CURRENT_DATE) AS dias_restantes
    FROM lancamentos l
    JOIN clientes c ON c.id = l.cliente_id
    WHERE l.tipo    = 'Saída'
      AND l.status  = 'Pendente'
      AND l.data::date IN (
        CURRENT_DATE + INTERVAL '30 days',
        CURRENT_DATE + INTERVAL '7 days',
        CURRENT_DATE + INTERVAL '1 day'
      )
    ORDER BY l.data ASC, c.nome ASC
  `);
  return result.rows;
}

function buildHTML(vencimentos, hoje) {
  if (!vencimentos.length) {
    return `<p style="color:#555">Nenhum vencimento encontrado para hoje, 7 dias ou 30 dias.</p>`;
  }

  const grupos = { 1: [], 7: [], 30: [] };
  vencimentos.forEach(v => { if (grupos[v.dias_restantes]) grupos[v.dias_restantes].push(v); });

  const tituloGrupo = { 1: '🔴 Vence amanhã (1 dia)', 7: '🟡 Vence em 7 dias', 30: '🔵 Vence em 30 dias' };

  const tabela = (rows) => `
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Cliente</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Categoria</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Descrição</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e5e7eb">Valor</th>
          <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #e5e7eb">Vencimento</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr style="border-bottom:1px solid #f3f4f6">
            <td style="padding:8px 12px;font-weight:600">${escHtml(r.cliente_nome)}</td>
            <td style="padding:8px 12px;color:#555">${escHtml(r.categoria) || '—'}</td>
            <td style="padding:8px 12px;color:#555">${escHtml(r.descricao || r.subcategoria) || '—'}</td>
            <td style="padding:8px 12px;text-align:right;font-weight:700;color:#dc2626">${fmtBRL(r.valor)}</td>
            <td style="padding:8px 12px;text-align:center">${fmtData(r.data)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  const secoes = [1, 7, 30]
    .filter(d => grupos[d].length > 0)
    .map(d => `
      <h3 style="margin:24px 0 10px;font-size:15px">${tituloGrupo[d]}</h3>
      ${tabela(grupos[d])}
    `).join('');

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:700px;margin:0 auto">
      <div style="background:#16a34a;padding:20px 28px;border-radius:10px 10px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px;font-weight:800">SOUZ Finance</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">Alertas de Vencimento — ${fmtData(hoje)}</p>
      </div>
      <div style="background:#fff;padding:24px 28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px">
        ${secoes}
        <p style="font-size:11px;color:#9ca3af;margin-top:24px;border-top:1px solid #f3f4f6;padding-top:12px">
          Este e-mail foi gerado automaticamente pelo SOUZ Finance.
        </p>
      </div>
    </div>`;
}

function enviarEmail(html, totalAlertas) {
  return new Promise((resolve, reject) => {
    const hoje = new Date().toLocaleDateString('pt-BR');
    const body = JSON.stringify({
      sender:      { name: 'SOUZ Finance', email: 'contato@souzempresarial.com' },
      to:          [{ email: 'contato@souzempresarial.com', name: 'Bryan' }],
      subject:     `[SOUZ Finance] ${totalAlertas} vencimento(s) próximo(s) — ${hoje}`,
      htmlContent: html,
    });

    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers:  {
        'api-key':      process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
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
  const hoje = new Date();
  const vencimentos = await buscarVencimentos();

  if (!vencimentos.length) {
    console.log('[Alertas] Nenhum vencimento para hoje.');
    return { enviado: false, total: 0 };
  }

  const html = buildHTML(vencimentos, hoje);
  await enviarEmail(html, vencimentos.length);

  console.log(`[Alertas] E-mail enviado com ${vencimentos.length} vencimento(s).`);
  return { enviado: true, total: vencimentos.length };
}

module.exports = { executarAlertas };