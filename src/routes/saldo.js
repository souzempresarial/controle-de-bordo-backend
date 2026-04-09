const express    = require('express');
const router     = express.Router({ mergeParams: true });
const controller = require('../controllers/saldoController');

router.get('/',  controller.buscar);
router.post('/', controller.salvar);

module.exports = router;
