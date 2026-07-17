const express  = require('express');
const multer   = require('multer');
const { processar, salvarRegras } = require('../controllers/extratoController');

const router  = express.Router({ mergeParams: true });
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.post('/processar', upload.single('arquivo'), processar);
router.post('/regras',    salvarRegras);

module.exports = router;