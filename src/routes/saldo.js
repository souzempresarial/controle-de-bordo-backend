const express            = require('express');
const router             = express.Router({ mergeParams: true });
const controller         = require('../controllers/saldoController');
const verificarPermissao = require('../middleware/verificarPermissao');

const podeSaldo = verificarPermissao('financeiro');

router.get('/',  podeSaldo, controller.buscar);
router.post('/', podeSaldo, controller.salvar);

module.exports = router;
