const express    = require('express');
const router     = express.Router();
const autenticar = require('../middleware/autenticar');
const controller = require('../controllers/adminController');

router.get('/ranking', autenticar, (req, res, next) => {
  if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  next();
}, controller.ranking);

module.exports = router;