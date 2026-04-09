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

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
