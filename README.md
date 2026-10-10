# Distributed Wagering Processor

Processador de transações de apostas com NestJS, Bun, PostgreSQL, ledger
imutável, idempotência persistente e mensageria SQS. Visão das decisões,
invariantes e limitações em [ARCHITECTURE.md](ARCHITECTURE.md); requisitos em
[docs/DESAFIO.md](docs/DESAFIO.md).

## Requisitos locais

- Bun compatível com `package.json`;
- Docker Compose.

PostgreSQL e LocalStack locais são usados por aplicação e testes. A configuração
do Compose desativa durabilidade do PostgreSQL para acelerar desenvolvimento;
não usar esse Compose em produção.

## Iniciar

No PowerShell, na raiz do repositório:

```powershell
Copy-Item .env.example .env
docker compose up -d postgres localstack
bun install
bun run migrate:up
bun run start
```

A API escuta `http://localhost:3000`. O bootstrap provisiona filas SQS FIFO e
inicia consumer, publisher Outbox e resolver de referências pendentes.
Variáveis e valores locais estão em `.env.example`; não reutilizar credenciais
locais em produção.

## API mínima

Criar wallet:

```http
POST /wallets
Content-Type: application/json
```

```json
{
  "playerId": "0192f28f-5dc0-4d58-8db2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Enviar wager:

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
Content-Type: application/json
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-4d58-8db2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-4d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Dinheiro trafega como decimal string e é calculado com precisão decimal.
`Idempotency-Key` é obrigatório; replay idêntico não gera novo movimento.

Consultas e operação:

```text
GET  /wallets/:walletId
GET  /wallets/:walletId/ledger?limit=50&cursor=<opaco>
GET  /wagering/transactions/:transactionId
GET  /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wallets/:walletId/reconciliation
GET  /health/live
GET  /health/ready
GET  /metrics
```

Ledger é paginado por cursor estável. Reconciliação sinaliza divergência sem
alterar saldo. Readiness verifica PostgreSQL e SQS; health fica sem autenticação
conforme escopo do desafio.

## Build e testes

```powershell
bun run build
bun run test:unit
bun run test
```

`bun run test` migra `TEST_DATABASE_URL` e executa unidade e integração contra
PostgreSQL e LocalStack. Subir os dois serviços com Compose antes. A suíte inclui
um teste que inicia três processos Bun independentes, envia duplicatas pela API,
reinicia um processo e verifica o replay persistido. Evidências resumidas em
[docs/VALIDATION.md](docs/VALIDATION.md); relatórios por etapa são material
complementar. Migration `down` existe para ciclo controlado; não usar contra
dados que precisam ser preservados.
