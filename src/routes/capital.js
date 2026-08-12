const express            = require('express');
const router             = express.Router({ mergeParams: true });
const { buscar, salvar } = require('../controllers/capitalController');
const verificarPermissao = require('../middleware/verificarPermissao');

const podeCapital = verificarPermissao('relatorio');

router.get('/',  podeCapital, buscar);
router.post('/', podeCapital, salvar);

module.exports = router;
