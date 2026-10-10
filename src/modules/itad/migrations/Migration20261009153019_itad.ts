import { Migration } from '@mikro-orm/migrations';

export class Migration20261009153019_itad extends Migration {

  override name = 'Migration20261009153019';

  override up(): void | Promise<void> {
    this.addSql(`create table "itad_asset_status_transitions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "asset_id" uuid not null, "action" text not null, "from_status" text null, "to_status" text not null, "data_bearing_from" boolean null, "data_bearing_to" boolean null, "reason" text null, "actor_user_id" uuid null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "itad_asset_status_transitions_asset_idx" on "itad_asset_status_transitions" ("tenant_id", "organization_id", "asset_id", "created_at");`);

    this.addSql(`alter table "itad_jobs" add "default_data_bearing" boolean null;`);

    this.addSql(`alter table "itad_assets" add "data_bearing_source" text null, add "data_bearing_decided_by_user_id" uuid null, add "data_bearing_decided_at" timestamptz null, add "sanitization_required_at" timestamptz null;`);
    this.addSql(`create index "itad_assets_scope_job_status_idx" on "itad_assets" ("tenant_id", "organization_id", "job_id", "status") where "deleted_at" is null;`);

    this.addSql(`alter table "itad_manifest_items" add "data_bearing" boolean null;`);

    this.addSql(`alter table "itad_asset_status_transitions" add constraint "itad_asset_status_transitions_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);
    this.addSql(`alter table "itad_asset_status_transitions" add constraint "itad_asset_status_transitions_asset_id_foreign" foreign key ("asset_id") references "itad_assets" ("id");`);

    // Backfill (sanitization spec "Backfill rules"). Existing values were set by hand.
    this.addSql(`update "itad_assets" set "data_bearing_source" = 'manual' where "data_bearing" is not null and "data_bearing_source" is null;`);
    // Data-bearing assets enter sanitization only in jobs that can still run it; terminal
    // jobs (completed, cancelled) are never changed retroactively. No events are emitted.
    this.addSql(`update "itad_assets" a set "status" = 'sanitization_required', "sanitization_required_at" = now() from "itad_jobs" j where j."id" = a."job_id" and a."deleted_at" is null and a."data_bearing" = true and a."status" = 'received' and j."status" in ('receiving', 'processing', 'on_hold', 'closeout_review');`);
  }

  override down(): void | Promise<void> {
    this.addSql(`update "itad_assets" set "status" = 'received' where "status" = 'sanitization_required';`);
    this.addSql(`drop table if exists "itad_asset_status_transitions";`);

    this.addSql(`drop index "itad_assets_scope_job_status_idx";`);
    this.addSql(`alter table "itad_assets" drop column "data_bearing_source", drop column "data_bearing_decided_by_user_id", drop column "data_bearing_decided_at", drop column "sanitization_required_at";`);

    this.addSql(`alter table "itad_jobs" drop column "default_data_bearing";`);

    this.addSql(`alter table "itad_manifest_items" drop column "data_bearing";`);
  }

}
