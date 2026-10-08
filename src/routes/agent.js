const express    = require('express');
const router     = express.Router({ mergeParams: true });
const controller = require('../controllers/agentController');

router.post('/', controller.chat);
router.get('/historico', controller.historico);
router.delete('/historico', controller.limpar);

module.exports = router;
