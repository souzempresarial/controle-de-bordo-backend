const express             = require('express');
const router              = express.Router({ mergeParams: true });
const controller          = require('../controllers/lancamentosController');
const verificarPermissao  = require('../middleware/verificarPermissao');

// GET: vários dashboards precisam ler lançamentos — libera quem tem pelo menos uma dessas páginas
router.get('/',       verificarPermissao('lancamentos', 'dashboard', 'relatorio', 'financeiro', 'exportar'), controller.listar);

// Escritas: exigem permissão explícita de lançamentos
router.post('/',      verificarPermissao('lancamentos'), controller.criar);
router.delete('/',    verificarPermissao('lancamentos'), controller.limpar);
router.put('/:id',    verificarPermissao('lancamentos'), controller.editar);
router.delete('/:id', verificarPermissao('lancamentos'), controller.excluir);

module.exports = router;
