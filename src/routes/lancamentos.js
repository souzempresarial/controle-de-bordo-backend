const express             = require('express');
const router              = express.Router({ mergeParams: true });
const controller          = require('../controllers/lancamentosController');
const verificarPermissao  = require('../middleware/verificarPermissao');

// GET: leitura liberada para qualquer usuário do cliente (autorizar.js garante ownership)
router.get('/', controller.listar);

// Escritas: exigem permissão explícita de lançamentos
router.post('/',      verificarPermissao('lancamentos'), controller.criar);
router.delete('/',    verificarPermissao('lancamentos'), controller.limpar);
router.put('/:id',    verificarPermissao('lancamentos'), controller.editar);
router.delete('/:id', verificarPermissao('lancamentos'), controller.excluir);

module.exports = router;
