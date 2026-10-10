# Relatório Etapa 8 — Documentação e revisão eliminatória

## Documentação

- [README.md](../README.md) cobre ambiente local, migrations, execução, testes
  e rotas mínimas.
- [.env.example](../.env.example) lista variáveis lidas pela aplicação, com
  limites pendentes alinhados aos defaults.
- [ARCHITECTURE.md](../ARCHITECTURE.md) registra decisões, trade-offs,
  limitações e evidências das etapas.
- [VALIDATION.md](VALIDATION.md) resume evidências verificáveis para rubrica e
  falhas eliminatórias.

## Checklist de falhas eliminatórias

| Risco do desafio | Revisão e evidência |
|---|---|
| Dinheiro em `number` | Montantes de domínio e API usam decimal string/`Money`; testes em [money.test.ts](../test/unit/domain/money.test.ts). |
| Saldo negativo por race | Lock da wallet e constraints no PostgreSQL; [wagering-use-case.int.test.ts](../test/integration/postgres/wagering-use-case.int.test.ts) cobre saldo concorrente. |
| Débito/crédito duplicado | Idempotência persistente e unique ledger; testes concorrentes, Inbox e [schema-constraints.int.test.ts](../test/integration/postgres/schema-constraints.int.test.ts). |
| Idempotência só em memória | Chaves e Inbox persistidas no PostgreSQL; replay e redelivery cobertos por integração. |
| Correção limitada a uma instância | [multi-process-restart.int.test.ts](../test/integration/postgres/multi-process-restart.int.test.ts): três processos Bun, 50 requisições HTTP idênticas e replay após reinício; [multi-instance-restart.int.test.ts](../test/integration/postgres/multi-instance-restart.int.test.ts) mantém teste de pools independentes. |
| Evento publicado antes do commit | Outbox grava na transação financeira; falha e recuperação cobertas em [ETAPA5_REPORT.md](ETAPA5_REPORT.md). |
| Sem ledger auditável | Lançamentos persistentes e trigger de imutabilidade; [schema-constraints.int.test.ts](../test/integration/postgres/schema-constraints.int.test.ts). |
| Integrações totalmente mockadas | Testes usam PostgreSQL e LocalStack reais em [test/integration](../test/integration). |

Revisão não identificou falha eliminatória pendente nas evidências locais.

## Validação final

```text
bun run build
exit code 0

bun run test
69 pass
0 fail
455 expect() calls
```

Teste de processo cobre aplicações Bun separadas. SIGTERM real e drenagem do
lifecycle foram verificados separadamente em Bun/Linux dentro de container
Docker, com log de shutdown ordenado antes do encerramento.
