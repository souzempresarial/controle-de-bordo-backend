const express            = require('express');
const router             = express.Router({ mergeParams: true });
const ctrl               = require('../controllers/fechamentoController');
const verificarPermissao = require('../middleware/verificarPermissao');

const podeFechamento = verificarPermissao('financeiro');

router.post('/contas',             podeFechamento, ctrl.criarConta);
router.patch('/contas/:contaId',   podeFechamento, ctrl.editarConta);
router.get('/:mesChave',           podeFechamento, ctrl.buscar);
router.put('/:mesChave/saldos',    podeFechamento, ctrl.salvarSaldo);
router.post('/:mesChave/fechar',   podeFechamento, ctrl.fechar);
router.post('/:mesChave/reabrir',  podeFechamento, ctrl.reabrir);

module.exports = router;
