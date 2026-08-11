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

-- Migração: adicionar coluna valor_upgrade se não existir
ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS valor_upgrade DECIMAL(12,2);
ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS qtd_upgrade INTEGER;

-- Migração: valor_juros por parcela de empréstimo
ALTER TABLE contas ADD COLUMN IF NOT EXISTS valor_juros DECIMAL(12,2);

-- RECURSOS EM CAPITAL
CREATE TABLE IF NOT EXISTS capital (
  id         SERIAL PRIMARY KEY,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  mes_chave  VARCHAR(7) NOT NULL,
  campo      VARCHAR(50) NOT NULL,
  valor      DECIMAL(12,2) NOT NULL DEFAULT 0,
  UNIQUE(cliente_id, mes_chave, campo)
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

-- Verificação de e-mail e edição de perfil
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email_verificado BOOLEAN DEFAULT TRUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_verificacao VARCHAR(100);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_expira_em TIMESTAMP;

-- REGRAS DE CATEGORIZAÇÃO DE EXTRATO (aprendizado por cliente)
CREATE TABLE IF NOT EXISTS regras_extrato (
  id           SERIAL PRIMARY KEY,
  cliente_id   INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  palavra_chave TEXT NOT NULL,
  categoria    TEXT NOT NULL,
  subcategoria TEXT,
  UNIQUE(cliente_id, palavra_chave)
);

-- Migração: reset de senha
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_reset_senha VARCHAR(100);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_reset_expira_em TIMESTAMP;

-- Migração: controle de acesso e plano
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS plano VARCHAR(20) DEFAULT 'trial';

-- CONTROLE DE UPGRADE
CREATE TABLE IF NOT EXISTS aparelhos_upgrade (
  id               SERIAL PRIMARY KEY,
  cliente_id       INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  modelo           VARCHAR(100) NOT NULL,
  cor              VARCHAR(50),
  armazenamento    VARCHAR(20),
  bateria          INTEGER,
  email_aparelho   VARCHAR(255),
  observacoes      TEXT,
  valor_avaliado   DECIMAL(12,2),
  valor_pretendido DECIMAL(12,2),
  status           VARCHAR(20) DEFAULT 'estoque',
  criado_em        TIMESTAMP DEFAULT NOW(),
  vendido_em       TIMESTAMP,
  imei             VARCHAR(20)
);
ALTER TABLE aparelhos_upgrade ADD COLUMN IF NOT EXISTS imei VARCHAR(20);