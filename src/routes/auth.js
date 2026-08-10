const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/authController');
const autenticar = require('../middleware/autenticar');

// Públicas
router.post('/login',                controller.login);
router.post('/logout',               controller.logout);
router.post('/registro',             controller.registrarPublico);
router.get('/verificar/:token',      controller.verificarEmail);
router.post('/reenviar-verificacao', controller.reenviarVerificacao);
router.post('/esqueci-senha',        controller.esqueceuSenha);
router.post('/redefinir-senha-token', controller.redefinirSenhaPorToken);
router.post('/registrar-admin',      controller.registrarAdmin);

// Perfil do próprio usuário
router.get('/me',             autenticar, controller.minhaInfo);
router.put('/perfil',         autenticar, controller.editarPerfil);
router.put('/senha',          autenticar, controller.alterarSenha);
router.post('/token-extrato', autenticar, controller.tokenExtrato);

// Admin
router.get('/log-acessos',            autenticar, controller.listarLogAcessos);
router.post('/usuarios',              autenticar, controller.criarUsuario);
router.get('/usuarios',               autenticar, controller.listarUsuarios);
router.delete('/usuarios/:id',        autenticar, controller.excluirUsuario);
router.put('/usuarios/:id/senha',     autenticar, controller.redefinirSenha);
router.patch('/usuarios/:id/ativo',   autenticar, controller.toggleAtivo);
router.put('/usuarios/:id/plano',     autenticar, controller.atualizarPlano);
router.put('/usuarios/:id/email',     autenticar, controller.atualizarEmail);

module.exports = router;