# SOUZ AI — documentação de contexto do agente

Estado do código em 08/10/2026. Gerado a partir do código-fonte; se mudar o código, atualize este arquivo.

## Visão geral

A SOUZ AI é o assistente financeiro da Souz Finance. Ela recebe uma mensagem em linguagem natural (texto ou áudio), descobre a **intenção** e executa uma das **tools**. A IA não acessa o banco: ela só devolve um JSON dizendo o que fazer, e o backend executa.

```
Mensagem (dashboard, bolinha ou WhatsApp)
  → [áudio?] transcrição (Gemini)                         services/audio.js
  → histórico do Redis (chat:{clienteId}, 30 mensagens)
  → 1ª chamada à IA: classifica a intenção, devolve JSON   prompts/agentPrompt.js
  → backend executa a tool                                services/agentService.js
       criar_entrada / criar_saida  → INSERT em lancamentos
       consultar_entrada / _saida   → SELECT em lancamentos
       consultar_analytics          → DRE calculado na hora + 2ª chamada à IA
       outro                        → devolve o texto da IA
  → resposta salva no histórico do Redis
```

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/prompts/agentPrompt.js` | Prompt do sistema: persona, tools, formato JSON, categorias, palavras-chave |
| `src/services/agentService.js` | Orquestração: chamada à IA, parser, execução das tools |
| `src/services/analyticsService.js` | `responderComContexto`: 2ª chamada à IA para análises e conselhos |
| `src/services/dre.js` | DRE mensal no backend. **Cópia** de `controle-de-bordo-react/src/services/dre.js`; as duas precisam ficar iguais |
| `src/services/audio.js` | Transcrição de áudio (ditado da plataforma e WhatsApp) |
| `src/controllers/agentController.js` | Rotas do chat: enviar, histórico, limpar, transcrever |
| `src/whatsapp/webhookController.js` | Entrada do WhatsApp (Evolution API) |
| `src/services/redis.js` | Cliente Upstash Redis (memória da conversa) |
| Frontend: `src/context/ChatContext.jsx` | Conversa compartilhada entre a tela SOUZ AI e a bolinha |
| Frontend: `src/pages/Chat.jsx`, `src/components/ChatWidget.jsx`, `src/components/BotaoMicrofone.jsx` | Interfaces |

## Modelos e limites

| Etapa | Modelo | Limite |
|---|---|---|
| Classificar a intenção (1ª chamada) | `gemini-3.6-flash`, temperatura 0.2 | 15 s; nova tentativa se o Gemini responder 503 |
| Reserva da 1ª chamada | DeepSeek (`deepseek-chat`) | **Sem saldo hoje**, então na prática não há reserva |
| Análise / conselhos (2ª chamada) | `gemini-3.6-flash` sem raciocínio extra (`thinkingBudget: 0`) | 18 s; nova tentativa em 503 |
| Transcrição de áudio | `gemini-3.6-flash` | 1 minuto de áudio no ditado |

**Limite principal:** o API Gateway da AWS corta qualquer requisição em **29 s**. Uma pergunta de análise faz duas chamadas à IA e hoje leva de 8 a 20 s. Qualquer etapa nova no caminho do chat precisa caber nesse tempo.

## Formato que a IA devolve

Sempre JSON, sem markdown:

```json
{ "intent_type": "...", "body": "texto para o usuário", "data": { ... } }
```

Se a resposta não for JSON válido, o parser tenta extrair o primeiro `{...}`. Se falhar, responde "Não entendi, pode reformular?".

## Tools

### 1. `criar_entrada` e `criar_saida` — registrar lançamento

Quando usar: o usuário informa uma venda, recebimento, pagamento ou despesa.

| Campo de `data` | Tipo | Obrigatório | Observação |
|---|---|---|---|
| `valor` | número | **sim** | Aceita "R$ 1.800,00"; o backend normaliza. Sem valor, nada é gravado e a IA pergunta o valor. |
| `descricao` | texto | não | |
| `metodo` | Pix, Crédito, Débito, Dinheiro, Boleto, Transferência | não | Vai para `lancamentos.pagamento` |
| `data` | `YYYY-MM-DD`, "hoje", "ontem", `DD/MM` | não | Sem data, usa hoje |
| `categoria`, `subcategoria` | texto | não | Devem ser nomes exatos da lista do prompt |

O que o backend faz: `INSERT INTO lancamentos` com `status = 'Confirmado'` e `origem = 'ia'`. A resposta traz `acao: 'Entrada' | 'Saída'`, e o frontend recarrega os lançamentos.

Exemplos:
- "Vendi um iPhone 15 por R$ 3.800 no Pix" → `criar_entrada`, Aparelhos > iPhone, 3800, Pix
- "Abasteci o carro da loja, deu 180 conto" → `criar_saida`, Despesas Variáveis > Veículo, 180
- "Paguei o motoboy" → `criar_saida` sem valor → a IA pergunta o valor e nada é gravado

### 2. `consultar_entrada` e `consultar_saida` — listar ou somar transações

Quando usar: ver ou listar transações, somar uma subcategoria ou item (gasolina, comissão, iPhone, um fornecedor), ou períodos curtos (hoje, ontem, semana).
Não usar para totais do negócio no mês (faturamento, lucro, CMV); para isso existe a tool 3.

| Campo de `data` | Observação |
|---|---|
| `start_date`, `end_date` | `YYYY-MM-DD`. A IA calcula a partir da data de hoje que vai no prompt. |
| `periodo` | Texto exibido na resposta ("setembro de 2026") |
| `categoria` | Filtro exato (ILIKE) |
| `subcategoria` | Filtro aproximado: procura o termo na subcategoria **ou** na descrição |

O que o backend faz: ignora CMV (`is_cmv`) e lançamentos cancelados. Lista os 8 mais recentes e mostra a quantidade e o **total do período inteiro**. O total vem de uma soma sem limite; antes de 08/10 somava só os 100 primeiros, o que estava errado.

### 3. `consultar_analytics` — DRE, análises e conselhos

Quando usar: qualquer total do negócio no mês (faturamento, receita, lucro, prejuízo, margem, CMV, total de um grupo de despesa, resultado), comparações entre meses, tendências, projeções, "como foi setembro?" e pedidos de conselho.

| Campo de `data` | Observação |
|---|---|
| `pergunta` | A pergunta reescrita de forma completa pela IA |

O que o backend faz:
1. `dreMensal(clienteId, desde)` calcula, na hora, o DRE de cada mês dos **últimos 12 meses** com a **mesma conta da tela Financeiro**: Receita Bruta por linha, deduções, CMV, Lucro Bruto, custos variáveis, despesas por grupo, EBITDA, resultado financeiro e Lucro Líquido (descontando depreciação e IRPJ lançados à mão na tabela `metas`). Também calcula o caixa do mês (o que entrou e saiu).
2. O mês atual é marcado como **parcial**.
3. A 2ª chamada à IA recebe esse texto e responde. As regras desse prompt: usar só esses números; faturamento é a Receita Bruta; resultado é o Lucro Líquido; caixa não é lucro; conselhos devem trazer de 2 a 4 ações ligadas a números.

Validação (08/10/2026): 42 perguntas sobre setembro em 7 clientes (faturamento, lucro líquido, margem bruta, pessoal, CMV, fornecedores); as 42 trouxeram o número igual ao da tela Financeiro.

> Os resumos mensais da tabela `analytics_embeddings` (cron do dia 1º, com busca por similaridade) **não são mais usados pelo chat**. Eles ficavam desatualizados e usavam uma conta de caixa, não a do DRE. O cron continua rodando.

### 4. `outro` — conversa geral

Saudações, dúvidas sobre o sistema e perguntas que não envolvem dados. O backend devolve o `body` da IA.

## Canais e o parâmetro `source`

| `source` | Entrada | Diferença |
|---|---|---|
| `dashboard` | `POST /clientes/:clienteId/chat` (tela SOUZ AI e bolinha) | A resposta pode usar **negrito** e listas; o frontend formata |
| `whatsapp` | `POST /whatsapp/webhook` (Evolution API) | O prompt pede texto simples, sem markdown, com no máximo 3 frases (6 linhas em análises) |

**WhatsApp:** o número do remetente (`remoteJid`) identifica o usuário pela coluna `usuarios.telefone`, e daí o cliente. Áudio é transcrito e segue o mesmo caminho do texto. Mensagens de grupo e as enviadas pela própria conta são ignoradas. **Ainda não funciona em produção**: falta subir o servidor da Evolution API e preencher `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` e `EVOLUTION_INSTANCE`.

## Memória (histórico)

- Redis (Upstash), chave `chat:{clienteId}`, guarda as **últimas 30 mensagens** por **7 dias**.
- A memória é **por cliente**, não por usuário. Dashboard e WhatsApp compartilham a mesma conversa, e cada mensagem grava o `source`.
- As respostas antigas da IA voltam para o modelo como JSON `outro`, para ele manter o formato.
- `GET /clientes/:id/chat/historico` devolve a conversa; `DELETE` apaga (botão "Nova conversa").

## Rotas

| Método e rota | O que faz |
|---|---|
| `POST /clientes/:id/chat` | Envia uma mensagem `{ mensagem, clienteNome, usuarioNome }` e recebe `{ resposta, acao, lancamento? }` |
| `GET /clientes/:id/chat/historico` | `{ mensagens: [{ role, content, source }] }` |
| `DELETE /clientes/:id/chat/historico` | Limpa a conversa |
| `POST /clientes/:id/chat/transcrever` | `{ audio: base64, mimeType }` → `{ texto }`. Até cerca de 6 MB |
| `POST /whatsapp/webhook` | Evento `messages.upsert` da Evolution API. Responde 200 na hora e processa depois |

Todas as rotas `/clientes/:id/...` exigem login e permissão para aquele cliente.

## Categorias

A lista oficial fica no frontend (`src/services/constants.js`) e foi copiada para o prompt (`agentPrompt.js`) e para `src/services/categorias.js` (usado pelo extrato). **Ao mudar uma categoria, é preciso mudar nos três lugares.**

## Problemas conhecidos (não corrigidos)

1. **Upgrade pelo chat:** o exemplo do prompt cita `valorUpgrade`, mas `criarLancamento` não grava `valor_upgrade`. Uma venda com aparelho de entrada registrada pelo chat entra com o valor cheio no caixa.
2. **Venda pelo chat sem CMV:** `criar_entrada` não cria o lançamento de custo ligado à venda. O lucro dessa venda aparece inflado no DRE até alguém lançar o custo.
3. **Compra para revenda vai para o CMV:** o prompt manda "Comprei iPhone para revenda" para Custos Variáveis Diretos. No resto do sistema, compra de estoque é Fornecedores (Estoque) e o CMV nasce na venda. Isso pode contar o custo duas vezes.
4. **Categoria sem validação no chat:** a categoria da IA é gravada como veio. No extrato, ela já é validada contra a lista oficial (`validarCategoria`).
5. **Fuso horário:** `hojeISO()` e "ontem" usam o horário do servidor (UTC). Entre 21h e meia-noite de Brasília, "hoje" vira o dia seguinte.
6. **Sem reserva de IA:** a chave do DeepSeek está sem saldo. Se o Gemini cair, o chat responde "Assistente indisponível".
7. **Categorias copiadas em 3 lugares** (veja acima): risco de ficarem diferentes.

## Como testar sem gravar nada

Rode `processarMensagem` localmente bloqueando escritas no banco (sobrescrevendo `pool.query` para rejeitar `INSERT/UPDATE/DELETE`). Foi assim que a bateria de 42 perguntas de 08/10 foi feita. Compare cada número com `dreMensal` do mesmo cliente e mês.
