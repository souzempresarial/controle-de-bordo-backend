const express = require('express');
const router  = express.Router({ mergeParams: true });
const ctrl    = require('../controllers/mercadophoneController');
const patrimonio = require('../controllers/patrimonioController');
const verificarPermissao = require('../middleware/verificarPermissao');

// Cada rota exige a permissão da tela que a usa (só restringe funcionário)
const conciliacoes = verificarPermissao('lancamentos');
const integracoes  = verificarPermissao('integracoes');
const financeiro   = verificarPermissao('financeiro');

router.get('/status',            verificarPermissao('lancamentos', 'financeiro', 'integracoes'), ctrl.status);
router.get('/chaves',            integracoes, ctrl.listarChaves);
router.post('/chaves',           integracoes, ctrl.adicionarChave);
router.patch('/chaves/:chaveId',  integracoes, ctrl.configurarChave);
router.delete('/chaves/:chaveId', integracoes, ctrl.removerChave);
router.put('/chave',             integracoes, ctrl.salvarChave);   // legado
router.post('/preview',          conciliacoes, ctrl.preview);
router.post('/importar',         conciliacoes, ctrl.importar);
router.post('/conferir',          conciliacoes, ctrl.conferir);
router.post('/conferir/aplicar',  conciliacoes, ctrl.aplicarConciliacao);
router.post('/conferir/desfazer', conciliacoes, ctrl.desfazerConciliacao);
router.post('/os-preview',       conciliacoes, ctrl.osPreview);
router.post('/os-importar',      conciliacoes, ctrl.osImportar);
router.get('/patrimonio/preview',   financeiro, patrimonio.preview);
router.post('/patrimonio',          financeiro, patrimonio.salvar);
router.get('/patrimonio/:mesChave', financeiro, patrimonio.resumo);

module.exports = router;
