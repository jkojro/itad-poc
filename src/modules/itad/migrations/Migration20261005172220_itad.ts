import { Migration } from '@mikro-orm/migrations';

export class Migration20261005172220_itad extends Migration {

  override name = 'Migration20261005172220';

  override up(): void | Promise<void> {
    this.addSql(`create table "itad_manifest_imports" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "attachment_id" uuid not null, "file_name" text not null, "mime_type" text not null, "file_size" int not null, "file_sha256" text not null, "format" text not null, "sheet_name" text null, "source_columns" jsonb not null, "mapping" jsonb not null, "warnings" jsonb not null, "accepted_warnings_by_user_id" uuid null, "total_rows" int not null, "imported_count" int not null, "skipped_count" int not null, "blank_count" int not null, "skipped_rows" jsonb not null, "job_status_at_change" text not null, "imported_by_user_id" uuid not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create unique index "itad_manifest_imports_file_unique" on "itad_manifest_imports" ("tenant_id", "organization_id", "job_id", "file_sha256", coalesce("sheet_name", ''));`);
    this.addSql(`create index "itad_manifest_imports_scope_job_idx" on "itad_manifest_imports" ("tenant_id", "organization_id", "job_id", "created_at");`);

    this.addSql(`create table "itad_manifest_items" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "import_id" uuid not null, "source_row" int not null, "serial" text not null, "serial_normalized" text not null, "customer_asset_tag" text null, "manufacturer" text null, "model" text null, "source_data" jsonb not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, "deleted_by_user_id" uuid null, "delete_reason" text null, "delete_job_status" text null, primary key ("id"));`);
    this.addSql(`create unique index "itad_manifest_items_serial_unique" on "itad_manifest_items" ("tenant_id", "organization_id", "job_id", "serial_normalized") where "deleted_at" is null;`);
    this.addSql(`create index "itad_manifest_items_scope_job_idx" on "itad_manifest_items" ("tenant_id", "organization_id", "job_id", "deleted_at");`);

    this.addSql(`alter table "itad_manifest_imports" add constraint "itad_manifest_imports_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);

    this.addSql(`alter table "itad_manifest_items" add constraint "itad_manifest_items_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);
    this.addSql(`alter table "itad_manifest_items" add constraint "itad_manifest_items_import_id_foreign" foreign key ("import_id") references "itad_manifest_imports" ("id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "itad_manifest_items";`);
    this.addSql(`drop table if exists "itad_manifest_imports";`);
  }

}
