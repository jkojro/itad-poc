import { Migration } from '@mikro-orm/migrations';

export class Migration20261009093339_itad extends Migration {

  override name = 'Migration20261009093339';

  override up(): void | Promise<void> {
    this.addSql(`create index "itad_assets_serial_lookup_idx" on "itad_assets" ("tenant_id", "organization_id", "serial_normalized" text_pattern_ops) where "deleted_at" is null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "itad_assets_serial_lookup_idx";`);
  }

}
