const express = require('express');
const router  = express.Router({ mergeParams: true });
const ctrl    = require('../controllers/mercadophoneController');

router.get('/status',            ctrl.status);
router.get('/chaves',            ctrl.listarChaves);
router.post('/chaves',           ctrl.adicionarChave);
router.delete('/chaves/:chaveId', ctrl.removerChave);
router.put('/chave',             ctrl.salvarChave);   // legado
router.post('/preview',          ctrl.preview);
router.post('/importar',         ctrl.importar);

module.exports = router;
