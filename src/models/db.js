const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

// TLS com verificação do certificado do RDS (pacote oficial da AWS em certs/): sem isso a conexão
// aceitaria qualquer servidor no caminho se passando pelo banco
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    ca: fs.readFileSync(path.join(__dirname, '../../certs/rds-global-bundle.pem')),
    rejectUnauthorized: true,
  },
});

module.exports = pool;
