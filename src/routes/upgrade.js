const express            = require('express');
const router             = express.Router({ mergeParams: true });
const controller         = require('../controllers/upgradeController');
const verificarPermissao = require('../middleware/verificarPermissao');

const podeUpgrade = verificarPermissao('upgrade');

router.get('/',                    podeUpgrade, controller.listar);
router.post('/',                   podeUpgrade, controller.criar);
router.delete('/',                 podeUpgrade, controller.limpar);
router.put('/:aparelhoId',         podeUpgrade, controller.editar);
router.delete('/:aparelhoId',      podeUpgrade, controller.excluir);
router.post('/:aparelhoId/vender', podeUpgrade, controller.vender);

module.exports = router;
