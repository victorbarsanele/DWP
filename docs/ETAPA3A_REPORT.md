# Relatório Etapa 3a

## Implementação

- `TransactionRunnerPort` e `MikroTransactionRunner`: `fork()` por operação,
  `transactional()`, `READ COMMITTED`, `lock_timeout` e `statement_timeout`.
- Adapters SQL explícitos para wallet, wager, ledger e outbox.
- `ProcessWagerTransactionUseCase`: inserção idempotente sem alvo de conflito,
  lock pessimista da wallet, rejeição commitada, pending reference, replay por
  snapshot, ledger e outbox transacionais.
- `CreateWalletUseCase`: saldo inicial, OPENING sintético, ledger CREDIT e
  eventos atômicos.
- Hash canônico normalizado por `Money`.
- `Migration20261010000001`: FK `wager_transactions.wallet_id`
  `DEFERRABLE INITIALLY DEFERRED`, evitando deadlock entre KEY SHARE do FK e
  `FOR UPDATE` da wallet.

## Testes

Arquivo [wagering-use-case.int.test.ts](../test/integration/postgres/wagering-use-case.int.test.ts):

- `creates wallet with atomic opening and processes BET`
- `commits business rejection and replays original snapshot`
- `serializes concurrent bets on one wallet`
- `processes WIN and LOSS references with correct ledger effects`
- `processes REFUND and ROLLBACK in reference direction`
- `rejects rollback that would make balance negative`
- `deduplicates identical concurrent submissions`
- `persists PENDING_REFERENCE with backoff snapshot`
- `processes 50 of 100 bets with bounded parallelism`
- `processes concurrent bets on distinct wallets`
- `serializes concurrent REFUND and ROLLBACK`
- `creates zero-balance wallet without OPENING and rejects duplicate identity`

Suíte completa final: 53 testes, 262 asserts, 0 falhas.

## Validação

`bun run build`: passou.

Validações finais:

```text
bun run test:unit
26 pass
0 fail
114 expect() calls

bun run test:int
27 pass
0 fail
148 expect() calls

bun run test:migration
1 pass
0 fail
2 expect() calls

bun run test (1), (2), (3)
53 pass
0 fail
262 expect() calls em cada execução
```

Reprodução isolada do segundo teste:

```text
bun run test:file ... -t "commits business rejection"
pass
```

Reprodução isolada do teste de carga:

```text
bun run test:file ... -t "processes 50 of 100 bets"
pass
```

Contagem final de conexões observada após encerrar consulta de inspeção:
0. Nenhum processo Bun permaneceu ativo.

Matriz A/B/C:

- A1 rollback de infraestrutura: OK, mas teste usa runner PostgreSQL nativo;
- A2 conflitos de idempotência/external ID: OK;
- A3 replay e PENDING_REFERENCE: OK;
- A4 WIN/LOSS/reversões: OK;
- A5 `assertWalletInvariant`: OK nos testes com wallet; usa cliente `pg.Client`
  dedicado, sempre fechado em `finally`;
- A6 hash e `FAILURE_METADATA`: OK;
- B pool único por ORM/arquivo, `max=10`, `min=0`, acquire timeout 15s: OK;
- B carga de 100 apostas abaixo de 30s: OK após FK de wallet deferível;
- C scripts, compose e documentação: OK.

Cada execução executou `migrate:test:up`, que é não destrutivo.

## Pool e retry

- MikroORM usa um único `EntityManager` Nest; cada operação cria `fork()`.
- Testes criam um ORM e um pool de inspeção por arquivo, encerrados em `afterAll`.
- Pool MikroORM padrão: `min=0`, `max=10`, acquire timeout 15s; carga usa
  `max=20`, ainda abaixo do limite de 20 por processo.
- PostgreSQL `max_connections=100`; medição pós-suite: uma conexão ativa.
- `53300` veio de 100 promises criadas antes do batching, abrindo 100
  transações simultâneas. Teste cria inputs primeiro e dispara pares
  concorrentes, mantendo paralelismo real sem exceder pool.
- Defaults runner: `lock_timeout=2000ms`, `statement_timeout=10000ms`,
  `DB_TRANSACTION_RETRIES=3`, `DB_TRANSACTION_RETRY_BACKOFF_MS=10`.
- Testes de carga sobrescrevem lock/retry para permitir fila controlada.

## Matriz final

- Rollback por falha transitória após caminho de ledger: OK.
- Colisão de idempotency key e external identity: OK.
- Replay de snapshot processado: OK.
- PENDING_REFERENCE com snapshot/backoff: OK.
- WIN valor diferente, LOSS, REFUND, ROLLBACK: OK.
- Carga 100 apostas: OK, 50 processadas, 50 rejeitadas, saldo 0.00;
  wallets distintas e reversões concorrentes: OK.
- Hash canônico e `FAILURE_METADATA`: OK.
- Scripts `test:unit`, `test:int`, `test:file`: OK.
- Compose PostgreSQL otimizado somente dev/teste: OK.

Deadlock observado antes da correção: `INSERT` com FK mantinha `KEY SHARE`
enquanto transação pedia `FOR UPDATE`. FK deferível remove retenção de lock
durante caminho de idempotência, mantendo insert antes do lock.

Workers SQS, controllers HTTP e resolução por worker permanecem fora do escopo
da etapa 3a.
