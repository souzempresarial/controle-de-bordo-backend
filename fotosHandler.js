require('dotenv').config();
const { atualizarFotos } = require('./src/services/fotoLoja');

module.exports.fotos = async () => {
  try {
    const resultado = await atualizarFotos();
    console.log('[Fotos] Concluído:', JSON.stringify(resultado));
    return { statusCode: 200, body: JSON.stringify(resultado) };
  } catch (err) {
    console.error('[Fotos] Erro:', err);
    return { statusCode: 500, body: JSON.stringify({ erro: 'Erro interno ao atualizar as fotos das lojas' }) };
  }
};
