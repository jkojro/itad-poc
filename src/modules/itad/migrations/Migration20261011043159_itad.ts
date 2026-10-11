import { Migration } from '@mikro-orm/migrations';

export class Migration20261011043159_itad extends Migration {

  override name = 'Migration20261011043159';

  override up(): void | Promise<void> {
    this.addSql(`create table "itad_sanitization_runs" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "asset_id" uuid not null, "method" text not null, "method_detail" text null, "tool" text not null, "tool_version" text not null, "operator_user_id" uuid not null, "started_at" timestamptz not null, "finished_at" timestamptz null, "finished_by_user_id" uuid null, "result" text null, "verification_method" text null, "verification_notes" text null, "abort_reason" text null, "bulk_batch_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "itad_sanitization_runs_tool_idx" on "itad_sanitization_runs" ("tenant_id", "organization_id", "tool");`);
    this.addSql(`create index "itad_sanitization_runs_job_idx" on "itad_sanitization_runs" ("tenant_id", "organization_id", "job_id", "started_at");`);
    this.addSql(`create unique index "itad_sanitization_runs_open_unique" on "itad_sanitization_runs" ("tenant_id", "organization_id", "asset_id") where "result" is null;`);

    this.addSql(`create table "itad_sanitization_evidence" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "run_id" uuid not null, "attachment_id" uuid not null, "file_name" text not null, "added_by_user_id" uuid not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "itad_sanitization_evidence_job_idx" on "itad_sanitization_evidence" ("tenant_id", "organization_id", "job_id", "attachment_id");`);
    this.addSql(`alter table "itad_sanitization_evidence" add constraint "itad_sanitization_evidence_run_attachment_unique" unique ("run_id", "attachment_id");`);

    this.addSql(`alter table "itad_asset_status_transitions" add "run_id" uuid null;`);
    this.addSql(`alter table "itad_asset_status_transitions" add constraint "itad_asset_status_transitions_run_id_foreign" foreign key ("run_id") references "itad_sanitization_runs" ("id") on delete set null;`);

    this.addSql(`alter table "itad_sanitization_runs" add constraint "itad_sanitization_runs_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);
    this.addSql(`alter table "itad_sanitization_runs" add constraint "itad_sanitization_runs_asset_id_foreign" foreign key ("asset_id") references "itad_assets" ("id");`);

    this.addSql(`alter table "itad_sanitization_evidence" add constraint "itad_sanitization_evidence_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);
    this.addSql(`alter table "itad_sanitization_evidence" add constraint "itad_sanitization_evidence_run_id_foreign" foreign key ("run_id") references "itad_sanitization_runs" ("id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "itad_sanitization_evidence" drop constraint if exists "itad_sanitization_evidence_run_id_foreign";`);
    this.addSql(`alter table "itad_asset_status_transitions" drop constraint if exists "itad_asset_status_transitions_run_id_foreign";`);

    this.addSql(`alter table "itad_asset_status_transitions" drop column "run_id";`);

    this.addSql(`drop table if exists "itad_sanitization_evidence";`);
    this.addSql(`drop table if exists "itad_sanitization_runs";`);
  }

}
