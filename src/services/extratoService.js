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
  } catch {
    return [];
  }
}

function aplicarRegras(transacoes, regras) {
  if (!regras.length) return transacoes;
  return transacoes.map(t => {
    const descNorm = extrairPalavraChave(t.descricao || '');
    const regra = regras.find(r =>
      descNorm.includes(r.palavra_chave) || r.palavra_chave.includes(descNorm)
    );
    if (regra) {
      return { ...t, categoria_sugerida: regra.categoria, subcategoria_sugerida: regra.subcategoria || null };
    }
    return t;
  });
}

async function processarExtrato(file, clienteId) {
  const mime = file.mimetype;

  if (mime === 'application/pdf' || mime.startsWith('image/')) {
    console.log(`[Extrato] arquivo: ${file.originalname}, tamanho: ${file.size} bytes`);

    let body;
    if (mime === 'application/pdf') {
      const textoRaw = await extrairTextoPDF(file.buffer);
      const linhas = textoRaw.split('\n').map(l => l.trim()).filter(l => l.length > 1);
      const isLixo = l =>
        /agên|ag\.\s*\d|conta:/i.test(l) ||
        /\bBCO\b|\bBANCO\b/i.test(l) ||
        /S\.A\.\s*\(\d+\)/i.test(l) ||
        /\bIP\s+(LTDA|S\.A\.)/i.test(l) ||
        /^[\d]{4,}-[\d]{1,2}$/.test(l) ||
        /^[*•.\-–—]+$/.test(l);
      const texto = linhas.filter(l => !isLixo(l)).join('\n');
      console.log(`[Extrato] texto: ${textoRaw.length} → ${texto.length} chars`);
      console.log(`[Extrato] texto: ${textoRaw.length} → ${texto.length} chars`);
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