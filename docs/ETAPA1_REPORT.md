# Relatório final — Etapa 1

## Passo 1 — Scaffold e configuração

**Resultado:** OK.

**Comandos e saídas relevantes:**

```text
bun install
1 package installed

bun run build
$ tsc --noEmit
exit code 0
```

O primeiro build encontrou falha de harness: `@nestjs/testing` não estava no
manifesto e `expect` não estava importado no helper. A dependência foi
adicionada na versão fixada `10.4.15`, o helper foi corrigido e o build foi
repetido com sucesso. Nenhuma dependência fora das versões do projeto foi
instalada.

**Arquivos criados/alterados:** `package.json`, `bun.lockb`, `tsconfig.json`,
`nest-cli.json`, `.env.example`, `docker-compose.yml`, `src/main.ts`,
`src/app.module.ts` e `src/config/configuration.ts`.

**Desvio:** os containers do spike já ocupavam as portas `55432` e `4566`;
portanto, o Compose raiz não foi iniciado nesta etapa. A migration e os testes
usaram o PostgreSQL já disponível nas mesmas portas. Não houve alteração de
portas sem decisão explícita.

## Passo 2 — Persistência, EntitySchema e migration

**Resultado:** OK.

**Arquivos criados:** `src/infrastructure/persistence/mikro-orm/mikro-orm.options.ts`,
`src/infrastructure/persistence/mikro-orm/migrate.ts`,
`src/infrastructure/persistence/mikro-orm/schemas/schemas.ts` e
`src/infrastructure/persistence/mikro-orm/migrations/Migration20261010000000.ts`.

A migration contém wallets, wager transactions, ledger, inbox e outbox; FKs
RESTRICT, unicidades, checks monetários e de estado, índice parcial de
reversão, índices de consulta, trigger de imutabilidade do ledger e trigger
de imutabilidade/controle de snapshot das wagers.

**Comando e saída:**

```text
bun run migrate:down
[migrator] Reverted 'Migration20261010000000'

bun run migrate:up
[migrator] Applied 'Migration20261010000000'
```

Durante os testes, a primeira tentativa de isolamento da constraint de
direção usava `INVALID`, excedendo `varchar(6)` e produzindo SQLSTATE `22001`.
O caso foi corrigido para `BAD`. A expressão aritmética foi tornada
condicional para direções válidas, garantindo que violação de direção produza
deterministicamente a constraint `ledger_direction_valid`.

## Passo 3 — Testes de integração e reversibilidade

**Resultado:** OK.

**Arquivos criados:** `test/integration/postgres/helpers/database.ts`,
`test/integration/postgres/nest-lock.int.test.ts`,
`test/integration/postgres/schema-constraints.int.test.ts` e
`test/integration/postgres/migration-cycle.int.ts`.

**Comando final:**

```text
bun test --preload ./test/preload.ts --max-concurrency 1 test/integration/postgres
13 pass
0 fail
79 expect() calls
Ran 13 tests across 2 files. [1.77s]

bun run test:migration
[migrator] Reverted 'Migration20261010000000'
[migrator] Applied 'Migration20261010000000'
1 pass
0 fail
```

`bun run test` executa `migrate:test:up` antes da suite e usa
`TEST_DATABASE_URL`. `bun run test:migration` é único comando que derruba e
recria schema, sempre no banco de testes. Banco de desenvolvimento permanece
intacto.

### Hermeticidade

Literais fixos encontrados na varredura inicial de colunas com unicidade:
`key-collision`, `provider-collision`, `provider-test`, `test-consumer` e
`consumer`. Todos foram removidos. `idempotency_key`, `provider_id`,
`external_transaction_id`, `event_id`, `message_id` e `player_id` agora usam
`id()`/UUID ou sufixo único por execução. `player_id + currency` também fica
único por execução. Não há limpeza destrutiva: testes usam identidades novas;
`TRUNCATE ... CASCADE` não é necessário.

Prova sem recriar schema:

```text
run 1: 13 pass, 0 fail, 79 expect() calls, 2 files
run 2: 13 pass, 0 fail, 79 expect() calls, 2 files
run 3: 13 pass, 0 fail, 79 expect() calls, 2 files

bun run test:migration
1 pass, 0 fail, 2 expect() calls

bun run test
13 pass, 0 fail, 79 expect() calls, 2 files
```

Cobertura:

- DI Nest sob `bun test`, `EntityManager.fork()`, `transactional()` e
  `PESSIMISTIC_WRITE`, com `FOR UPDATE`;
- controles positivos para todas as tabelas;
- unicidade de wallet, idempotency key, identidade externa, ledger e outbox;
- saldo/version/currency, estados, kinds, amount, attempts e referências;
- coerência e imutabilidade de snapshots;
- arredondamento real de `numeric(19,2)`;
- aritmética e não negatividade do ledger;
- FKs RESTRICT;
- inbox com chave composta;
- triggers de UPDATE/DELETE do ledger;
- trigger de UPDATE/DELETE de wager;
- reversão `REJECTED` mais `PROCESSED` permitida e dois `PROCESSED`
  bloqueados;
- colisões de idempotência e de identidade externa com
  `ON CONFLICT DO NOTHING`, seguida de `SELECT` na mesma transação;
- ciclo `up`, `down`, `up`.

Cada teste de violação verifica SQLSTATE e constraint ou mensagem do trigger.

## Matriz garantia -> teste

| Garantia | Teste exato |
|---|---|
| Wallet UUID/identidade `(player_id,currency)` | `schema-constraints.int.test.ts` — `enforces wallet identity, balance, version and currency` |
| Wallet `balance_amount >= 0`, `version >= 1` | `schema-constraints.int.test.ts` — `enforces wallet identity, balance, version and currency` |
| Currency ISO em wallet | `schema-constraints.int.test.ts` — `enforces wallet identity, balance, version and currency` |
| Wager kind/status válidos | `schema-constraints.int.test.ts` — `enforces wager kind, status, amount, attempts, currency and references` |
| Wager amount positivo/attempts não negativos | `schema-constraints.int.test.ts` — `enforces wager kind, status, amount, attempts, currency and references` |
| Currency ISO em wager | `schema-constraints.int.test.ts` — `enforces wager kind, status, amount, attempts, currency and references` |
| Referência externa obrigatória para REFUND/ROLLBACK | `schema-constraints.int.test.ts` — `enforces wager kind, status, amount, attempts, currency and references` |
| REFUND/ROLLBACK PROCESSED exige `reference_transaction_id` | `schema-constraints.int.test.ts` — `enforces one processed reversal while allowing rejected plus processed` |
| Snapshot all-or-none, currency e versão | `schema-constraints.int.test.ts` — `enforces snapshot and failure/status coherence` |
| Snapshot obrigatório em PENDING_REFERENCE/PROCESSED/REJECTED | `schema-constraints.int.test.ts` — `enforces snapshot and failure/status coherence` |
| FAILED sem snapshot permitido | `schema-constraints.int.test.ts` — `enforces snapshot and failure/status coherence` |
| Coerência status/failureCode | `schema-constraints.int.test.ts` — `enforces snapshot and failure/status coherence` |
| PENDING_REFERENCE pode trocar snapshot ao resolver | `schema-constraints.int.test.ts` — `allows pending resolution snapshot replacement and blocks other changes` |
| PENDING_REFERENCE não pode trocar snapshot enquanto pendente | `schema-constraints.int.test.ts` — `allows pending resolution snapshot replacement and blocks other changes` |
| Wager terminal imutável | `schema-constraints.int.test.ts` — `allows pending resolution snapshot replacement and blocks other changes` |
| DELETE wager bloqueado | `schema-constraints.int.test.ts` — `allows pending resolution snapshot replacement and blocks other changes` |
| Uma reversão PROCESSED por referência; REJECTED + PROCESSED permitido | `schema-constraints.int.test.ts` — `enforces one processed reversal while allowing rejected plus processed` |
| FKs wallet/reference RESTRICT | `schema-constraints.int.test.ts` — `enforces wallet and transaction foreign keys` |
| Ledger direction/amount/balances/arithmetic/currency | `schema-constraints.int.test.ts` — `enforces ledger direction, amounts, balances, currency and uniqueness` |
| Um ledger por `(wallet_id, transaction_id)` | `schema-constraints.int.test.ts` — `enforces ledger direction, amounts, balances, currency and uniqueness` |
| Ledger UPDATE/DELETE bloqueados | `schema-constraints.int.test.ts` — `blocks ledger update and delete with SQLSTATE 55000` |
| Inbox PK `(consumer_name,message_id)` | `schema-constraints.int.test.ts` — `enforces inbox primary key and outbox guarantees` |
| Outbox `event_id` único, version/attempts válidos | `schema-constraints.int.test.ts` — `enforces inbox primary key and outbox guarantees` |
| Idempotency e identidade externa sem abortar transação | `schema-constraints.int.test.ts` — `handles both idempotency collisions without aborting READ COMMITTED` |
| DI Nest, fork, transação e `FOR UPDATE` | `nest-lock.int.test.ts` — `uses constructor DI, fork, transaction and FOR UPDATE` |
| `numeric(19,2)` arredonda; escala fica em `Money.from` | `schema-constraints.int.test.ts` — `rounds numeric(19,2), leaving scale validation to Money.from` |
| Migration reversível up/down/up | `migration-cycle.int.ts` — `runs up, down, up and restores schema` |

Confirmações obrigatórias: existem testes explícitos para REFUND e ROLLBACK
PROCESSED sem referência interna, FAILED sem snapshot, transição
PENDING_REFERENCE para PROCESSED com troca de snapshot, alteração de snapshot
durante PENDING_REFERENCE, CHECK de moeda e DELETE de wager.

Saída real de `\d` confirmou constraints, índices e triggers nas cinco tabelas.
`wager_provider_external_lookup_idx` não existe; índice único de provider mais
external ID já cobre lookup. Também não existem `wallets_balance_scale`,
`wager_amount_scale`, `wager_snapshot_scale` ou `ledger_amount_scale`;
PostgreSQL arredonda `numeric(19,2)` e `Money.from` deve rejeitar escala
excessiva antes do SQL.

## Arquivos finais da etapa

- `package.json`
- `bun.lockb`
- `tsconfig.json`
- `nest-cli.json`
- `.env.example`
- `docker-compose.yml`
- `src/main.ts`
- `src/app.module.ts`
- `src/config/configuration.ts`
- `src/infrastructure/persistence/mikro-orm/`
- `test/integration/postgres/`
- `docs/ETAPA1_REPORT.md`

Pastas `domain`, `application` e `workers` continuam sem arquivos de código,
conforme escopo.

## Desvios do plano

- `@nestjs/testing` precisou ser incluído no manifesto para cumprir o teste de
  DI exigido.
- A validação inicial do Compose encontrou conflito com containers do spike;
  containers foram derrubados e Compose raiz validado com PostgreSQL e
  LocalStack saudáveis. Banco `spike_test` foi criado pelo init script.
- Nenhum ajuste de regra financeira foi feito. A única alteração SQL foi
  tornar a precedência de erro da constraint de direção determinística.

## Riscos remanescentes

- SIGTERM do consumidor Bun no Windows permanece risco conhecido do spike;
  consumidor ainda pertence a etapa posterior.
- Compose precisa ser validado em ambiente sem as portas ocupadas.
- SQL raw de idempotência e integração SQS ainda serão implementados nas
  próximas etapas.
- `Money.from` ainda precisa rejeitar escala acima de duas casas antes de
  qualquer persistência.
- Migrações futuras devem preservar trigger, FKs e invariantes existentes.
