const express            = require('express');
const router             = express.Router();
const verificarPermissao = require('../middleware/verificarPermissao');
const controller         = require('../controllers/clientesController');

const soAdmin = (req, res, next) =>
  req.usuario?.papel === 'admin' ? next() : res.status(403).json({ erro: 'Acesso negado' });

router.get('/',       verificarPermissao('clientes'), controller.listar);
router.get('/:id',    verificarPermissao('clientes'), controller.buscar);
router.post('/',      soAdmin, controller.criar);
router.put('/:id',    soAdmin, controller.editar);
router.delete('/:id', soAdmin, controller.excluir);

module.exports = router;
