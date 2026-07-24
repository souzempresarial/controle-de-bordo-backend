const express    = require('express');
const router     = express.Router({ mergeParams: true });
const controller = require('../controllers/upgradeController');

router.get('/',                   controller.listar);
router.post('/',                  controller.criar);
router.put('/:aparelhoId',        controller.editar);
router.delete('/:aparelhoId',     controller.excluir);
router.post('/:aparelhoId/vender', controller.vender);

module.exports = router;