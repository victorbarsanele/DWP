# Etapa 0 — Spike de validação da stack

Status: bloqueado no subcaso SIGTERM do item 7, após duas tentativas de
harness. Itens 1–6 aprovados; item 7 aprovado exceto SIGTERM; item 8 não
executado.

## Regra de execução

Itens executados em ordem. Ao primeiro item que falhar, execução para. Cada
item registra comando, saída observada, resultado, problemas, contorno e
impacto no plano. Nenhum código fora de `spike/`.

## Dependências e imagens

Runtime: Bun 1.1.26 (instalado via npm `bun@1.1.26`).

Imagens:

- `postgres:16.4-alpine`, digest `sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c`
- `localstack/localstack:3.8.0`, digest `sha256:f1db6c829fd3ab8db21007e91f62b6f76396722fcbaf6d223a8110f42482fd7e`

## 1. Docker Compose

Comando:

```powershell
docker compose -f spike\docker-compose.yml up -d
```

Saída relevante:

```text
postgres ... Up ... (healthy) ... 0.0.0.0:55432->5432/tcp
localstack ... Up ... (healthy) ... 0.0.0.0:4566->4566/tcp
PostgreSQL 16.4 ... 64-bit
LocalStack ... version 3.8.0 ... sqs available
```

Resultado: OK

Problemas/contorno/impacto: nenhum. Healthchecks confirmados.

## 2. Bun + NestJS

Comandos:

```powershell
npm install --global bun@1.1.26
Set-Location spike; bun install
Set-Location spike; bunx tsc --noEmit
Set-Location spike; bun run start
```

Saída:

```text
1.1.26
decorators-and-di-ok
```

Resultado: OK

Problemas/contorno/impacto: nenhum. `experimentalDecorators`,
`emitDecoratorMetadata`, decorators e DI funcionaram sem `@Inject()` explícito.

Dependências instaladas no spike:

```text
@mikro-orm/core@6.3.13
@mikro-orm/postgresql@6.3.13
@mikro-orm/migrations@6.3.13
@mikro-orm/nestjs@6.1.2
@nestjs/common@10.4.15
@nestjs/core@10.4.15
@nestjs/testing@10.4.15
decimal.js@10.4.3
pg@8.12.0
@types/pg@8.11.10
@types/bun@1.4.2
@aws-sdk/client-sqs@3.637.0
reflect-metadata@0.2.2
rxjs@7.8.1
@types/node@22.5.4
typescript@5.5.4
```

## 3. MikroORM + numeric + Decimal

Comandos:

```powershell
Set-Location spike; bunx tsc --noEmit
Set-Location spike; bun run src/mikro-numeric.ts
```

Saída:

```json
{"rows":[{"amount":"0.10"},{"amount":"0.20"},{"amount":"1234567890123.45"}],"amountTypes":["string","string","string"],"decimalSum":"0.30","largeValue":"1234567890123.45"}
```

Resultado: OK

Problemas/contorno/impacto: `@mikro-orm/postgresql@6.3.13` retorna
`numeric(19,2)` como `string`; `decimal.js@10.4.3` executa em Bun e soma sem
rounding binário.

## 4. Lock pessimista e concorrência

Comandos:

```powershell
Set-Location spike; bunx tsc --noEmit
Set-Location spike; bun run src/lock-concurrency.ts
```

Saída decisiva:

```text
{"lockProbeInsideTransaction":"100.00"}
{"lockOutsideTransaction":"An open transaction is required for this operation"}
[query] select "l0".* from "lock_rows" ... limit 1 for update
{"negativeControl":{"appliedCount":2,"finalBalance":"20.00"}}
{"twentyRounds":{"allOneApplied":true,...}}
{"fiftyDebits":{"appliedCount":10,"finalBalance":"0.00"}}
```

Resultado: OK

Problemas/contorno/impacto: primeira tentativa falhou por harness:
`@types/pg` ausente e EntityManager global. Corrigido com `@types/pg@8.11.10`,
forks separados, `transactional()` e `flush()` ORM. Segunda tentativa passou.
Pool MikroORM configurado com 10 conexões; concorrentes usaram forks distintos.
Anti-padrão provou dois débitos aplicados; lock provou uma aplicação em 20
rodadas e 10 aplicações em 50 débitos de 10.00. Identity map não foi
reutilizado: cada transação abriu fork novo.

## 5. ON CONFLICT DO NOTHING RETURNING

Comando:

```powershell
Set-Location spike; bun run src/on-conflict.ts
```

Saída:

```json
{"onConflictReturning":{"total":50,"inserted":1,"losersReadingAfterCommit":49,"rows":1,"isolation":"read committed","sqlShape":"INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id","returnShape":"{ rows: [{ id }], rowCount: 1 } or { rows: [], rowCount: 0 }"}}
{"uniqueViolationFallback":{"abortedError":"duplicate key value violates unique constraint \"idempotency_rows_idempotency_key_key\" | follow-up: current transaction is aborted, commands ignored until end of transaction block"}}
```

Resultado: OK

Problemas/contorno/impacto: SQL raw é fallback aprovado. `ON CONFLICT` retorna
`rows[0]`/`rowCount = 1` no vencedor e vazio/zero nos demais. Confirmado
`READ COMMITTED`; fallback com exceção aborta transação e exige rollback.

## 6. Migration reversível, trigger e constraints

Comandos:

```powershell
Set-Location spike; bunx tsc --noEmit
Set-Location spike; bun run src/migration-probe.ts
```

Saída:

```text
{"afterUp":{"failures":{"update":"... ledger entries are immutable","delete":"... ledger entries are immutable","check":"... violates check constraint \"spike_ledger_balance_non_negative\"","partialUnique":"... duplicate key value violates unique constraint \"spike_one_processed_reversal\""}}}
{"afterDown":{"ledgerExists":false,"functionExists":false}}
{"afterUpAgain":{"ledgerExists":true}}
```

Resultado: OK

Problemas/contorno/impacto: `Migration20261009190000` usa `this.addSql`;
`up/down/up` passou. Postgres entrega trigger como erro SQLSTATE `55000`,
CHECK/índice como unique/check violation. Produção deve mapear esses erros
tipados para erro de infraestrutura ou conflito, nunca mascarar.

## 7. LocalStack SQS FIFO

Comandos:

```powershell
Set-Location spike; bunx tsc --noEmit
Set-Location spike; bun run src/sqs-probe.ts
```

Saída:

```text
{"redelivery":{"firstMessageId":"...","secondMessageId":"...","sameMessage":true}}
{"deadLetter":{"attemptsWithoutAck":[1,2],"deliveredToDlq":"dead-letter"}}
{"sqsDedup":{"sent":2,"received":1,"bodies":["dedup-0"]}}
{"headOfLine":{"first":"head-first","whileInvisible":null,"afterAck":"head-second"}}
```

Resultado: FALHOU no subcaso SIGTERM; demais subcasos OK.

Evidência:

- FIFO + `MessageGroupId` + `MessageDeduplicationId`: OK.
- Redelivery após visibility timeout sem ack: mesmo `MessageId`.
- Redrive para DLQ após duas entregas sem ack: OK.
- Dedup SQS: duas mensagens enviadas com mesmo dedup ID, uma recebida.
  Isso não substitui inbox persistente.
- Head-of-line blocking: segunda mensagem do mesmo grupo não veio enquanto
  primeira estava invisível; veio após ack. `maxReceiveCount` e visibility
  timeout precisam evitar bloqueio excessivo.
- SIGTERM: duas tentativas de harness (`process.kill` e
  `ChildProcess.kill("SIGTERM")`) deixaram consumidor Bun vivo no Windows; o
  handler não produziu `sigterm:visibility-returned`. Processos órfãos foram
  encerrados por PID específico após cada tentativa.

Problema/alternativa/impacto: limitação observada de sinais POSIX em processo
Bun filho no Windows, não falha de SQS. Não afirmar shutdown certificado neste
ambiente. Alternativa para produção: validar em Linux/CI Docker e testar
Nest `beforeApplicationShutdown`/`SIGTERM` dentro do container Linux; handler
deve fazer `ChangeMessageVisibility(0)` ou concluir e só então sair. Plano
mantém risco de shutdown como bloqueante até prova Linux.

## 8. bun test

Não executado: item 7 encontrou incapacidade do harness SIGTERM no ambiente
Windows após duas tentativas. Já existe teste parcial aprovado:

```text
Set-Location spike; bun test test\nest-di.test.ts test\nest-mikro.test.ts
2 pass
0 fail
2 expect() calls
Ran 2 tests across 2 files. [1.51s]
```

## Versões atuais consultadas

Comando:

```powershell
npm view bun version
npm view @nestjs/core version
npm view @mikro-orm/core version
npm view decimal.js version
```

Saída:

```text
bun 1.4.2
@nestjs/core 12.1.2
@mikro-orm/core 7.2.5
decimal.js 10.6.0
```

Mantidas versões do spike: Bun 1.1.26, NestJS 10.4.15, MikroORM core/driver/
migrations 6.3.13, MikroORM Nest adapter 6.1.2 (6.3.13 não existe para esse
pacote), decimal.js 10.4.3. Atualizar agora aumenta risco e foge do objetivo
de validar stack escolhida; decisão fica para o responsável.

## Ajustes necessários no plano

- Manter `EntityManager.fork()` sempre; `LockMode.PESSIMISTIC_WRITE` exige
  transação e gera `FOR UPDATE`.
- Usar `ON CONFLICT DO NOTHING RETURNING`, preferencialmente SQL raw se API
  MikroORM não expuser forma estável; não capturar unique violation dentro da
  mesma transação sem rollback.
- Migration SQL customizada e trigger entregam erros Postgres tipados; mapear
  explicitamente.
- SQS FIFO reduz duplicatas e ordena grupo, mas inbox/outbox continuam
  obrigatórios.
- Validar SIGTERM em Linux/CI; Windows não certificou handler Bun.
- Item 8 ainda exige teste único cobrindo Nest DI, transação lock e ida/volta
  SQS.

## Convenções recomendadas para produção

- Nest DI por constructor metadata funcionou sob `bun run` e `bun test`; manter
  `reflect-metadata`, `experimentalDecorators` e `emitDecoratorMetadata`.
- Injetar EntityManager pelo `@mikro-orm/nestjs`; abrir `fork()` por operação
  ou contexto e usar `transactional()`. Nunca usar EntityManager global em
  request/worker concorrente.
- Money no domínio como Decimal/string; PostgreSQL `numeric(19,2)` chega como
  string; nunca converter para `number`.
- `LockMode.PESSIMISTIC_WRITE` somente dentro transação; validar timeout como
  erro transitório.
- Trigger de ledger é proteção de auditoria; não transformar erro em sucesso.
- Versões atuais do spike ficam fixadas até decisão explícita de upgrade.

## Riscos remanescentes

- SIGTERM não comprovado no Bun Windows; falta prova Linux/CI.
- Item 8 ainda não executado como teste integrado único.
- MikroORM Nest adapter publicado em 6.1.2, enquanto core está em 6.3.13;
  compatibilidade mínima passou, mas upgrade conjunto precisa spike separado.
- Versões mais novas existem, mas não foram certificadas no desafio.
