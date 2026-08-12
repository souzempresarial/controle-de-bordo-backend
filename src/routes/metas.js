const express            = require('express');
const router             = express.Router({ mergeParams: true });
const controller         = require('../controllers/metasController');
const verificarPermissao = require('../middleware/verificarPermissao');

const podeMetas = verificarPermissao('dashboard', 'financeiro');

router.get('/',  podeMetas, controller.listar);
router.post('/', podeMetas, controller.salvar);

module.exports = router;
