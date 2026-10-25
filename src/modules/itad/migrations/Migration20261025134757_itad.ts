import { Migration } from '@mikro-orm/migrations';

export class Migration20261025134757_itad extends Migration {

  override name = 'Migration20261025134757';

  override up(): void | Promise<void> {
    this.addSql(`alter table "itad_jobs" add "pickup_location" text null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "itad_jobs" drop column "pickup_location";`);
  }

}
