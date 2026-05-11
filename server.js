require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const pool       = require('./src/models/db');
const autenticar = require('./src/middleware/autenticar');
const autorizar  = require('./src/middleware/autorizar');

const app  = express();
const PORT = process.env.PORT || 3000;

// Criar tabelas automaticamente na inicialização
const sql = fs.readFileSync(path.join(__dirname, 'src/models/schema.sql'), 'utf8');
pool.query(sql).then(() => console.log('Tabelas verificadas')).catch(err => console.error('Erro na migration:', err.message));

const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS bloqueado'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Controle de Bordo API' }));

// Rotas públicas
app.use('/auth', require('./src/routes/auth'));

// Rotas protegidas
app.use('/clientes',                              autenticar, require('./src/routes/clientes'));
app.use('/clientes/:clienteId/lancamentos',       autenticar, autorizar, require('./src/routes/lancamentos'));
app.use('/clientes/:clienteId/contas',            autenticar, autorizar, require('./src/routes/contas'));
app.use('/clientes/:clienteId/metas',             autenticar, autorizar, require('./src/routes/metas'));
app.use('/clientes/:clienteId/saldo/:ano',        autenticar, autorizar, require('./src/routes/saldo'));

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
