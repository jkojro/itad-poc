import { Migration } from '@mikro-orm/migrations';

export class Migration20261014091639_itad extends Migration {

  override name = 'Migration20261014091639';

  override up(): void | Promise<void> {
    this.addSql(`create table "itad_certificates" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "certificate_number" text not null, "job_id" uuid not null, "asset_id" uuid not null, "sanitization_run_id" uuid not null, "status" text not null, "snapshot" jsonb not null, "locale" text not null, "pdf_attachment_id" uuid not null, "issued_by_user_id" uuid not null, "issued_at" timestamptz not null, "supersedes_certificate_id" uuid null, "superseded_by_certificate_id" uuid null, "superseded_at" timestamptz null, "superseded_by_user_id" uuid null, "supersede_reason" text null, "voided_at" timestamptz null, "voided_by_user_id" uuid null, "void_reason" text null, "void_reason_code" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create unique index "itad_certificates_asset_issued_unique" on "itad_certificates" ("tenant_id", "organization_id", "asset_id") where "status" = 'issued';`);
    this.addSql(`create index "itad_certificates_asset_idx" on "itad_certificates" ("tenant_id", "organization_id", "asset_id", "issued_at");`);
    this.addSql(`create index "itad_certificates_job_idx" on "itad_certificates" ("tenant_id", "organization_id", "job_id", "status");`);
    this.addSql(`alter table "itad_certificates" add constraint "itad_certificates_number_unique" unique ("tenant_id", "organization_id", "certificate_number");`);

    this.addSql(`create table "itad_certificate_events" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "certificate_id" uuid not null, "kind" text not null, "reason" text null, "related_certificate_id" uuid null, "actor_user_id" uuid null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "itad_certificate_events_certificate_idx" on "itad_certificate_events" ("tenant_id", "organization_id", "certificate_id", "created_at");`);

    this.addSql(`alter table "itad_sanitization_runs" add "media_identifiers" jsonb null;`);

    this.addSql(`alter table "itad_certificates" add constraint "itad_certificates_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);
    this.addSql(`alter table "itad_certificates" add constraint "itad_certificates_asset_id_foreign" foreign key ("asset_id") references "itad_assets" ("id");`);
    this.addSql(`alter table "itad_certificates" add constraint "itad_certificates_sanitization_run_id_foreign" foreign key ("sanitization_run_id") references "itad_sanitization_runs" ("id");`);

    this.addSql(`alter table "itad_certificate_events" add constraint "itad_certificate_events_certificate_id_foreign" foreign key ("certificate_id") references "itad_certificates" ("id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "itad_certificate_events" cascade;`);
    this.addSql(`drop table if exists "itad_certificates" cascade;`);
    this.addSql(`alter table "itad_sanitization_runs" drop column "media_identifiers";`);
  }

}
