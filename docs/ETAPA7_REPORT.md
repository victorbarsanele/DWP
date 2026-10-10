# Relatório Etapa 7 — Múltiplas instâncias e reinício

## Implementação obrigatória

- Três stacks de processamento simultâneas usam `MikroORM`, pool PostgreSQL,
  runner e use case independentes contra o mesmo banco real.
- Cinquenta requisições idênticas, distribuídas entre as três instâncias,
  produzem um único wager e um único débito.
- Uma instância encerra e reinicia após o commit. A nova instância lê saldo
  persistido e reconcilia com ledger; invariante final também é verificada em
  PostgreSQL.

O teste de stacks independentes permanece como validação rápida da concorrência
no banco. O teste de processo inicia três aplicações Bun separadas, com portas
HTTP e pools PostgreSQL independentes, distribui requisições reais pela API e
reinicia um processo após o commit. Ambos confirmam replay persistido e
unicidade financeira. Testes SQS reais cobrem workers, Inbox e Outbox em
[wager-transaction-consumer.int.test.ts](../test/integration/sqs/wager-transaction-consumer.int.test.ts).
SIGTERM real e drenagem do lifecycle também foram verificados em Bun/Linux via
container Docker; evidência descrita em [ETAPA4_REPORT.md](ETAPA4_REPORT.md).

## Teste real

[multi-instance-restart.int.test.ts](../test/integration/postgres/multi-instance-restart.int.test.ts)
usa PostgreSQL real, sem mocks. O teste
[multi-process-restart.int.test.ts](../test/integration/postgres/multi-process-restart.int.test.ts)
inicia três processos Bun e usa PostgreSQL real, sem mocks.

## Validação

```text
bun test --timeout 90000 --preload ./test/preload.ts --max-concurrency 1 test/integration/postgres/multi-instance-restart.int.test.ts
1 pass
0 fail
13 expect() calls

bun test --timeout 90000 --preload ./test/preload.ts --max-concurrency 1 test/integration/postgres/multi-process-restart.int.test.ts
1 pass
0 fail
60 expect() calls
```
