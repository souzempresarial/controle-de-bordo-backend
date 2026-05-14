-- CLIENTES
CREATE TABLE IF NOT EXISTS clientes (
  id        SERIAL PRIMARY KEY,
  nome      VARCHAR(100) NOT NULL,
  cor       VARCHAR(20),
  obs       TEXT,
  criado_em TIMESTAMP DEFAULT NOW()
);

-- LANÇAMENTOS
CREATE TABLE IF NOT EXISTS lancamentos (
  id             SERIAL PRIMARY KEY,
  cliente_id     INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  tipo           VARCHAR(20) NOT NULL,
  valor          DECIMAL(12,2) NOT NULL,
  data           DATE NOT NULL,
  categoria      VARCHAR(100),
  subcategoria   VARCHAR(100),
  descricao      TEXT,
  pagamento      VARCHAR(50),
  status         VARCHAR(20) DEFAULT 'Confirmado',
  quantidade     INTEGER,
  is_cmv         BOOLEAN DEFAULT FALSE,
  grupo_id       VARCHAR(50),
  valor_recebido DECIMAL(12,2),
  origem         VARCHAR(20),
  obs            TEXT,
  criado_em      TIMESTAMP DEFAULT NOW()
);

-- CONTAS A PAGAR / RECEBER
CREATE TABLE IF NOT EXISTS contas (
  id            SERIAL PRIMARY KEY,
  cliente_id    INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  tipo          VARCHAR(20) NOT NULL,
  descricao     TEXT,
  valor         DECIMAL(12,2) NOT NULL,
  vencimento    DATE,
  categoria     VARCHAR(100),
  subcategoria  VARCHAR(100),
  status        VARCHAR(20) DEFAULT 'pendente',
  recorrente    BOOLEAN DEFAULT FALSE,
  periodicidade VARCHAR(20),
  criado_em     TIMESTAMP DEFAULT NOW()
);

-- METAS MENSAIS
CREATE TABLE IF NOT EXISTS metas (
  id         SERIAL PRIMARY KEY,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  mes_chave  VARCHAR(7) NOT NULL,
  campo      VARCHAR(50) NOT NULL,
  valor      DECIMAL(12,2) NOT NULL,
  UNIQUE(cliente_id, mes_chave, campo)
);

-- USUÁRIOS (autenticação)
CREATE TABLE IF NOT EXISTS usuarios (
  id          SERIAL PRIMARY KEY,
  email       VARCHAR(255) UNIQUE NOT NULL,
  senha_hash  VARCHAR(255) NOT NULL,
  papel       VARCHAR(20) NOT NULL DEFAULT 'cliente',
  cliente_id  INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  nome        VARCHAR(100),
  criado_em   TIMESTAMP DEFAULT NOW()
);

-- SALDO INICIAL DFC
CREATE TABLE IF NOT EXISTS saldo_inicial (
  id         SERIAL PRIMARY KEY,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  ano        VARCHAR(4) NOT NULL,
  valor      DECIMAL(12,2) NOT NULL,
  mes        INTEGER NOT NULL,
  UNIQUE(cliente_id, ano)
);
