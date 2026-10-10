# Relatório final — Etapa 2

## Passo 1 — Money e erros

**Resultado:** OK.

**Arquivos:** `src/domain/money/money.ts`,
`src/domain/shared/domain-error.ts`,
`src/domain/shared/failure-code.ts`.

Implementado:

- Decimal imutável;
- amount string não negativo em `Money.from`;
- 0–2 casas, normalização para duas;
- rejeição de vazio, sinal negativo, `NaN`, `Infinity`, expoente, moeda
  inválida e mais de 17 dígitos inteiros;
- `subtract`/`negate` podem produzir negativos somente internamente;
- tabela única `FAILURE_METADATA` com `retryable` e HTTP status;
- `REFERENCE_PENDING`, `VALIDATION_ERROR` e `TRANSACTION_NOT_FOUND`.

## Passo 2 — Wallet e ledger

**Resultado:** OK.

**Arquivos:** `src/domain/wallet/wallet.ts`,
`src/domain/ledger/wallet-ledger-entry.ts`.

`Wallet.open` inicia version 1. `debit`/`credit` retornam movimento com entry,
saldo e version. Saldo insuficiente não muta estado. Version só incrementa em
movimento real. Ledger valida direção, amount positivo, moedas iguais e
aritmética `before ± amount = after`.

## Passo 3 — Wager e failure codes

**Resultado:** OK.

**Arquivo:** `src/domain/wagering/wager-transaction.ts`.

Transições implementadas:

```text
PENDING -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
PROCESSED/REJECTED/FAILED -> nenhuma
```

Implementadas regras de referência:

- REFUND/ROLLBACK exigem referência;
- WIN/LOSS aceitam referência opcional;
- referência ausente ou PENDING_REFERENCE retorna decisão `WAIT`;
- referência REJECTED/FAILED retorna `REFERENCE_NOT_PROCESSED`;
- WIN não compara amount;
- REFUND/ROLLBACK comparam amount;
- validação de kind, provider, player, wallet, round e currency;
- direção de BET, WIN, REFUND e ROLLBACK;
- decisão de reversão já processada;
- terminais imutáveis por erro de programação.

## Passo 4 — Eventos e payload de domínio

**Resultado:** OK.

**Arquivos:** `src/domain/events/integration-event.ts`,
`wager-transaction-processed.ts`, `wager-transaction-rejected.ts`,
`wager-transaction-pending-reference.ts` e `wallet-balance-changed.ts`.

Os quatro eventos carregam `correlationId` obrigatório, `causationId` opcional,
version, eventType, timestamps e dados serializáveis. Money vira string decimal
no envelope.

## Passo 5 — Revisão de fronteiras e testes

**Resultado:** OK.

**Comandos e saídas reais:**

```text
bun run build
$ tsc --noEmit
exit code 0

bun run test
36 pass
0 fail
141 expect() calls
Ran 36 tests across 6 files. [2.13s]

git diff --check
exit code 0
```

Repetição hermética sem recriar schema:

```text
run 1: 36 pass, 0 fail, 141 expect() calls, Ran 36 tests across 6 files. [1350ms]
run 2: 36 pass, 0 fail, 141 expect() calls, Ran 36 tests across 6 files. [1350ms]
run 3: 36 pass, 0 fail, 141 expect() calls, Ran 36 tests across 6 files. [1408ms]
```

Testes executados:

- `Money > accepts zero, integer and one decimal and normalizes to two decimals`
- `Money > rejects more than two decimal places`
- `Money > rejects negative, empty, NaN, Infinity and scientific notation`
- `Money > rejects 18 or more integer digits and invalid currency`
- `Money > keeps arithmetic immutable and rejects mixed currencies`
- `Money > does not depend on Decimal floating point arithmetic`
- `Wallet > starts at version one with initial balance`
- `Wallet > debits and creates a balanced debit entry`
- `Wallet > credits and increments version only when balance moves`
- `Wallet > rejects insufficient funds without mutating state`
- `Wallet > rejects negative, zero and mismatched movement currency`
- `WagerTransaction > starts pending and requires reference for reversals`
- `WagerTransaction > allows only valid transitions and rejects terminal changes`
- `WagerTransaction > maps balance effect and rollback directions`
- `WagerTransaction > waits for absent or pending reversal reference`
- `WagerTransaction > rejects rejected reference as not processed`
- `WagerTransaction > does not compare value for referenced WIN`
- `WagerTransaction > compares value for REFUND and ROLLBACK`
- `WagerTransaction > validates reference identity, kind and currency`
- `WagerTransaction > decides processed reversal uniqueness`
- três testes de envelope dos quatro eventos.

Domínio não possui imports de NestJS, MikroORM, SQS ou decorators. `number`
existe somente em version/status metadata; valores monetários usam Decimal e
string.

## Desvios

- `Money.fromNonNegative` não foi criado, conforme ajuste aprovado. `Money.from`
  rejeita negativo; negativos surgem somente de `subtract`/`negate`.
- `Wallet` lança `CurrencyMismatchError` para moeda divergente e
  `InvalidMoneyError` para amount zero/não positivo.
- `WagerTransaction.markPendingReference` altera somente status; snapshot e
  timestamps persistidos da resolução permanecem responsabilidade da etapa 3.
- `CreateWallet` e use case transacional ficaram para etapa 3.
- Payload hash canônico ficou pendente para helper/application da etapa 3; etapa
  2 cobre contrato de domínio e eventos.

## Riscos remanescentes

- Adapter da etapa 3 deve converter decisões `WAIT` para persistência
  `PENDING_REFERENCE`, snapshot e HTTP 202 sem lançar exceção de negócio.
- Adapter deve impedir OPENING externo e garantir amount > 0 antes do SQL.
- `FAILURE_METADATA` precisa ser usado pelo filter HTTP, sem duplicar tabela.
- Regras de referência precisam ser mantidas alinhadas com locks e SELECT
  `FOR UPDATE` da etapa 3.
- `Wallet.open` não cria OPENING/ledger; atomicidade pertence ao use case.
