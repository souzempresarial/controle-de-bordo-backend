const express = require('express');
const router  = express.Router({ mergeParams: true });
const ctrl    = require('../controllers/mercadophoneController');

router.get('/status',    ctrl.status);
router.put('/chave',     ctrl.salvarChave);
router.post('/preview',  ctrl.preview);
router.post('/importar', ctrl.importar);

module.exports = router;
