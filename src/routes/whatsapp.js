const express    = require('express');
const router     = express.Router();
const controller = require('../whatsapp/webhookController');

router.post('/webhook', controller.webhook);

module.exports = router;
