# Evidências de validação

Resumo para avaliação. README e ARCHITECTURE contêm setup, decisões e trade-offs;
relatórios por etapa são evidência complementar.

| Critério | Evidência automatizada |
|---|---|
| Precisão monetária e regras de domínio | Testes em [`test/unit/domain`](../test/unit/domain); contratos usam strings decimais. |
| Constraints, ledger e migrations reversíveis | [`schema-constraints.int.test.ts`](../test/integration/postgres/schema-constraints.int.test.ts); [`migration-cycle.int.ts`](../test/integration/postgres/migration-cycle.int.ts). |
| Concorrência e idempotência no PostgreSQL real | [`wagering-use-case.int.test.ts`](../test/integration/postgres/wagering-use-case.int.test.ts); [`multi-instance-restart.int.test.ts`](../test/integration/postgres/multi-instance-restart.int.test.ts). |
| Três processos independentes | [`multi-process-restart.int.test.ts`](../test/integration/postgres/multi-process-restart.int.test.ts): três aplicações Bun com portas e pools independentes; 50 requests HTTP idênticas; um wager e um débito; replay após reinício. |
| Inbox, retry, DLQ, Outbox e concorrência de publishers | [`wager-transaction-consumer.int.test.ts`](../test/integration/sqs/wager-transaction-consumer.int.test.ts), contra PostgreSQL e LocalStack. |
| Referências fora de ordem, health e métricas | [`pending-reference-resolution.int.test.ts`](../test/integration/postgres/pending-reference-resolution.int.test.ts); [`operations-api.int.test.ts`](../test/integration/sqs/operations-api.int.test.ts). |
| SIGTERM e drenagem do worker | Smoke test em Bun/Linux dentro de container Docker; log `sqs.lifecycle.shutdown_complete` antes da saída do processo. |

Executar localmente após iniciar PostgreSQL e LocalStack:

```powershell
bun run build
bun run test
```

`bun run test` aplica migrations ao banco de teste e executa suíte unitária e de
integração. Testes de processo usam `Bun.spawn`; todos os filhos são encerrados
pela suíte, inclusive após falha.

Última validação local:

```text
bun run build
passed

bun run test
69 pass
0 fail
455 expect() calls
```
