# Relatório Etapa 5 — Transactional Outbox

## Implementação

- Publisher reclama um evento elegível por transação com
  `FOR UPDATE SKIP LOCKED`, permitindo publishers concorrentes.
- Publicação usa SQS FIFO `wager-events.fifo`, `MessageGroupId = aggregateId` e
  `MessageDeduplicationId = eventId`.
- Marca evento publicado somente depois do envio. Crash antes do commit pode
  republicar; dedup por `eventId` torna duplicata segura.
- Falha de envio incrementa `attempts` e persiste próximo horário com backoff
  exponencial limitado a 300 segundos.
- Worker Outbox inicia e encerra pelo lifecycle Nest junto do consumer; client
  SQS compartilhado fecha somente depois dos workers.

## Testes reais

Arquivo [wager-transaction-consumer.int.test.ts](../test/integration/sqs/wager-transaction-consumer.int.test.ts).
Usa PostgreSQL e LocalStack:

- dois publishers concorrentes processam eventos sem perda nem duplicata;
- evento já commitado é publicado por publisher novo após restart;
- falha SQS persiste tentativa/backoff, e evento publica após retry.

## Validação

```text
bun run build
exit code 0

bun run test
63 pass
0 fail
350 expect() calls
```
