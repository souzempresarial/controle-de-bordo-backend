const express            = require('express');
const multer             = require('multer');
const { processar, salvarRegras } = require('../controllers/extratoController');
const verificarPermissao = require('../middleware/verificarPermissao');

const router  = express.Router({ mergeParams: true });
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const podeExtrato = verificarPermissao('lancamentos');

router.post('/processar', podeExtrato, upload.single('arquivo'), processar);
router.post('/regras',    podeExtrato, salvarRegras);

module.exports = router;
