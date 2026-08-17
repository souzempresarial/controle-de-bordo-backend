const express            = require('express');
const router             = express.Router({ mergeParams: true });
const controller         = require('../controllers/contasController');
const verificarPermissao = require('../middleware/verificarPermissao');

const podeContas = verificarPermissao('contas');

// GET: leitura liberada para qualquer usuário do cliente (autorizar.js garante ownership)
router.get('/', controller.listar);
router.post('/',          podeContas, controller.criar);
router.delete('/bulk',    podeContas, controller.excluirEmMassa);
router.put('/:id',        podeContas, controller.editar);
router.delete('/:id',     podeContas, controller.excluir);

module.exports = router;
