import { Migration } from '@mikro-orm/migrations';

export class Migration20261009075007_itad extends Migration {

  override name = 'Migration20261009075007';

  override up(): void | Promise<void> {
    this.addSql(`create table "itad_assets" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "serial" text not null, "serial_normalized" text not null, "customer_asset_tag" text null, "manufacturer" text null, "model" text null, "data_bearing" boolean null, "status" text not null default 'received', "received_at" timestamptz not null, "received_by_user_id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, "deleted_by_user_id" uuid null, "delete_reason" text null, primary key ("id"));`);
    this.addSql(`create unique index "itad_assets_serial_unique" on "itad_assets" ("tenant_id", "organization_id", "job_id", "serial_normalized") where "deleted_at" is null;`);
    this.addSql(`create index "itad_assets_scope_job_idx" on "itad_assets" ("tenant_id", "organization_id", "job_id", "deleted_at");`);

    this.addSql(`create table "itad_intake_scans" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "asset_id" uuid not null, "manifest_item_id" uuid null, "raw_serial" text not null, "serial_normalized" text not null, "result" text not null, "scanned_by_user_id" uuid not null, "scanned_at" timestamptz not null, "resolution" text null, "resolution_note" text null, "resolved_by_user_id" uuid null, "resolved_at" timestamptz null, "flagged_different_device_at" timestamptz null, "flagged_different_device_by_user_id" uuid null, "flagged_different_device_note" text null, primary key ("id"));`);
    this.addSql(`create index "itad_intake_scans_pending_duplicates_idx" on "itad_intake_scans" ("tenant_id", "organization_id", "job_id") where "result" = 'duplicate' and "resolved_at" is null;`);
    this.addSql(`create index "itad_intake_scans_scope_job_idx" on "itad_intake_scans" ("tenant_id", "organization_id", "job_id", "scanned_at");`);

    this.addSql(`alter table "itad_assets" add constraint "itad_assets_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);

    this.addSql(`alter table "itad_intake_scans" add constraint "itad_intake_scans_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);
    this.addSql(`alter table "itad_intake_scans" add constraint "itad_intake_scans_asset_id_foreign" foreign key ("asset_id") references "itad_assets" ("id");`);
    this.addSql(`alter table "itad_intake_scans" add constraint "itad_intake_scans_manifest_item_id_foreign" foreign key ("manifest_item_id") references "itad_manifest_items" ("id") on delete set null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "itad_intake_scans";`);
    this.addSql(`drop table if exists "itad_assets";`);
  }

}
