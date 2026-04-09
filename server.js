require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Teste
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Controle de Bordo API' });
});

// Rotas
app.use('/clientes', require('./src/routes/clientes'));
app.use('/clientes/:clienteId/lancamentos', require('./src/routes/lancamentos'));
app.use('/clientes/:clienteId/contas',      require('./src/routes/contas'));
app.use('/clientes/:clienteId/metas',       require('./src/routes/metas'));
app.use('/clientes/:clienteId/saldo/:ano',  require('./src/routes/saldo'));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
