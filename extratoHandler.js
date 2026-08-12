require('dotenv').config();
const serverless         = require('serverless-http');
const express            = require('express');
const multer             = require('multer');
const autenticar         = require('./src/middleware/autenticar');
const autorizar          = require('./src/middleware/autorizar');
const verificarPermissao = require('./src/middleware/verificarPermissao');
const { processar }      = require('./src/controllers/extratoController');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.post(
  '/clientes/:clienteId/extrato/processar',
  autenticar,
  autorizar,
  verificarPermissao('lancamentos'),
  upload.single('arquivo'),
  processar
);

module.exports.handler = serverless(app, {
  binary: ['multipart/form-data', 'application/pdf', 'image/jpeg', 'image/png', 'image/*'],
});