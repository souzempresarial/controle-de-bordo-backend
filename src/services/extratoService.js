const PDFParser = require('pdf2json');

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
    parser.on('pdfParser_dataReady', () => {
      resolve(parser.getRawTextContent());
    });
    parser.on('pdfParser_dataError', (err) => reject(err));
    parser.parseBuffer(buffer);
  });
}

function geminiUrl() {
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
}

function parseResposta(texto) {
  const limpo = texto.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const json = JSON.parse(limpo);
  return json.transacoes || [];
}

async function processarExtrato(file) {
  const mime = file.mimetype;

  if (mime === 'application/pdf' || mime.startsWith('image/')) {
    console.log(`[Extrato] arquivo: ${file.originalname}, tamanho: ${file.size} bytes`);

    let body;
    if (mime === 'application/pdf') {
      const textoRaw = await extrairTextoPDF(file.buffer);
      const linhas = textoRaw.split('\n').map(l => l.trim()).filter(Boolean);
      const temData  = l => /\d{2}\/\d{2}/.test(l);
      const temValor = l => /\d[\d.]*,\d{2}/.test(l);
      const texto = linhas.filter(l => temData(l) || temValor(l)).join('\n');
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
    return parseResposta(text);
  }

  throw new Error('Formato não suportado. Envie PDF ou imagem (JPG, PNG).');
}

module.exports = { processarExtrato };