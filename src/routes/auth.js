const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/authController');
const autenticar = require('../middleware/autenticar');

// Públicas
router.post('/login',           controller.login);
router.post('/registrar-admin', controller.registrarAdmin); // só funciona se não houver admin

// Protegidas (admin only)
router.post('/usuarios',        autenticar, controller.criarUsuario);
router.get('/usuarios',         autenticar, controller.listarUsuarios);
router.delete('/usuarios/:id',  autenticar, controller.excluirUsuario);
router.put('/senha',            autenticar, controller.alterarSenha);

module.exports = router;
