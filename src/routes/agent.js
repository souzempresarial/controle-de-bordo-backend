const express    = require('express');
const router     = express.Router({ mergeParams: true });
const controller = require('../controllers/agentController');

router.post('/', controller.chat);

module.exports = router;
