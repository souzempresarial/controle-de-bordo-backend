const express    = require('express');
const router     = express.Router();
const autenticar = require('../middleware/autenticar');
const controller = require('../controllers/adminController');

router.get('/ranking', autenticar, controller.ranking);

module.exports = router;