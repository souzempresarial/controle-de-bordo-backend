const express = require('express');
const router  = express.Router({ mergeParams: true });
const ctrl    = require('../controllers/mercadophoneController');
const patrimonio = require('../controllers/patrimonioController');

router.get('/status',            ctrl.status);
router.get('/chaves',            ctrl.listarChaves);
router.post('/chaves',           ctrl.adicionarChave);
router.delete('/chaves/:chaveId', ctrl.removerChave);
router.put('/chave',             ctrl.salvarChave);   // legado
router.post('/preview',          ctrl.preview);
router.post('/importar',         ctrl.importar);
router.post('/os-preview',       ctrl.osPreview);
router.post('/os-importar',      ctrl.osImportar);
router.get('/patrimonio/preview',   patrimonio.preview);
router.post('/patrimonio',          patrimonio.salvar);
router.get('/patrimonio/:mesChave', patrimonio.resumo);

module.exports = router;
