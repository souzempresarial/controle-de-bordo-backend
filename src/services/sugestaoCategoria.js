const pool = require('../models/db');
const { validarCategoria } = require('./categorias');

// Palavras que descrevem o tipo de transação, não quem recebeu — removidas para "qr code pix enviado - fulano 123" virar "fulano"
const RUIDO = new Set([
  'pix','qr','code','qrcode','enviado','enviada','enviados','recebido','recebida','transferencia','transf','trans',
  'ted','doc','tev','pelo','pela','para','compra','compras','no','na','nos','debito','credito','pagamento','pagto','pgto',
  'pag','efetuado','efetuada','automatico','aut','boleto','cartao','de','da','do','dos','das','e','em','a','o',
  'ltda','me','sa','eireli','epp','cnpj','cpf','conta','cc','ag','agencia','banco','valor','ref','referente','via',
]);

const MIN_CHAVE         = 6;   // chaves menores só valem com descrição idêntica
const MIN_CONTIDA       = 8;   // para casar "chave dentro da descrição"
const CONFIANCA_MINIMA  = 0.6; // mesma descrição com categorias diferentes no histórico → deixa para a IA
const PESO_REGRA        = 3;   // regra é uma correção explícita do analista

function normalizarDescricao(descricao) {
  return (descricao || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !RUIDO.has(t) && !/^\d+$/.test(t))
    .join(' ');
}

async function montarIndice(clienteId) {
  const [hist, regras] = await Promise.all([
    pool.query(
      `SELECT descricao, categoria, subcategoria FROM lancamentos
       WHERE cliente_id = $1 AND tipo = 'Saída' AND NOT COALESCE(is_cmv, false)
         AND categoria IS NOT NULL AND categoria <> '' AND descricao IS NOT NULL
         AND data >= CURRENT_DATE - 365
         AND (obs IS NULL OR obs NOT LIKE '[MP-%')
       ORDER BY data DESC LIMIT 4000`,
      [clienteId]
    ),
    pool.query('SELECT palavra_chave, categoria, subcategoria FROM regras_extrato WHERE cliente_id = $1', [clienteId]),
  ]);

  const indice = new Map(); // chave → Map("cat|sub" → peso)
  const somar = (texto, categoria, subcategoria, peso) => {
    const v = validarCategoria(categoria, subcategoria);
    const chave = normalizarDescricao(texto);
    if (!v.categoria || chave.length < 3) return;
    if (!indice.has(chave)) indice.set(chave, new Map());
    const alvo = `${v.categoria}|${v.subcategoria}`;
    const contagem = indice.get(chave);
    contagem.set(alvo, (contagem.get(alvo) || 0) + peso);
  };
  hist.rows.forEach(r => somar(r.descricao, r.categoria, r.subcategoria, 1));
  regras.rows.forEach(r => somar(r.palavra_chave, r.categoria, r.subcategoria, PESO_REGRA));
  return indice;
}

function sugerir(descricao, indice) {
  const desc = normalizarDescricao(descricao);
  if (!desc) return null;

  const votos = new Map();
  const juntar = contagem => contagem.forEach((p, alvo) => votos.set(alvo, (votos.get(alvo) || 0) + p));

  if (indice.has(desc)) juntar(indice.get(desc));
  else {
    // Só casa por trecho com 2+ palavras, para um sobrenome solto não puxar a categoria de outra pessoa
    const duasPalavras = s => s.includes(' ');
    const contem = (maior, menor) => menor.length >= MIN_CONTIDA && duasPalavras(menor) && ` ${maior} `.includes(` ${menor} `);
    for (const [chave, contagem] of indice) {
      if (chave.length < MIN_CHAVE) continue;
      if (contem(desc, chave) || contem(chave, desc)) juntar(contagem);
    }
  }
  if (!votos.size) return null;

  const total = [...votos.values()].reduce((a, b) => a + b, 0);
  const [alvo, peso] = [...votos].sort((a, b) => b[1] - a[1])[0];
  if (peso / total < CONFIANCA_MINIMA) return null;
  const [categoria, subcategoria] = alvo.split('|');
  return { categoria, subcategoria, vezes: peso };
}

// Exemplos reais do cliente para a IA, os mais frequentes primeiro
function exemplosParaPrompt(indice, limite = 80) {
  return [...indice]
    .filter(([chave]) => chave.length >= MIN_CHAVE)
    .map(([chave, contagem]) => {
      const [alvo, peso] = [...contagem].sort((a, b) => b[1] - a[1])[0];
      return { chave, alvo, peso };
    })
    .sort((a, b) => b.peso - a.peso)
    .slice(0, limite)
    .map(({ chave, alvo }) => {
      const [cat, sub] = alvo.split('|');
      return `"${chave}" → ${cat}${sub ? ' > ' + sub : ''}`;
    })
    .join('\n');
}

module.exports = { normalizarDescricao, montarIndice, sugerir, exemplosParaPrompt };
