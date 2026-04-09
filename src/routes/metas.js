const express    = require('express');
const router     = express.Router({ mergeParams: true });
const controller = require('../controllers/metasController');

router.get('/',  controller.listar);
router.post('/', controller.salvar);

module.exports = router;
