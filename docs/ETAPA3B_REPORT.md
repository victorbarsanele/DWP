# Relatório Etapa 3b

## Resultado

Etapa HTTP mínima implementada e validada por smoke test:

- `POST /wallets`
- `POST /wagering/transactions`
- `GET /wallets/:walletId`
- `GET /wagering/transactions/:transactionId`
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
- validação manual de DTOs;
- `HttpExceptionFilter` centralizado em `FAILURE_METADATA`;
- `X-Correlation-Id` ecoado ou gerado;
- logs estruturados sem payload e valores monetários;
- JSON malformado retorna `VALIDATION_ERROR`;
- erro inesperado não expõe stack;
- `InfrastructureTransientError` retorna `503` e `Retry-After`.

Também foram concluídas pendências da 3a:

- rollback total após falha do `OutboxWriter`, permanente e transitória;
- erro transitório esgotado com `maxAttempts = 1`;
- carteira, wager, ledger e outbox permanecem sem alterações;
- pool compartilhado não é encerrado por teste individual;
- bloco morto de pool de uma conexão removido;
- helper de invariantes aceita saldo inicial de carteira criada diretamente;
- conexões residuais ao fim da suíte: `0`.

## Comandos e resultados reais

| Comando | Resultado |
|---|---|
| `bun run build` | passou |
| `bun run test:unit` | 26 pass, 0 fail, 114 asserts |
| `bun run test:int` | 27 pass, 0 fail, 161 asserts |
| `bun run test` - execução 1 | 53 pass, 0 fail, 275 asserts, 3.75s |
| `bun run test` - execução 2 | 53 pass, 0 fail, 275 asserts, 4.31s |
| `bun run test` - execução 3 | 53 pass, 0 fail, 275 asserts, 4.18s |
| conexões `spike_test` ao final | `0` |

Smoke HTTP validou inicialização Nest, resolução de dependências, rota inexistente com UUID retornando `404`, envelope de falha e `X-Correlation-Id`.

## Arquivos principais

- `src/http/validation.ts`
- `src/http/http-errors.ts`
- `src/http/http-exception.filter.ts`
- `src/http/query.service.ts`
- `src/http/wallet.controller.ts`
- `src/http/http.module.ts`
- `src/main.ts`
- `src/application/application.module.ts`
- `src/infrastructure/persistence/mikro-orm/transaction-runner.adapter.ts`
- `test/integration/postgres/wagering-use-case.int.test.ts`
- `test/integration/postgres/helpers/assert-wallet-invariant.ts`
- `test/integration/postgres/helpers/database.ts`

## Desvio relevante

O runner mantém `fork().transactional()` por operação. O teste de rollback usa
wallet pré-criada diretamente para não introduzir uma segunda transação de setup
no mesmo cenário; a operação sob teste continua usando runner de produção.

Testes HTTP automatizados via `fetch` ainda devem ser ampliados na etapa seguinte; smoke test cobriu bootstrap e contrato básico de erro.
