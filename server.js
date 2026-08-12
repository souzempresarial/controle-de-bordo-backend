require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const fs           = require('fs');
const path         = require('path');
const pool         = require('./src/models/db');
const autenticar   = require('./src/middleware/autenticar');
const autorizar    = require('./src/middleware/autorizar');

const app  = express();
const PORT = process.env.PORT || 3000;

// Criar tabelas automaticamente na inicialização
const sql = fs.readFileSync(path.join(__dirname, 'src/models/schema.sql'), 'utf8');
pool.query(sql).then(() => console.log('Tabelas verificadas')).catch(err => console.error('Erro na migration:', err.message));

const defaultOrigins = 'http://localhost:5173,http://localhost:5174';
const allowedOrigins = (process.env.CORS_ORIGIN || defaultOrigins).split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS bloqueado'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Controle de Bordo API' }));

// Rotas públicas
app.use('/auth',  require('./src/routes/auth'));
app.use('/admin', require('./src/routes/admin'));

// Rotas protegidas
app.use('/clientes',                              autenticar, require('./src/routes/clientes'));
app.use('/clientes/:clienteId/lancamentos',       autenticar, autorizar, require('./src/routes/lancamentos'));
app.use('/clientes/:clienteId/contas',            autenticar, autorizar, require('./src/routes/contas'));
app.use('/clientes/:clienteId/metas',             autenticar, autorizar, require('./src/routes/metas'));
app.use('/clientes/:clienteId/saldo/:ano',        autenticar, autorizar, require('./src/routes/saldo'));
app.use('/clientes/:clienteId/capital/:mesChave', autenticar, autorizar, require('./src/routes/capital'));
app.use('/clientes/:clienteId/extrato',           autenticar, autorizar, require('./src/routes/extrato'));
app.use('/clientes/:clienteId/upgrade',           autenticar, autorizar, require('./src/routes/upgrade'));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}

module.exports = app;
