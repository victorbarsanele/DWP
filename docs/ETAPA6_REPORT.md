# Relatório Etapa 6 — Referências pendentes e operação

## Implementação obrigatória

- Resolver agenda `PENDING_REFERENCE` com backoff, limite de tentativas e TTL;
  resolve quando referência chega, ou grava rejeição terminal sem movimento
  financeiro.
- `GET /wallets/:walletId/ledger` expõe ledger imutável em páginas com cursor
  estável. Limite padrão 50, máximo 100.
- `POST /wallets/:walletId/reconciliation` compara saldo materializado com soma
  do ledger. Divergência retorna `DIVERGED` e incrementa métrica; endpoint não
  corrige saldo.
- `GET /health/live` verifica processo; `GET /health/ready` verifica PostgreSQL
  e SQS, retornando `503` se alguma dependência falhar.
- `GET /metrics` expõe contadores de duplicatas, retries, conflitos de lock e
  divergências; duração de processamento; status de wagers; idade do evento
  Outbox pendente; quantidade visível na DLQ.
- Logs JSON `wager.transaction.completed` incluem `correlationId`, `messageId`,
  `transactionId`, `walletId`, `providerId` e resultado; não incluem valor nem
  payload financeiro.

## Testes reais

- [pending-reference-resolution.int.test.ts](../test/integration/postgres/pending-reference-resolution.int.test.ts):
  referência fora de ordem e encerramento após limite, contra PostgreSQL.
- [operations-api.int.test.ts](../test/integration/sqs/operations-api.int.test.ts):
  health, paginação do ledger, reconciliação consistente/divergente, métricas e
  rejeição de cursor/limite inválidos, com PostgreSQL e LocalStack.

## Validação

```text
bun run build
exit code 0

bun run test
67 pass
0 fail
382 expect() calls
```
