# Arquitetura — Distributed Wagering Processor

Registro ADR leve. Documento descreve decisões aprovadas antes da
implementação. Itens não implementados permanecem `PENDENTE`.

## 1. Visão geral e invariantes

Serviço financeiro distribuído, com domínio puro, aplicação orientada a casos
de uso e adaptadores NestJS/MikroORM/PostgreSQL/SQS. HTTP e consumidor SQS
compartilham mesmo use case.

PostgreSQL é fonte de verdade das invariantes:

- saldo nunca negativo;
- toda alteração de saldo tem exatamente um lançamento correspondente;
- ledger não pode ser atualizado nem excluído;
- uma transação produz no máximo um lançamento por wallet;
- uma wallet é única por `(player_id, currency)`;
- uma operação externa é única por `(provider_id, external_transaction_id)`;
- uma `idempotency_key` é única e compara `payload_hash`;
- inbox, alteração financeira e outbox são atômicos na mesma transação;
- eventos podem ser publicados mais de uma vez, mas efeitos de consumidores são
  deduplicados por `eventId`;
- ao fim de cada teste: saldo materializado igual ao saldo reconstruído pelo
  ledger.

Autenticação não pontua no desafio. `ProviderAuthGuard` é no-op, aplicado às
rotas de wallet e substituível por `ProviderIdentityPort`. Health checks permanecem abertos;
mensagens SQS são canal interno confiável, mas payload continua sujeito às
regras de domínio.

## 2. Decisões

### 2.1 Lock pessimista por wallet

**Contexto.** Múltiplas instâncias podem disputar mesma wallet. SQS FIFO não é
garantia de consistência.

**Decisão.** Unidade de concorrência é `walletId`. Use case adquire
`SELECT ... FOR UPDATE` na wallet dentro da transação. MikroORM usa
`LockMode.PESSIMISTIC_WRITE`. Cada operação usa `EntityManager.fork()` e
`transactional()`; EntityManager global nunca participa de request concorrente.

**Alternativas descartadas.** Lock global, read-calculate-update sem lock,
confiança em `MessageGroupId`, optimistic locking como mecanismo principal.

**Trade-offs.** Hot wallets serializam operações, mas preservam saldo e
simplificam retries. Wallets distintas continuam paralelas.

**Evidência.** [Spike item 4](./spike/REPORT.md#4-lock-pessimista-e-concorrência):
SQL gerou `for update`; lock fora de transação foi rejeitado; anti-padrão
aplicou dois débitos; lock passou 20 rodadas e 50 débitos paralelos.

### 2.2 Idempotência antes do lock

**Contexto.** Duplicatas devem ser baratas e não podem segurar lock de wallet
sem necessidade.

**Decisão.** Em `READ COMMITTED`, executar:

```sql
INSERT INTO wager_transactions (...)
VALUES (...)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id;
```

Sem linha retornada, selecionar por `idempotency_key`. Hash igual faz replay;
hash diferente retorna `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`. Se key não existir,
tratar colisão de external ID. Fallback SQL raw é permitido caso API do
MikroORM não exponha forma estável.

**Alternativas descartadas.** Cache em memória, unique violation capturada
dentro da transação, idempotência baseada apenas em SQS.

**Evidência.** `returns idempotency payload and external identity conflicts
without aborting` em
[wagering-use-case.int.test.ts](./test/integration/postgres/wagering-use-case.int.test.ts).

**Trade-offs.** SQL raw reduz abstração ORM, mas evita estado transacional
abortado e torna retorno vencedor/concorrente explícito.

**Evidência.** [Spike item 5](./spike/REPORT.md#5-on-conflict-do-nothing-returning):
50 inserts produziram uma linha, 49 leituras pós-commit e `READ COMMITTED`.
Unique violation produziu `current transaction is aborted`.

### 2.3 Duas unicidades externas

**Contexto.** Idempotency key identifica request; external transaction ID
identifica operação do provedor. Não são a mesma identidade.

**Decisão.** Constraints separadas:

- `UNIQUE (idempotency_key)`;
- `UNIQUE (provider_id, external_transaction_id)`.

Payload diferente na mesma key é `409`; external ID usado por outra operação
também é `409`.

**Alternativas descartadas.** Uma única chave composta, external ID sem
constraint, deduplicação apenas em aplicação.

**Trade-offs.** Mais uma constraint e caminho de erro, em troca de detectar
colisões mesmo com múltiplas instâncias.

**Evidência.** [schema-constraints.int.test.ts](./test/integration/postgres/schema-constraints.int.test.ts),
`handles both idempotency collisions without aborting READ COMMITTED`, cobre
ambas unicidades e colisões sem abortar transação.

### 2.4 Money com Decimal e `numeric(19,2)`

**Contexto.** `number`, float e double são proibidos para dinheiro.

**Decisão.** Domínio usa `Decimal`; contratos usam string decimal com duas
casas; banco usa `numeric(19,2)` + moeda. Valores monetários nunca viram
`number`. Entrada rejeita vazio, notação científica, escala inválida, NaN,
Infinity e negativo onde contrato exige não-negativo.

**Alternativas descartadas.** JavaScript `number`, float, double, arredondamento
manual, tipo monetário do ORM no domínio.

**Trade-offs.** Conversões explícitas e validação maior, sem erro binário.
Modelo continua multi-moeda; cenário pode limitar valores operacionais a BRL.

**Evidência.** [Spike item 3](./spike/REPORT.md#3-mikroorm--numeric--decimal):
MikroORM preservou numeric como string; `0.10 + 0.20` resultou `0.30`; valor
`1234567890123.45` foi preservado.

### 2.5 Snapshot de saldo para replay

**Contexto.** Replay precisa retornar saldo observado, não saldo atual. Regra 7
fala diretamente de operações processadas; mesma semântica é necessária para
respostas pendentes e rejeitadas.

**Decisão.** `wager_transactions` guarda
`result_balance_amount`, `result_balance_currency` e, quando aplicável,
`result_wallet_version`. Snapshot é gravado com wallet travada:

- `PROCESSED`/`REJECTED` imediato: snapshot da primeira decisão;
- `PENDING_REFERENCE`: snapshot da primeira resposta;
- pending resolvida: status atual e snapshot da resolução;
- terminal: snapshot imutável.

Replay sempre envia `idempotentReplay: true` e status atual. Extensão para
`REJECTED` e `PENDING_REFERENCE` é interpretação deste projeto, não alteração
silenciosa do enunciado.

`Money.from` rejeita negativos e `Money` pode produzir negativos somente por
`subtract`/`negate` interno. Entrada aceita 0–2 casas, normaliza para duas e
rejeita mais de 17 dígitos inteiros (limite de `numeric(19,2)`).

**Alternativas descartadas.** Recalcular saldo atual, guardar snapshot apenas
em cache, sobrescrever snapshot terminal.

**Trade-offs.** Mais colunas e regra de imutabilidade; resposta determinística
e auditável.

**Evidência.** [schema-constraints.int.test.ts](./test/integration/postgres/schema-constraints.int.test.ts),
`enforces snapshot and failure/status coherence` e `allows pending resolution
snapshot replacement and blocks other changes`, valida coerência, snapshot
pendente, troca na resolução e imutabilidade.

### 2.6 Rejeição de negócio commitada

**Contexto.** Saldo insuficiente e falhas de validação são resultados de
negócio, não falhas de transação. Rollback apagaria auditoria e resposta.

**Decisão.** Persistir `REJECTED`, `failureCode`, snapshot e
`WagerTransactionRejected` na mesma transação. Não gerar ledger nem evento de
saldo. Exceção é reservada a infraestrutura ou erro inesperado.

**Alternativas descartadas.** Lançar exceção para rejeição, rollback silencioso,
status apenas em memória.

**Trade-offs.** Use case precisa separar resultado de negócio de falha
operacional, mas retries e auditoria ficam corretos.

**Evidência.** `commits business rejection and replays original snapshot` em
[wagering-use-case.int.test.ts](./test/integration/postgres/wagering-use-case.int.test.ts).

### 2.7 Reversão única por referência

**Contexto.** Regra impede reversão duplicada. Permitir uma REFUND e um
ROLLBACK sobre mesma BET poderia creditar duas vezes.

**Decisão.** Índice único parcial em `reference_transaction_id`:

```sql
WHERE kind IN ('REFUND', 'ROLLBACK')
  AND status = 'PROCESSED'
```

Uma referência aceita uma única reversão processada, independentemente do tipo.
`ROLLBACK` de `REFUND` continua válido porque referência é o próprio REFUND.
Interpretação mais estrita da regra 4.

Domínio expõe decisão `assertReversalNotAlreadyProcessed`; consulta de
existência prévia e constraint parcial pertencem à etapa transacional.

**Alternativas descartadas.** Unicidade por `(reference_transaction_id, kind)`,
checagem apenas em código, permitir duas operações compensatórias.

**Trade-offs.** Regra mais restritiva pode rejeitar sequência operacional que
provedor esperava, mas evita crédito duplicado.

**Evidência.** [schema-constraints.int.test.ts](./test/integration/postgres/schema-constraints.int.test.ts),
`enforces one processed reversal while allowing rejected plus processed`, prova
REJECTED + PROCESSED permitido e segundo PROCESSED bloqueado; [spike item
6](./spike/REPORT.md#6-migration-reversível-trigger-e-constraints) cobre a
validação inicial da migration.

### 2.8 WIN com referência opcional

**Contexto.** Enunciado exige referência para REFUND/ROLLBACK, mas não para WIN.

**Decisão.** `WIN` e `LOSS` aceitam referência opcional. Quando presente, deve
ser `BET` `PROCESSED` do mesmo provider, player, wallet, moeda e rodada; valor
não é comparado. REFUND referencia somente BET; ROLLBACK referencia BET, WIN
ou REFUND e compara valor exatamente. LOSS não move saldo; OPENING nunca é
referência externa.

Cada falha tem `failureCode` distinto: kind inválido, referência não
processada, identidade divergente, moeda divergente e valor divergente.

**Alternativas descartadas.** Tornar referência obrigatória para WIN, aceitar
qualquer transação como referência, confiar apenas em external ID.

**Trade-offs.** API aceita mais formas de WIN, mas validação condicional fica
mais detalhada.

**Evidência.** PENDENTE: regras serão cobertas por unidade e integração.

### 2.9 LOSS sem ledger nem version

**Contexto.** LOSS registra resultado sem mover saldo.

**Decisão.** LOSS vira `PROCESSED`, gera evento processado e snapshot, mas não
gera ledger e não incrementa `wallet.version`.

**Alternativas descartadas.** Lançamento zero, incremento de version sem saldo,
alteração de saldo.

**Trade-offs.** Reconciliação deve distinguir transação processada sem
movimento de lançamento financeiro.

**Evidência.** PENDENTE: teste unitário e integração.

### 2.10 PENDING_REFERENCE

**Contexto.** Entrega fora de ordem é esperada.

**Decisão.** Para REFUND/ROLLBACK, referência ausente ou ainda
`PENDING_REFERENCE` persiste `PENDING_REFERENCE`, sem ledger, com evento
pending. Referência `REJECTED`/`FAILED` gera `REJECTED` com
`REFERENCE_NOT_PROCESSED`. Worker usa:

- TTL desde `createdAt`: 15 minutos, terminador principal;
- máximo: 8 tentativas, teto de segurança;
- rejeita quando `now >= createdAt + TTL` ou `attempts >= 8`, com
  `REFERENCE_NOT_FOUND` terminal e `retryable: false`;
- backoff: `delay = min(2s * 2^attempt, 120s) + jitter`;
- base, fator, cap, TTL e máximo vêm de ambiente;
- expiração vira `REJECTED` + `REFERENCE_NOT_FOUND`, snapshot e evento na
  mesma transação;
- `retryable: true` no código operacional, mas estado é terminal; provedor
  deve reenviar com novo external ID e nova idempotency key.

Worker lista IDs vencidos; para cada item abre transação própria, trava wallet,
relê wager com `FOR UPDATE`, revalida status/vencimento e processa.

**Alternativas descartadas.** Espera síncrona, polling sem lock, retries
infinitos, TTL sem limite de tentativas.

**Trade-offs.** Backoff reduz carga, TTL evita pendências eternas, jitter
reduz sincronização entre workers. Parâmetros configuráveis exigem observação.

**Evidência.** PENDENTE: worker, duas instâncias concorrentes e testes de
referência antes/depois do TTL serão implementados na etapa 4.

### 2.11 Ordem de locks

**Contexto.** Referências e pending worker podem acessar mais de uma linha.

**Decisão.** Ordem única: wallet primeiro, qualquer outra linha depois.
Referência sempre pertence à mesma wallet. Pending worker usa transação por
item, lock da wallet, releitura da wager com `FOR UPDATE`, revalidação e
processamento.

**Alternativas descartadas.** Ordenação por wallet ID, referência primeiro,
lock global.

**Trade-offs.** Regra simples reduz deadlock; exige validar wallet antes de
consultar/lockar referência.

**Evidência.** `serializes concurrent bets on one wallet`, `processes 50 of 100
bets with bounded parallelism` e `serializes concurrent REFUND and ROLLBACK`
em [wagering-use-case.int.test.ts](./test/integration/postgres/wagering-use-case.int.test.ts).

**Correção de FK.** `wager_transactions.wallet_id` usa FK
`DEFERRABLE INITIALLY DEFERRED`. O insert de idempotência continua antes do
lock da wallet, mas não mantém `KEY SHARE` durante o lock `FOR UPDATE`;
isso elimina deadlock estrutural entre submits paralelos. Integrado em
`Migration20261010000001`.

### 2.12 Inbox e outbox transacionais

**Contexto.** SQS entrega pelo menos uma vez; processo pode morrer antes do
ack/publicação.

**Decisão.** Inbox `(consumer_name, message_id)` participa da mesma transação
que wager, wallet, ledger e outbox. Outbox guarda envelope versionado e
`eventId` único. Consumidor faz ack somente após commit.

Eventos mínimos: `WagerTransactionProcessed`, `WagerTransactionRejected`,
`WalletBalanceChanged` apenas quando saldo muda e
`WagerTransactionPendingReference`.

**Alternativas descartadas.** Deduplicação em memória, publicar antes do
commit, ack antes do commit.

**Trade-offs.** Duplicatas de publicação continuam possíveis; consumidores
precisam deduplicar por `eventId`. Em troca, evento confirmado não se perde por
crash entre commit e publicação.

**Evidência.** A Etapa 4 cobre atomicidade entre inbox e efeitos financeiros,
ack pós-commit, redelivery e rollback em
[wager-transaction-consumer.int.test.ts](./test/integration/sqs/wager-transaction-consumer.int.test.ts).
Publicação Outbox concorrente e recuperação de evento já commitado também
passaram nos testes da Etapa 5 no mesmo arquivo.

### 2.13 Publisher com SKIP LOCKED

**Contexto.** Publishers concorrentes precisam dividir trabalho.

**Decisão.** Selecionar lote pequeno com `FOR UPDATE SKIP LOCKED`, manter lock
durante chamada SQS com timeout curto, marcar publicado na mesma transação.
Enviar `MessageGroupId = aggregateId` e
`MessageDeduplicationId = eventId`.

Banco e SQS não são transacionais juntos. Crash após publicação e antes do
commit pode duplicar evento; consumidor deve aceitar e deduplicar.

**Alternativas descartadas.** Lease adicional com `claimed_until`, lock global,
assumir atomicidade banco/SQS.

**Trade-offs.** Lote pequeno e timeout limitam contenção, mas lock pode durar
durante rede. Duplicata é preferida a perda de evento.

**Evidência.** `two concurrent publishers claim and publish every Outbox event
once` e `committed events recover after restart and failed sends persist
backoff` em
[wager-transaction-consumer.int.test.ts](./test/integration/sqs/wager-transaction-consumer.int.test.ts).
O [Spike item 7](./spike/REPORT.md#7-localstack-sqs-fifo) também confirmou
dedup SQS e head-of-line blocking.

### 2.14 SQS FIFO como otimização

**Contexto.** FIFO ordena mensagens por grupo e oferece dedup temporal, mas
não substitui constraints, locks e inbox.

**Decisão.** Entrada `wager-transactions.fifo`; saída `wager-events.fifo`.
`MessageGroupId = walletId` na entrada e `aggregateId` na saída. Inbox é
garantia persistente.

Head-of-line blocking é esperado: mensagem invisível/falhando bloqueia
mensagens seguintes do mesmo grupo. Ajustar `maxReceiveCount` e
`visibility timeout` para limitar bloqueio sem DLQ prematura.

**Alternativas descartadas.** Standard queue sem ordenação, confiar somente em
FIFO, dedup SQS como idempotência financeira.

**Trade-offs.** Ordenação melhora hot wallet, mas reduz throughput do grupo e
falha lenta bloqueia grupo.

**Evidência.** [Spike item 7](./spike/REPORT.md#7-localstack-sqs-fifo) confirmou
redelivery, DLQ, dedup e head-of-line. A integração da Etapa 4 valida
redelivery, DLQ e encerramento pelo lifecycle Nest; sinal SIGTERM do processo
em container Linux permanece pendente.

### 2.15 Erros permanentes e DLQ

**Contexto.** Mensagens inválidas ou falhas após limite de tentativas precisam
chegar à DLQ sem perder mensagem.

**Decisão.** Resultado de negócio é terminal e recebe ack após commit. Payload
inválido ou conflito de hash Inbox é logado sem payload e não recebe ack; SQS
aplica `maxReceiveCount` e redrive para a DLQ. Falhas de infraestrutura recebem
backoff por `ChangeMessageVisibility` e também acabam no redrive configurado.
Não gravar `FAILED` para mensagem que não produziu uma wager.

**Alternativas descartadas.** Ack de mensagem inválida, retry infinito,
transação financeira parcial para registrar falha.

**Trade-offs.** Redrive é controlado pelo broker; Inbox e idempotência no banco
continuam sendo garantias contra duplicação de efeitos.

**Evidência.** Testes reais com LocalStack cobrem retry e DLQ em
[wager-transaction-consumer.int.test.ts](./test/integration/sqs/wager-transaction-consumer.int.test.ts).

### 2.16 MikroORM com fork por operação

**Contexto.** Identity map global pode devolver entidade velha e o MikroORM
exige contexto transacional para lock pessimista.

**Decisão.** Nest injeta `EntityManager`; cada request/worker cria `fork()`,
opera dentro de `transactional()` e não reutiliza entidade entre transações.

**Alternativas descartadas.** EntityManager global, cache de entidade,
`findOne` com lock fora de transação.

**Trade-offs.** Mais cuidado com ciclo de vida e pool, em troca de isolamento
do identity map.

**Evidência.** [Spike item 4](./spike/REPORT.md#4-lock-pessimista-e-concorrência)
mostrou erro fora de transação e forks concorrentes. Teste Nest com injeção de
EntityManager passou no harness.

### 2.17 Versões fixadas

**Contexto.** Versões novas existem, mas upgrade de major pode alterar
decorators, MikroORM, pool ou integração Nest.

**Decisão.** Spike fixou Bun 1.1.26, NestJS 10.4.15, MikroORM core/driver/
migrations 6.3.13, `@mikro-orm/nestjs` 6.1.2, Decimal.js 10.4.3, PostgreSQL
16.4-alpine e LocalStack 3.8.0. Sem upgrade de major nesta entrega.

**Alternativas descartadas.** Atualizar para Bun 1.4.2, NestJS 12.1.2,
MikroORM 7.2.5 e Decimal.js 10.6.0 sem spike conjunto.

**Trade-offs.** Menor risco conhecido, versões não mais recentes. Upgrade
exige novo spike e decisão explícita.

**Evidência.** [Relatório de versões](./spike/REPORT.md#versões-atuais-consultadas)
lista versões do spike e versões atuais consultadas.

### 2.18 AuthGuard no-op

**Contexto.** Autenticação não recebe pontos e consumiria tempo de invariantes.

**Decisão.** `ProviderAuthGuard` no-op protege as rotas de wallet sem impor
autenticação local; pode ser substituído por integração com IdP. Health checks
permanecem sem autenticação.

**Alternativas descartadas.** Tabela própria de usuários, senha artesanal,
implementar Keycloak nesta etapa.

**Trade-offs.** Não há identidade real em ambiente local; fronteira de extensão
fica explícita.

**Evidência.** PENDENTE: guard e documentação de integração na etapa 6.

### 2.19 Garantias adicionais do schema

**Contexto.** Migration precisa bloquear mutações financeiras sem impedir
resolução válida de pending.

**Decisão.** UPDATE de wager com `OLD.status` terminal (`PROCESSED`,
`REJECTED`, `FAILED`) lança SQLSTATE `55000`; DELETE de qualquer wager também.
Snapshot definido em `PENDING_REFERENCE` não muda enquanto status continua
`PENDING_REFERENCE`. Transição de pending para `PROCESSED`/`REJECTED`/`FAILED`
pode gravar snapshot da resolução. Depois de terminal, wager e snapshot ficam
imutáveis. Wager de reversão processada exige `reference_transaction_id`.
`FAILED` pode não ter snapshot.

`numeric(19,2)` arredonda silenciosamente entradas com mais de duas casas.
`Money.from` rejeita escala inválida antes do SQL; banco não substitui
validação de contrato.

**Alternativas descartadas.** Permitir update terminal, CHECK de escala,
bloquear resolução de pending, DELETE para limpeza operacional.

**Trade-offs.** Trigger adiciona SQLSTATE/mensagens que adapters precisam
mapear; validação de escala fica no domínio/boundary.

**Evidência.** [schema-constraints.int.test.ts](./test/integration/postgres/schema-constraints.int.test.ts),
`enforces snapshot and failure/status coherence`, `allows pending resolution
snapshot replacement and blocks other changes`, `enforces one processed
reversal while allowing rejected plus processed` e `blocks ledger update and
delete with SQLSTATE 55000`; [migration-cycle.int.ts](./test/integration/postgres/migration-cycle.int.ts),
`runs up, down, up and restores schema`.

### 2.20 Colisões sem abortar transação

**Contexto.** Unique violation aborta transação PostgreSQL.

**Decisão.** Repositories usam `INSERT ... ON CONFLICT DO NOTHING RETURNING`
sem alvo explícito. Colisões por `idempotency_key` e por
`(provider_id, external_transaction_id)` retornam vazio e seguem com SELECT na
mesma transação `READ COMMITTED`. Mensagem inválida não cria linha financeira:
consumer faz log estruturado, não confirma e deixa SQS encaminhar à DLQ.

**Alternativas descartadas.** Capturar unique violation e continuar, cache,
dedup somente SQS.

**Trade-offs.** SQL raw pode ser necessário no MikroORM, mas mantém transação
utilizável.

**Evidência.** [schema-constraints.int.test.ts](./test/integration/postgres/schema-constraints.int.test.ts),
`handles both idempotency collisions without aborting READ COMMITTED`; [spike
item 5](./spike/REPORT.md#5-on-conflict-do-nothing-returning) validou comando
e retorno concorrente.

### 2.21 Identidade sintética de OPENING

**Contexto.** Saldo inicial precisa ser auditável, mas OPENING não pode vir de
API/fila.

**Decisão.** Criação de wallet e crédito inicial ocorrem na mesma transação:
`provider_id = 'internal'`, `external_transaction_id =
'opening:<walletId>'`, `idempotency_key = 'internal:opening:<walletId>'`,
`round_id = 'internal'`, `game_id = 'wallet-opening'`, `kind = 'OPENING'`,
`status = 'PROCESSED'`. Wallet nasce com saldo inicial e `version = 1`;
ledger registra `CREDIT`. OPENING externo retorna `400`.

**Alternativas descartadas.** Saldo sem wager, ledger sem transação, OPENING
recebido de provedor.

**Trade-offs.** Criação ganha uma linha financeira, mantendo reconciliação
completa desde origem.

**Evidência.** `creates wallet with atomic opening and processes BET` em
[wagering-use-case.int.test.ts](./test/integration/postgres/wagering-use-case.int.test.ts).

## 3. HTTP e failureCode

### 3.1 Corpo uniforme

Todo erro ou rejeição usa:

```json
{
  "code": "MACHINE_READABLE_CODE",
  "failureCode": "DOMAIN_FAILURE_CODE",
  "retryable": false,
  "message": "Mensagem segura para o consumidor"
}
```

`message` não carrega payload financeiro completo nem detalhe sensível.

### 3.2 Mapeamento HTTP

| HTTP | Situação | Código/failureCode | Retry |
|---:|---|---|---|
| 201 | Nova operação aplicada | resposta normal | não |
| 200 | Replay atual `PROCESSED` | resposta normal, `idempotentReplay: true` | não |
| 202 | `PENDING_REFERENCE` | `REFERENCE_PENDING` | sim, mesma key |
| 422 | Rejeição nova ou replay `REJECTED` | failureCode original | conforme código |
| 409 | Hash divergente | `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` | não |
| 409 | External ID ocupado por outra operação | `EXTERNAL_TRANSACTION_ID_CONFLICT` | não |
| 409 | Wallet duplicada | `WALLET_ALREADY_EXISTS` | não |
| 400 | Key ausente/malformada, OPENING externo, Money/payload inválido | `IDEMPOTENCY_KEY_MISSING` / `INVALID_TRANSACTION_KIND` / `INVALID_MONEY` / `VALIDATION_ERROR` | não |
| 404 | Wallet ou transação inexistente | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | não |
| 503 | PostgreSQL/SQS indisponível ou timeout de lock | `INFRASTRUCTURE_TRANSIENT` | sim, `Retry-After` |
| 500 | Erro inesperado não classificado | `UNEXPECTED_ERROR` | não presumir |
| 500 | Erro permanente gravado como FAILED | `PERMANENT_INFRASTRUCTURE_FAILURE` | não |

Status e corpo devem ser iguais em HTTP e na transformação de resultado do
consumer, embora SQS use ack/retry/DLQ em vez de status HTTP.

### 3.3 Taxonomia de failureCode

| failureCode | Situação | Retryable |
|---|---|---:|
| `WALLET_NOT_FOUND` | Wallet inexistente; transação não persistida | não |
| `PLAYER_WALLET_MISMATCH` | Player diverge da wallet | não |
| `CURRENCY_MISMATCH` | Moeda diverge | não |
| `INSUFFICIENT_FUNDS` | BET sem saldo | não |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão produziria saldo negativo | não |
| `INVALID_REFERENCE_KIND` | Kind incompatível com referência | não |
| `REFERENCE_NOT_PROCESSED` | Referência não está `PROCESSED` | não |
| `REFERENCE_IDENTITY_MISMATCH` | Provider/player/wallet/rodada divergem | não |
| `REFERENCE_CURRENCY_MISMATCH` | Moeda da referência diverge | não |
| `REFERENCE_AMOUNT_MISMATCH` | Valor não é igual ao da referência | não |
| `REFERENCE_ALREADY_REVERSED` | Índice parcial detectou reversão | não |
| `REFERENCE_NOT_FOUND` | Pending expirou ou atingiu teto | não |
| `REFERENCE_PENDING` | Referência ausente ou ainda pending | sim |
| `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` | Mesmo key, payload divergente | não |
| `EXTERNAL_TRANSACTION_ID_CONFLICT` | External ID já usado | não |
| `WALLET_ALREADY_EXISTS` | Player + moeda já existem | não |
| `INVALID_TRANSACTION_KIND` | OPENING externo ou kind inválido | não |
| `INVALID_MONEY` | Amount/currency inválido | não |
| `IDEMPOTENCY_KEY_MISSING` | Header ausente/malformado | não |

### 3.4 Implementação HTTP e ciclo de vida

DTOs são validados por funções puras, sem `class-validator`. O controller não
conhece SQL: usa os mesmos use cases transacionais de criação e processamento,
mais um serviço read-only para consultas.

`X-Correlation-Id` é gerado no middleware quando ausente, devolvido na resposta
e propagado ao envelope de eventos. Logs de requisição registram método, rota
sem query string, status, duração e correlation ID; não registram payload,
headers completos ou valores monetários.

O filtro global usa `FAILURE_METADATA` como fonte única para status e
retryability. JSON inválido e validação retornam `VALIDATION_ERROR`; falhas
transitórias retornam `503` com `Retry-After`; falhas não classificadas retornam
`500` sem stack.

O bootstrap habilita shutdown hooks do Nest. O ORM e pools são encerrados pelo
ciclo de vida da aplicação, uma única vez; testes não encerram pool compartilhado
em hooks de arquivos individuais.

### 3.5 Runner, pool e PostgreSQL

Cada operação cria fork limpo e usa `fork.transactional()` para isolar o
contexto e a transação MikroORM, sem criar ORM por request. Valores padrão
testados são `lock_timeout=2000ms`, `statement_timeout=10000ms`,
`DB_TRANSACTION_RETRIES=3` e backoff inicial de `10ms`. Testes de carga podem
sobrescrever esses valores.

`23503` (foreign key violation) não é erro transitório; permanece permanente
(`500`). Classes `40001`, `40P01`, `55P03`, `57014`, `08xxx`, `53xxx` e falhas
de conexão são transitórias e causam rollback/retry.
| `VALIDATION_ERROR` | DTO/payload inválido | não |
| `TRANSACTION_NOT_FOUND` | Transação inexistente | não |
| `INFRASTRUCTURE_TRANSIENT` | Timeout, conexão ou lock transitório | sim |
| `PERMANENT_INFRASTRUCTURE_FAILURE` | Falha permanente auditável em FAILED | não |

`REFERENCE_NOT_FOUND` é terminal e não retryable. `REFERENCE_PENDING` representa
somente estado 202; novo envio durante pending reutiliza mesma key.

Etapa 2 define tabela única de códigos; mapeamento de exceções concretas para
HTTP e contrato operacional de `FAILED` permanecem PENDENTE até etapa 3/4.

## 4. Limitações e pendências

- **Concluído — etapa 4.** Consumidor SQS provisiona filas FIFO e DLQ,
  processa Inbox na transação financeira, confirma após commit, aplica backoff,
  deixa falhas permanentes seguirem redrive e aguarda trabalho em andamento no
  shutdown. Integração usa PostgreSQL e LocalStack reais.
- **Concluído — SIGTERM real.** Processo Bun no container Linux recebeu SIGTERM;
  log `sqs.lifecycle.shutdown_complete` confirmou drenagem dos workers antes do
  encerramento (exit `143`, status esperado após reenvio do sinal).
- **Concluído — item 8 da Etapa 1.** `nest-lock.int.test.ts` valida DI
  Nest, `EntityManager.fork()`, transação MikroORM, lock pessimista e SQL
  `FOR UPDATE` sob `bun test`.
- **Linha 4 revisada.** Testes de migration usam banco separado via
  `TEST_DATABASE_URL`; `bun test` normal não executa teardown `down`. Ciclo
  destrutivo roda apenas em `test:migration`.
- **Concluído — etapa 5.** Publisher Outbox usa `FOR UPDATE SKIP LOCKED`,
  FIFO/dedup por `eventId`, retry persistido e recovery de eventos commitados.
- **Concluído — etapa 6.** Resolver de referências pendentes usa backoff,
  limite e TTL. Ledger tem consulta paginada; reconciliação detecta divergência
  sem corrigir saldo. Health verifica PostgreSQL/SQS e métricas Prometheus
  cobrem duplicatas, retries, conflitos, DLQ, status, duração e atraso Outbox.
  Evidências: [docs/ETAPA6_REPORT.md](docs/ETAPA6_REPORT.md) e
  [operations-api.int.test.ts](test/integration/sqs/operations-api.int.test.ts).
- **Concluído — etapa 7.** Três stacks independentes de persistência e domínio
  compartilham PostgreSQL; 50 requisições idênticas geram um débito. Encerrar e
  recriar uma stack preserva replay e invariante. Teste adicional inicia três
  processos Bun independentes, distribui 50 requisições pela API e verifica
  replay após reiniciar um processo. Evidências:
  [multi-instance-restart.int.test.ts](test/integration/postgres/multi-instance-restart.int.test.ts),
  [multi-process-restart.int.test.ts](test/integration/postgres/multi-process-restart.int.test.ts)
  e [docs/VALIDATION.md](docs/VALIDATION.md).
- **Concluído — etapa 8.** README cobre setup, rotas e testes; lista de falhas
  eliminatórias revisada. Evidências consolidadas em
  [docs/VALIDATION.md](docs/VALIDATION.md).
- **PENDENTE — versões.** Upgrade para versões atuais só após spike específico;
  não misturar major upgrades com implementação financeira.
- **Limitação conhecida.** `@mikro-orm/nestjs` publicado no spike foi 6.1.2,
  enquanto core/driver/migrations ficaram em 6.3.13; integração Nest + fork +
  transactional passou, mas upgrade conjunto merece validação.
# Etapa 3a: transação e persistência

O hot path usa `EntityManager.fork()` e `transactional()` por operação. Os
adapters executam SQL explícito para evitar dependência do Unit of Work em
linhas inseridas por SQL raw. `lock_timeout` e `statement_timeout` são
configuráveis por `DB_LOCK_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`,
`DB_TRANSACTION_RETRIES` e `DB_TRANSACTION_RETRY_BACKOFF_MS`. Defaults:
`2000ms`, `10000ms`, `3` tentativas e `10ms * tentativa`.

Pool padrão usa `min=2`, `max=10`; integração usa um ORM e um pool de inspeção
únicos por arquivo, ambos encerrados em `afterAll`. PostgreSQL local usa
`max_connections=100`. Teste de 100 apostas dispara lotes de dois para manter
paralelismo real sem exceder pool.

Inserção de wager usa `ON CONFLICT DO NOTHING RETURNING` sem alvo; colisões são
resolvidas por idempotency key e depois por identidade externa. Rejeições de
negócio atualizam wager, snapshot e outbox dentro da mesma transação, sem lançar
exceção. Replay usa snapshot persistido, não saldo atual.

CreateWallet grava OPENING, ledger CREDIT e eventos na mesma transação quando
saldo inicial é positivo. Saldo inicial zero não cria OPENING.

Evidência: [docs/ETAPA3A_REPORT.md](docs/ETAPA3A_REPORT.md) e
[wagering-use-case.int.test.ts](test/integration/postgres/wagering-use-case.int.test.ts).
