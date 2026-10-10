import { Migration } from "@mikro-orm/migrations";

export class Migration20261010000001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_wallet_fk,
        add constraint wager_wallet_fk
          foreign key (wallet_id) references wallets(id)
          on delete restrict deferrable initially deferred;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_wallet_fk,
        add constraint wager_wallet_fk
          foreign key (wallet_id) references wallets(id)
          on delete restrict;
    `);
  }
}
