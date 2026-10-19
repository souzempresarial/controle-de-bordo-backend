#!/bin/bash
# Servidor do WhatsApp da SOUZ (Evolution API v2) — script de primeira inicialização (Lightsail/EC2, Ubuntu 24.04).
# Sobe: Evolution + Postgres + Redis (só para a Evolution) + Caddy com HTTPS automático em <ip>.sslip.io.
# A chave fica em EVOLUTION_API_KEY do .env do backend; troque __API_KEY__ por ela antes de usar (não commitar a chave).
set -euo pipefail

API_KEY="__API_KEY__"
BASE=/opt/evolution

apt-get update -y
apt-get install -y ca-certificates curl openssl
curl -fsSL https://get.docker.com | sh

mkdir -p "$BASE" && cd "$BASE"

# Senha do Postgres gerada uma vez, só existe neste servidor
[ -f secrets.env ] || printf 'PG_PASS=%s\nAPI_KEY=%s\n' "$(openssl rand -hex 16)" "$API_KEY" > secrets.env
chmod 600 secrets.env

cat > Caddyfile <<'CADDY'
{$DOMAIN} {
  reverse_proxy evolution:8080
}
CADDY

cat > docker-compose.yml <<'YML'
services:
  evolution:
    image: evoapicloud/evolution-api:v2.3.7
    restart: always
    depends_on: [postgres, redis]
    environment:
      SERVER_TYPE: http
      SERVER_PORT: 8080
      SERVER_URL: https://${DOMAIN}
      AUTHENTICATION_API_KEY: ${API_KEY}
      AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: "false"
      DATABASE_ENABLED: "true"
      DATABASE_PROVIDER: postgresql
      DATABASE_CONNECTION_URI: postgresql://evolution:${PG_PASS}@postgres:5432/evolution?schema=public
      DATABASE_CONNECTION_CLIENT_NAME: evolution_souz
      # Guarda só a sessão; mensagens e contatos dos clientes não ficam neste servidor
      DATABASE_SAVE_DATA_INSTANCE: "true"
      DATABASE_SAVE_DATA_NEW_MESSAGE: "false"
      DATABASE_SAVE_MESSAGE_UPDATE: "false"
      DATABASE_SAVE_DATA_CONTACTS: "false"
      DATABASE_SAVE_DATA_CHATS: "false"
      DATABASE_SAVE_DATA_LABELS: "false"
      DATABASE_SAVE_DATA_HISTORIC: "false"
      CACHE_REDIS_ENABLED: "true"
      CACHE_REDIS_URI: redis://redis:6379/6
      CACHE_REDIS_PREFIX_KEY: evolution
      CACHE_LOCAL_ENABLED: "false"
      CONFIG_SESSION_PHONE_CLIENT: SOUZ Finance
      CONFIG_SESSION_PHONE_NAME: Chrome
      WEBHOOK_GLOBAL_ENABLED: "false"
      DEL_INSTANCE: "false"
      QRCODE_LIMIT: 30
      LANGUAGE: pt-BR
      LOG_LEVEL: ERROR,WARN,INFO
    volumes:
      - instances:/evolution/instances
  postgres:
    image: postgres:16-alpine
    restart: always
    environment:
      POSTGRES_USER: evolution
      POSTGRES_PASSWORD: ${PG_PASS}
      POSTGRES_DB: evolution
    volumes:
      - pgdata:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --appendonly yes
    volumes:
      - redisdata:/data
  caddy:
    image: caddy:2
    restart: always
    ports: ["80:80", "443:443"]
    environment:
      DOMAIN: ${DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
volumes:
  instances:
  pgdata:
  redisdata:
  caddy_data:
  caddy_config:
YML

# A cada boot o domínio acompanha o IP público (depois de fixar o IP estático, um reboot ajusta tudo)
cat > start.sh <<'SH'
#!/bin/bash
set -e
cd /opt/evolution
IP=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
{ cat secrets.env; echo "DOMAIN=$(echo "$IP" | tr . -).sslip.io"; } > .env
chmod 600 .env
docker compose up -d
SH
chmod +x start.sh
(crontab -l 2>/dev/null | grep -v evolution/start.sh; echo "@reboot sleep 20 && /opt/evolution/start.sh >> /var/log/evolution-start.log 2>&1") | crontab -

./start.sh
