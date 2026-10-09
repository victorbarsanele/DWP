import { Migration } from "@mikro-orm/migrations";

export class Migration20261009190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists spike_ledger (
        id uuid primary key,
        balance numeric(19,2) not null,
        constraint spike_ledger_balance_non_negative check (balance >= 0)
      );
      create table if not exists spike_transactions (
        id uuid primary key,
        reference_transaction_id uuid,
        kind text not null,
        status text not null
      );
      create unique index if not exists spike_one_processed_reversal
        on spike_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
      create or replace function spike_ledger_immutable()
      returns trigger language plpgsql as $$
      begin
        raise exception 'ledger entries are immutable' using errcode = '55000';
      end;
      $$;
      drop trigger if exists spike_ledger_immutable_trigger on spike_ledger;
      create trigger spike_ledger_immutable_trigger
        before update or delete on spike_ledger
        for each row execute function spike_ledger_immutable();
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop table if exists spike_transactions;");
    this.addSql("drop table if exists spike_ledger;");
    this.addSql("drop function if exists spike_ledger_immutable();");
  }
}
