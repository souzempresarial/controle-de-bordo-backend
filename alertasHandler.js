require('dotenv').config();
const { executarAlertas } = require('./src/services/alertasService');

module.exports.alertas = async (event) => {
  try {
    const resultado = await executarAlertas();
    return { statusCode: 200, body: JSON.stringify(resultado) };
  } catch (err) {
    console.error('[Alertas] Erro:', err.message);
    return { statusCode: 500, body: JSON.stringify({ erro: err.message }) };
  }
};