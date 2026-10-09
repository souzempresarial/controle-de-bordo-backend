# Guia de uso do SOUZ Finance

Base que a SOUZ AI usa para responder dúvidas de "como faço no sistema" (carregado em agentPrompt.js). Escrito a partir das telas reais.
Toda vez que uma tela, botão ou nome de menu mudar, atualizar este arquivo junto.

---

## Menu lateral

Na ordem em que aparece: SOUZ AI · Visão Geral · Conciliações Bancárias · Resumo Executivo · Gestão de Contas · Financeiro · Controle de Upgrade · Exportar · Integrações.

A tela que antes se chamava "Lançamentos" agora se chama **Conciliações Bancárias**. Sempre use o nome novo.

- O botão no topo do menu recolhe a barra e deixa só os ícones; clicando de novo ela volta.
- No topo da tela tem o botão de modo claro / modo escuro.
- Funcionário só vê as telas que o dono liberou. Se alguém perguntar por uma tela que não aparece no menu, é porque não foi liberada para esse acesso: peça para falar com o responsável da loja.

---

## SOUZ AI

Conversa com a assistente. Dá para:
- Lançar entradas e saídas por texto. Ex: "vendi um iPhone 13 por 3.200 no Pix, custo 2.600".
- Consultar lançamentos. Ex: "quanto gastei de aluguel esse mês?".
- Pedir números do mês: faturamento, lucro, margem, despesas. Ex: "qual foi meu lucro líquido de setembro?".
- Ditar em vez de digitar: o botão de microfone ao lado do campo de texto.

A bolinha verde no canto da tela abre a mesma conversa em qualquer página.

---

## Visão Geral

Tela principal do dia a dia: é daqui que normalmente se lança.
- **＋ Novo Lançamento**, logo abaixo dos cards: abre o formulário para lançar uma entrada ou saída (passo a passo em "Lançar uma entrada ou saída").
- Resumo do período escolhido (mês e ano no topo, em "Período"): cards de faturamento, gastos e lucro, comparando com o mês anterior.
- Alerta de contas vencidas ou vencendo, com o link "Ver contas".
- Linhas de Receita: unidades, faturamento, ticket médio e lucro por produto.
- Últimos lançamentos do período, com **✏️** para editar e **🗑** para excluir. "Ver todos →" leva para Conciliações Bancárias.

---

## Lançar uma entrada ou saída

O botão **＋ Novo Lançamento** está em dois lugares, com o mesmo formulário: na **Visão Geral** (abaixo dos cards) e no topo de **Conciliações Bancárias**. Também dá para lançar escrevendo para a SOUZ AI.

1. Clique em **＋ Novo Lançamento**.
2. Escolha o **Tipo** (Entrada, Saída ou Transferência), a **Data** e o **Valor**.
3. Escolha **Categoria** e **Subcategoria**. Preencha Descrição, Banco e Pagamento (Dinheiro, Pix, Crédito, Débito, Boleto, Transferência ou Outro).
4. Em venda de aparelho ou acessório, preencha também o **Custo da Mercadoria Vendida (CMV)**: o sistema mostra receita, CMV, lucro e margem antes de salvar.
5. Se teve taxa de cartão ou desconto, use o campo **Dedução (R$)**.
6. Se o cliente deu um aparelho usado na troca, use **Valor do Upgrade (R$)**.
7. Se é o recebimento de uma venda que já teve o custo lançado antes, marque **CMV já registrado** para não duplicar o custo.
8. Clique em **Adicionar** (na Visão Geral) ou **Salvar Alterações** (em Conciliações Bancárias).
9. Se já existir um lançamento igual, o sistema avisa antes de salvar. Confira; se for mesmo outro lançamento, clique em **Salvar mesmo assim**.

Todo lançamento, feito por qualquer caminho, aparece em **Conciliações Bancárias**.

---

## Conciliações Bancárias

Onde ficam todos os lançamentos (entradas, saídas e transferências), com busca, filtros e importação de extrato.

### Importar extrato do banco
1. Clique em **⬆ Importar Extrato**.
2. Escolha o **Banco** e, se quiser, o **Período**.
3. Envie o arquivo: **PDF ou imagem (print) do extrato**.
4. A IA lê as transações e sugere a categoria de cada uma:
   - **✓ histórico** = mesma categoria que você já usou antes para essa descrição.
   - **IA · confira** = sugestão da IA, vale revisar.
   - Linhas marcadas como **possível duplicata** já parecem estar lançadas.
5. Revise, ajuste o que precisar e confirme a importação.
6. Se uma transação precisa ir para mais de uma categoria, use o botão de **dividir** na linha.

Hoje o extrato aceita PDF e imagem. Planilha (CSV/OFX) ainda não: nesse caso, peça para a equipe SOUZ.

### Buscar vendas do Mercado Phone
Só aparece para quem conectou o Mercado Phone (ver Integrações).
1. Escolha um mês no filtro de meses.
2. Clique em **🔄 Buscar no MP**.
3. Aparecem as vendas e ordens de serviço ainda não lançadas. Confira e importe uma a uma ou use **Importar de uma vez**.
   - Possíveis duplicatas e upgrades sem o valor do aparelho recebido ficam de fora do "de uma vez": abra a linha, informe o valor e importe.

### Editar, dividir e excluir
- **✏️** na linha abre a edição. Dentro dela, **✂️ Dividir** separa um lançamento em várias partes/categorias.
- **🗑** exclui o lançamento.
- **🔍 Filtrar** filtra por tipo, categoria, subcategoria e banco; **🔍 Buscar** procura pelo texto.
- Não ensine a apagar vários lançamentos de uma vez. Se pedirem, oriente a falar com a equipe SOUZ: apagar em massa não tem volta.

---

## Resumo Executivo

Relatório pronto do período escolhido: faturamento, gastos, aparelhos e acessórios vendidos, lucro médio por aparelho, ticket médio, fluxo de caixa e lucro líquido, com a lista de lançamentos do período.
Para baixar em PDF, use a tela Exportar.

---

## Gestão de Contas

Contas a pagar e a receber.
- Abas **Contas a Pagar** e **Contas a Receber**, com totais de vencidas, que vencem em 7 dias e saldo projetado.
- **＋ Nova Conta a Pagar** / **＋ Nova Conta a Receber**: descrição, valor, vencimento, categoria. Marque **Conta recorrente** para contas que se repetem (semanal, mensal ou anual).
- Empréstimo: escolha a categoria **Dívidas / Empréstimos**, informe nº de parcelas, juros (% a.m.) e data da 1ª parcela; o sistema calcula a parcela.
- Na linha da conta:
  - **Quitar**: marca como paga/recebida e já cria o lançamento em Conciliações Bancárias com a data de hoje.
  - **Adiar**: joga o vencimento para o próximo mês.
  - **✏️** edita, **🗑** exclui.

---

## Financeiro

Abas no topo:
- **DRE**: resultado mês a mês (receita, deduções, CMV, lucro bruto, despesas por grupo, EBITDA, lucro líquido e margens). As setas trocam os meses exibidos. Mostra também o Ponto de Equilíbrio.
- **Fluxo de Caixa**: entradas, saídas e saldo de cada mês. Para o saldo bater, informe o **Saldo Inicial** (mês de início e valor em caixa).
- **Balanço Patrimonial**: ativo, passivo, patrimônio líquido e endividamento. **✏️ Editar** para preencher; **⬇ Importar Patrimônio** puxa o estoque do Mercado Phone (aparelhos, acessórios e em manutenção) para o ativo do mês; confira os valores antes de salvar, porque a API do Mercado Phone pode trazer erros.
- **Upgrades**: aparelhos recebidos em troca no período e o valor deles em estoque.
- **Projeção**: projeção de fechamento do mês, meta de faturamento (**✏️ Meta**) e teto de gastos (**✏️ Definir**), com aviso quando o teto é atingido.

---

## Controle de Upgrade

Estoque dos aparelhos usados que entraram como parte do pagamento.
- **+ Novo Aparelho**: modelo, IMEI, data de entrada, armazenamento, cor, saúde da bateria, estado físico, valor avaliado (CMV) e valor de venda pretendido.
- Cada aparelho tem um status pelo tempo parado: **No prazo** (até 6 dias), **Alerta** (7 a 9), **Atenção** (10 a 14) e **Urgente** (15 dias ou mais).
- **Vender**: registra a venda (valor, data, forma de pagamento, dedução). Se nessa venda entrou outro aparelho usado, informe o aparelho recebido.
- Aba **Simulador**: calcula quanto oferecer num upgrade e o valor de venda, a partir das configurações da loja.

---

## Exportar

Escolha **Data Início** e **Data Fim** e:
- **Baixar CSV**: os lançamentos do período em planilha.
- **⬇ Relatório Executivo PDF**: o Resumo Executivo em PDF.

---

## Integrações

- **Mercado Phone**: clique em **+ Adicionar chave**, dê um nome para a unidade (ex: Loja Centro) e cole a **Chave de API**. Dá para ter uma chave por loja/unidade. A chave é gerada dentro do próprio Mercado Phone; se não souber onde, peça ajuda à equipe SOUZ.
- **Bling, NF-e e Open Finance**: em breve, ainda não funcionam.

---

## Quando não souber

Se a pergunta não estiver coberta aqui, não invente botão nem caminho. Responda que não tem certeza e oriente a falar com a equipe SOUZ.
