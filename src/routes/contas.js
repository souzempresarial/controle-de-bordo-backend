const express    = require('express');
const router     = express.Router({ mergeParams: true });
const controller = require('../controllers/contasController');

router.get('/',           controller.listar);
router.post('/',          controller.criar);
router.delete('/bulk',    controller.excluirEmMassa);
router.put('/:id',        controller.editar);
router.delete('/:id',     controller.excluir);

module.exports = router;
