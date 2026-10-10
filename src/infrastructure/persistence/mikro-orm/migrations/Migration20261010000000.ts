import { Migration } from "@mikro-orm/migrations";

export class Migration20261010000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency varchar(3) not null,
        balance_amount numeric(19,2) not null,
        version integer not null default 1,
        created_at timestamptz not null default current_timestamp,
        updated_at timestamptz not null default current_timestamp,
        constraint wallets_balance_non_negative check (balance_amount >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_currency_iso check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_player_currency_unique unique (player_id, currency)
      );

      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(100) not null,
        external_transaction_id varchar(255) not null,
        idempotency_key varchar(255) not null,
        player_id uuid not null,
        wallet_id uuid not null,
        round_id varchar(255) not null,
        game_id varchar(255) not null,
        kind varchar(16) not null,
        status varchar(24) not null default 'PENDING',
        amount numeric(19,2) not null,
        currency varchar(3) not null,
        reference_external_transaction_id varchar(255),
        reference_transaction_id uuid,
        payload_hash char(64) not null,
        failure_code varchar(80),
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        result_balance_amount numeric(19,2),
        result_balance_currency varchar(3),
        result_wallet_version integer,
        created_at timestamptz not null default current_timestamp,
        updated_at timestamptz not null default current_timestamp,
        processed_at timestamptz,
        constraint wager_kind_valid check
          (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_status_valid check
          (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_amount_positive check (amount > 0),
        constraint wager_attempts_non_negative check (attempts >= 0),
        constraint wager_currency_iso check (currency ~ '^[A-Z]{3}$'),
        constraint wager_reference_required check (
          kind not in ('REFUND', 'ROLLBACK')
          or reference_external_transaction_id is not null
        ),
        constraint wager_reference_forbidden_for_opening check (
          kind <> 'OPENING'
          or (
            reference_external_transaction_id is null
            and reference_transaction_id is null
          )
        ),
        constraint wager_processed_reversal_has_reference check (
          not (kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED')
          or reference_transaction_id is not null
        ),
        constraint wager_snapshot_all_or_none check (
          (
            result_balance_amount is null
            and result_balance_currency is null
            and result_wallet_version is null
          )
          or (
            result_balance_amount is not null
            and result_balance_currency is not null
            and result_wallet_version is not null
          )
        ),
        constraint wager_snapshot_currency_iso check (
          result_balance_currency is null
          or result_balance_currency ~ '^[A-Z]{3}$'
        ),
        constraint wager_snapshot_version_positive check (
          result_wallet_version is null or result_wallet_version >= 1
        ),
        constraint wager_status_failure_coherence check (
          (status in ('REJECTED', 'FAILED') and failure_code is not null)
          or (status not in ('REJECTED', 'FAILED') and failure_code is null)
        ),
        constraint wager_status_snapshot_coherence check (
          status not in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED')
          or result_balance_amount is not null
        ),
        constraint wager_idempotency_key_unique unique (idempotency_key),
        constraint wager_provider_external_unique
          unique (provider_id, external_transaction_id),
        constraint wager_wallet_fk
          foreign key (wallet_id) references wallets(id) on delete restrict
          deferrable initially deferred,
        constraint wager_reference_fk
          foreign key (reference_transaction_id)
          references wager_transactions(id) on delete restrict
      );

      create index wager_pending_due_idx
        on wager_transactions (status, next_attempt_at)
        where status = 'PENDING_REFERENCE';

      create index wager_wallet_status_idx
        on wager_transactions (wallet_id, status, created_at);

      create unique index wager_one_processed_reversal_per_reference_idx
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';

      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction varchar(6) not null,
        amount numeric(19,2) not null,
        currency varchar(3) not null,
        balance_before numeric(19,2) not null,
        balance_after numeric(19,2) not null,
        created_at timestamptz not null default current_timestamp,
        constraint ledger_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_before_non_negative check (balance_before >= 0),
        constraint ledger_after_non_negative check (balance_after >= 0),
        constraint ledger_currency_iso check (currency ~ '^[A-Z]{3}$'),
        constraint ledger_arithmetic check (
          direction not in ('DEBIT', 'CREDIT')
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
          or
          (direction = 'CREDIT' and balance_after = balance_before + amount)
        ),
        constraint ledger_wallet_fk
          foreign key (wallet_id) references wallets(id) on delete restrict,
        constraint ledger_transaction_fk
          foreign key (transaction_id)
          references wager_transactions(id) on delete restrict,
        constraint ledger_one_per_wallet_transaction
          unique (wallet_id, transaction_id)
      );

      create table inbox_messages (
        consumer_name varchar(100) not null,
        message_id varchar(255) not null,
        payload_hash char(64) not null,
        received_at timestamptz not null default current_timestamp,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );

      create index inbox_unprocessed_idx
        on inbox_messages (consumer_name, received_at)
        where processed_at is null;

      create table outbox_messages (
        id uuid primary key,
        event_id uuid not null unique,
        aggregate_id uuid not null,
        event_type varchar(100) not null,
        version integer not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null default current_timestamp,
        published_at timestamptz,
        constraint outbox_version_positive check (version >= 1),
        constraint outbox_attempts_non_negative check (attempts >= 0)
      );

      create index outbox_pending_due_idx
        on outbox_messages (next_attempt_at, occurred_at)
        where published_at is null;

      create or replace function reject_ledger_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'ledger entries are immutable' using errcode = '55000';
      end;
      $$;

      create trigger wallet_ledger_immutable_trigger
      before update or delete on wallet_ledger_entries
      for each row execute function reject_ledger_mutation();

      create or replace function reject_wager_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager transactions are immutable' using errcode = '55000';
        end if;

        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'terminal wager transaction is immutable'
            using errcode = '55000';
        end if;

        if old.status = 'PENDING_REFERENCE'
           and new.status = 'PENDING_REFERENCE'
           and (
             new.result_balance_amount is distinct from old.result_balance_amount
             or new.result_balance_currency is distinct from old.result_balance_currency
             or new.result_wallet_version is distinct from old.result_wallet_version
           ) then
          raise exception 'pending wager result snapshot is immutable'
            using errcode = '55000';
        end if;

        return new;
      end;
      $$;

      create trigger wager_immutable_trigger
      before update or delete on wager_transactions
      for each row execute function reject_wager_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger if exists wager_immutable_trigger on wager_transactions;
      drop trigger if exists wallet_ledger_immutable_trigger on wallet_ledger_entries;
      drop function if exists reject_wager_mutation();
      drop function if exists reject_ledger_mutation();
      drop table if exists outbox_messages;
      drop table if exists inbox_messages;
      drop table if exists wallet_ledger_entries;
      drop table if exists wager_transactions;
      drop table if exists wallets;
    `);
  }
}
