const PDFParser = require('pdf2json');
const pool = require('../models/db');
const { extrairPalavraChave } = require('../controllers/extratoController');

const GEMINI_MODEL = 'gemini-flash-latest';

const PROMPT_SISTEMA = `Analise o extrato bancário e extraia apenas as SAÍDAS (débitos, pagamentos, transferências enviadas).

Retorne APENAS este JSON:
{
  "transacoes": [
    {
      "data": "YYYY-MM-DD",
      "descricao": "descrição",
      "valor": 123.45,
      "tipo": "Saída",
      "categoria_sugerida": "categoria exata da lista abaixo",
      "subcategoria_sugerida": "subcategoria exata da lista abaixo"
    }
  ]
}

Categorias e subcategorias permitidas:
- Custos Variáveis Diretos → Aparelhos iPhone, Aparelhos Android, iPad, MacBook, Apple Watch, AirPods, Acessórios, Embalagens, Brindes, Assistência Técnica, Outros
- Fornecedores (Estoque) → Aparelhos, Aparelhos (Upgrade), Pix Fornecedor, Acessórios, Embalagens, Brindes, Assistência Técnica, Boleto, Outro
- Deduções das Vendas → Taxas de Maquininha, Estornos, Descontos, Outro
- Custos Variáveis Indiretos → Comissões do Vendedor, Bônus de Indicação, Motoboy, Freelancers, Horas Extras de Colaboradores, Outro
- Despesas com Ocupação → Luz, Operadora Celular, Internet, Água, Aluguel / Condomínio / IPTU, Segurança, Seguro do Imóvel, Outro
- Despesas com Pessoal → Vales - Transporte & Refeição, 13º & Férias, INSS & FGTS, Adiantamento, Folha de Pagamento, Pró-Labore / PLR, Outro
- Despesas Variáveis → Mídia Paga, Tarifas Bancárias, Frete, Garantia, Manutenções / Reparos, Treinamentos, Uber, Deslocamento, Alimentação, Eventos, Veículo, Fatura de Cartão, Outro
- Softwares / Tecnologias → CRM, Sistema ERP, Outro
- Serviços Terceirizados → Assessoria Contábil, BPO Terceirização, Emissão de NF-e, Serviços Gerais (Limpeza), Google Meu Negócio, Assistência Técnica, Assessoria de Marketing, Advogado, Consultoria, Outro
- Impostos → DAS - Simples Nacional, DAS - MEIs, CEF Matriz, Ministério da Fazenda, Outro
- Dívidas / Empréstimos → Outro
- Saídas Não-Operacionais → Suprimentos, Obras, Despesas Extras, Decorações, Manutenções em Equipamentos, Patrocínio, Momento Recreativo, Perda de Mercadoria, Outro
- Investimentos → Equipamentos, Reformas, Computadores, Veículos, Imóveis, Outro

Regras: valores positivos, datas YYYY-MM-DD, ignore entradas e saldos, use EXATAMENTE os nomes da lista, retorne APENAS o JSON.`;

const MESES = {
  // PT abrev + full
  JAN:0, FEV:1, MAR:2, ABR:3, MAI:4, JUN:5, JUL:6, AGO:7, SET:8, OUT:9, NOV:10, DEZ:11,
  JANEIRO:0, FEVEREIRO:1, MARCO:2, ABRIL:3, MAIO:4, JUNHO:5, JULHO:6, AGOSTO:7,
  SETEMBRO:8, OUTUBRO:9, NOVEMBRO:10, DEZEMBRO:11,
  // EN abrev (Infinity/InfinitePay usa inglês)
  FEB:1, APR:3, MAY:4, AUG:7, SEP:8, OCT:9, DEC:11,
};

function parseDateFromLine(linha) {
  // DD/MM/YYYY
  let m = linha.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]));
  // DD-MM-YYYY
  m = linha.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]));
  // DD MMM, YYYY ou DD MMM YYYY ou DD MMMM, YYYY (ex: 01 Jul, 2026 / 01 JULHO 2026)
  m = linha.match(/(\d{1,2})\s+([A-ZÇÃÕÁÉÍÓÚa-záéíóúâêôàü]+),?\s+(\d{4})/i);
  if (m) {
    const chave = m[2].toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const idx = MESES[chave];
    if (idx !== undefined) return new Date(parseInt(m[3]), idx, parseInt(m[1]));
  }
  return null;
}

function filtrarPorPeriodo(linhas, dataInicio, dataFim) {
  if (!dataInicio && !dataFim) return linhas;
  const inicio = dataInicio ? new Date(dataInicio + 'T00:00:00') : null;
  const fim    = dataFim    ? new Date(dataFim    + 'T23:59:59') : null;

  // Infinity coloca a data no RODAPÉ do dia → backward tem prioridade
  // Stone/outros colocam no CABEÇALHO → forward tem prioridade
  const rodapeEstilo = /infinitepay|cloudwalk/i.test(linhas.join(' '));

  const datasF = new Array(linhas.length).fill(null);
  let cur = null;
  for (let i = 0; i < linhas.length; i++) {
    const d = parseDateFromLine(linhas[i]);
    if (d) cur = d;
    datasF[i] = cur;
  }

  const datasB = new Array(linhas.length).fill(null);
  cur = null;
  for (let i = linhas.length - 1; i >= 0; i--) {
    const d = parseDateFromLine(linhas[i]);
    if (d) cur = d;
    datasB[i] = cur;
  }

  if (!datasF.some(d => d) && !datasB.some(d => d)) return linhas;

  return linhas.filter((_, i) => {
    const d = rodapeEstilo ? (datasB[i] || datasF[i]) : (datasF[i] || datasB[i]);
    if (!d) return true;
    return (!inicio || d >= inicio) && (!fim || d <= fim);
  });
}

function extrairTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, true);
    parser.on('pdfParser_dataReady', () => resolve(parser.getRawTextContent()));
    parser.on('pdfParser_dataError', (err) => reject(err));
    parser.parseBuffer(buffer);
  });
}

function parseResposta(texto) {
  const limpo = texto.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const json = JSON.parse(limpo);
  return json.transacoes || [];
}

function geminiUrl() {
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
}

async function buscarRegras(clienteId) {
  if (!clienteId) return [];
  try {
    const { rows } = await pool.query(
      'SELECT palavra_chave, categoria, subcategoria FROM regras_extrato WHERE cliente_id = $1',
      [clienteId]
    );
    return rows;
  } catch { return []; }
}

function aplicarRegras(transacoes, regras) {
  if (!regras.length) return transacoes;
  return transacoes.map(t => {
    const descNorm = extrairPalavraChave(t.descricao || '');
    const regra = regras.find(r =>
      descNorm.includes(r.palavra_chave) || r.palavra_chave.includes(descNorm)
    );
    if (regra) return { ...t, categoria_sugerida: regra.categoria, subcategoria_sugerida: regra.subcategoria || null };
    return t;
  });
}

async function processarExtrato(file, clienteId, dataInicio, dataFim) {
  const mime = file.mimetype;

  if (mime === 'application/pdf' || mime.startsWith('image/')) {
    console.log(`[Extrato] arquivo: ${file.originalname}, tamanho: ${file.size} bytes`);

    let body;
    if (mime === 'application/pdf') {
      const textoRaw = await extrairTextoPDF(file.buffer);
      const todasLinhas = textoRaw.split('\n').map(l => l.trim()).filter(l => l.length > 1);
      const isLixo = l =>
        /agên|ag\.\s*\d|conta:/i.test(l) ||
        /\bBCO\b|\bBANCO\b/i.test(l) ||
        /S\.A\.\s*\(\d+\)/i.test(l) ||
        /\bIP\s+(LTDA|S\.A\.)/i.test(l) ||
        /^[\d]{4,}-[\d]{1,2}$/.test(l) ||
        /^[*•.\-–—]+$/.test(l);
      const linhasFiltradas = todasLinhas.filter(l => !isLixo(l));
      const linhasPeriodo   = filtrarPorPeriodo(linhasFiltradas, dataInicio, dataFim);
      const CAP = (dataInicio || dataFim) ? 15000 : 22000;
      const texto = linhasPeriodo.join('\n').slice(0, CAP);
      console.log(`[Extrato] ${textoRaw.length} raw → ${linhasFiltradas.length} linhas filtradas → ${linhasPeriodo.length} no período → ${texto.length} chars (cap ${CAP}, período: ${dataInicio||'*'} a ${dataFim||'*'})`);
      body = { contents: [{ parts: [{ text: `${PROMPT_SISTEMA}\n\nExtrato bancário:\n${texto}` }] }] };
    } else {
      const base64 = file.buffer.toString('base64');
      body = {
        contents: [{ parts: [
          { inline_data: { mime_type: mime, data: base64 } },
          { text: `${PROMPT_SISTEMA}\n\nAnalise o extrato bancário na imagem acima.` },
        ]}],
      };
    }

    const resp = await fetch(geminiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(data.error || data));
    console.log('[Extrato] resposta recebida do Gemini');
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Resposta vazia do Gemini');

    const transacoes = parseResposta(text);
    const regras = await buscarRegras(clienteId);
    return aplicarRegras(transacoes, regras);
  }

  throw new Error('Formato não suportado. Envie PDF ou imagem (JPG, PNG).');
}

module.exports = { processarExtrato };