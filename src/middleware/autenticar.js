const jwt  = require('jsonwebtoken');
const pool = require('../models/db');

module.exports = async function autenticar(req, res, next) {
  const token = req.cookies?.sf_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query('SELECT ativo FROM usuarios WHERE id = $1', [payload.id]);
    if (!rows.length || rows[0].ativo === false) {
      return res.status(403).json({ erro: 'Conta desativada. Entre em contato com o suporte.' });
    }
    req.usuario = payload;
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
};
