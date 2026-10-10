# Relatório Etapa 4 — Inbox e consumer SQS

## Implementação

- Consumidor FIFO integrado ao ciclo de vida NestJS; filas de entrada e DLQ
  provisionadas com `maxReceiveCount` configurável.
- Validação do envelope `WagerTransactionRequested`; payload inválido é logado
  sem conteúdo financeiro e encaminhado à DLQ por redrive nativo.
- Inbox identifica `(consumer_name, message_id)` e compara SHA-256 do corpo.
  Inbox, wager, wallet, ledger e outbox participam da mesma transação.
- Mesmo use case atende HTTP e SQS; rejeições de negócio são terminais e recebem
  ack somente depois do commit.
- Falhas transitórias alteram visibilidade com backoff exponencial limitado a
  300 segundos. Duplicatas e redelivery não repetem efeitos financeiros.
- Encerramento interrompe long polling e espera mensagem em andamento terminar.

## Testes reais

Arquivo [wager-transaction-consumer.int.test.ts](../test/integration/sqs/wager-transaction-consumer.int.test.ts).
Usa PostgreSQL e LocalStack reais:

- provisionamento de filas FIFO e redrive para DLQ;
- bootstrap NestJS e fechamento do worker;
- commit antes do ack e ack de rejeição de negócio;
- redelivery após commit sem duplicar wager ou débito;
- rollback de Inbox e efeitos financeiros após falha transacional;
- retry transitório, DLQ de mensagem inválida e espera por processamento em
  andamento no shutdown.

## Validação

```text
bun run build
exit code 0

bun run test
61 pass
0 fail
322 expect() calls
```

O lifecycle NestJS também foi validado com SIGTERM real em container Linux:
`sqs.lifecycle.shutdown_complete` apareceu antes do processo encerrar com status
`143` (sinal recebido e reemitido após shutdown ordenado).
