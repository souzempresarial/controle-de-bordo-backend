// Mesma lista de controle-de-bordo-react/src/services/constants.js — ao mudar lá, mudar aqui
const CATEGORIAS_SAIDA = {
  'Custos Variáveis Diretos':   ['Aparelhos iPhone','Aparelhos Android','iPad','MacBook','Apple Watch','AirPods','Smartwatch','Notebook','Upgrade','Acessórios','Embalagens','Brindes','Assistência Técnica','Perda de Mercadoria','Outros'],
  'Fornecedores (Estoque)':     ['Aparelhos','Pix Fornecedor','Acessórios','Embalagens','Brindes','Assistência Técnica','Reparo','Boleto','Outro'],
  'Deduções das Vendas':        ['Taxas de Maquininha','Estornos','Descontos','Outro'],
  'Custos Variáveis Indiretos': ['Comissões do Vendedor','Bônus de Indicação','Motoboy','Freelancers','Horas Extras de Colaboradores','Outro'],
  'Despesas com Ocupação':      ['Luz','Operadora Celular','Internet','Água','Aluguel / Condomínio / IPTU','Segurança','Seguro do Imóvel','Outro'],
  'Despesas com Pessoal':       ['Vales - Transporte & Refeição','13º & Férias','INSS & FGTS','Adiantamento','Folha de Pagamento','Pró-Labore / PLR','Plano de Saúde','Rescisão e Acertos','Exames e Medicina do Trabalho','Outro'],
  'Despesas Variáveis':         ['Tarifas Bancárias','Frete','Garantia','Manutenções / Reparos','Treinamentos','Uber','Deslocamento','Alimentação','Suprimentos','Eventos','Veículo','Fatura de Cartão','Outro'],
  'Marketing':                  ['Tráfego Pago','Agência / Gestor de Tráfego','Produção de Conteúdo','Influenciadores','Patrocínio','Ações e Brindes de Marketing','Mídia Offline','Google Meu Negócio','Outro'],
  'Softwares / Tecnologias':    ['CRM','Sistema ERP','Assinaturas e Apps','Site, Domínio e Hospedagem','Sistema Fiscal / Emissor de NF','Outro'],
  'Serviços Terceirizados':     ['Assessoria Contábil','BPO Terceirização','Emissão de NF-e','Serviços Gerais (Limpeza)','Assistência Técnica','Advogado','Consultoria','Outro'],
  'Impostos':                   ['DAS - Simples Nacional','DAS - MEIs','Darf','ICMS / Estadual','Taxas Municipais','Outro'],
  'Saídas Não-Operacionais':    ['Despesas Extras','Decorações','Momento Recreativo','Outro'],
  'Dívidas / Empréstimos':      ['Parcela de Empréstimo','Juros','Amortização','IOF','Multa','Cheque Especial','Cartão de Crédito PJ','Outro'],
  'Investimentos':              ['Equipamentos','Reformas','Computadores','Veículos','Imóveis','Outro'],
};

function listaParaPrompt() {
  return Object.entries(CATEGORIAS_SAIDA).map(([cat, subs]) => `- ${cat} → ${subs.join(', ')}`).join('\n');
}

// Devolve só nomes que existem na lista; o que a IA inventar vira vazio para o analista escolher
function validarCategoria(categoria, subcategoria) {
  const subs = CATEGORIAS_SAIDA[categoria];
  if (!subs) return { categoria: '', subcategoria: '' };
  return { categoria, subcategoria: subs.includes(subcategoria) ? subcategoria : '' };
}

module.exports = { CATEGORIAS_SAIDA, listaParaPrompt, validarCategoria };
