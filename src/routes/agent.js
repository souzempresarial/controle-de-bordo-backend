const express    = require('express');
const router     = express.Router({ mergeParams: true });
const controller = require('../controllers/agentController');

router.post('/', controller.chat);
router.get('/historico', controller.historico);
router.get('/resumo-semana', controller.resumoSemana);
router.delete('/historico', controller.limpar);
router.post('/transcrever', controller.transcrever);
router.post('/falar', controller.falar);

module.exports = router;
