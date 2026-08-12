const express            = require('express');
const router             = express.Router();
const verificarPermissao = require('../middleware/verificarPermissao');
const controller         = require('../controllers/clientesController');

router.get('/',       verificarPermissao('clientes'), controller.listar);
router.get('/:id',    verificarPermissao('clientes'), controller.buscar);
router.post('/',      controller.criar);
router.put('/:id',    controller.editar);
router.delete('/:id', controller.excluir);

module.exports = router;
