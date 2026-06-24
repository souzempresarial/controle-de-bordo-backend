const express = require('express');
const router  = express.Router({ mergeParams: true });
const { buscar, salvar } = require('../controllers/capitalController');

router.get('/',  buscar);
router.post('/', salvar);

module.exports = router;