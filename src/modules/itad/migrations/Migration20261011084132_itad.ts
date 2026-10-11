import { Migration } from '@mikro-orm/migrations';

export class Migration20261011084132_itad extends Migration {

  override name = 'Migration20261011084132';

  override up(): void | Promise<void> {
    this.addSql(`create table "itad_exceptions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "type" text not null, "status" text not null default 'open', "source_key" text not null, "asset_id" uuid null, "manifest_item_id" uuid null, "intake_scan_id" uuid null, "sanitization_run_id" uuid null, "serial" text not null, "assigned_to_user_id" uuid null, "resolution_outcome" text null, "resolution_reason" text null, "resolved_by_user_id" uuid null, "resolved_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "itad_exceptions_asset_idx" on "itad_exceptions" ("tenant_id", "organization_id", "asset_id") where "asset_id" is not null;`);
    this.addSql(`create index "itad_exceptions_job_idx" on "itad_exceptions" ("tenant_id", "organization_id", "job_id", "status", "type");`);
    this.addSql(`alter table "itad_exceptions" add constraint "itad_exceptions_source_unique" unique ("tenant_id", "organization_id", "source_key");`);

    this.addSql(`create table "itad_exception_events" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "exception_id" uuid not null, "kind" text not null, "assigned_to_user_id" uuid null, "previous_assigned_to_user_id" uuid null, "outcome" text null, "reason" text null, "actor_user_id" uuid null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "itad_exception_events_exception_idx" on "itad_exception_events" ("tenant_id", "organization_id", "exception_id", "created_at");`);

    this.addSql(`alter table "itad_exceptions" add constraint "itad_exceptions_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);
    this.addSql(`alter table "itad_exceptions" add constraint "itad_exceptions_asset_id_foreign" foreign key ("asset_id") references "itad_assets" ("id") on delete set null;`);
    this.addSql(`alter table "itad_exceptions" add constraint "itad_exceptions_manifest_item_id_foreign" foreign key ("manifest_item_id") references "itad_manifest_items" ("id") on delete set null;`);
    this.addSql(`alter table "itad_exceptions" add constraint "itad_exceptions_intake_scan_id_foreign" foreign key ("intake_scan_id") references "itad_intake_scans" ("id") on delete set null;`);
    this.addSql(`alter table "itad_exceptions" add constraint "itad_exceptions_sanitization_run_id_foreign" foreign key ("sanitization_run_id") references "itad_sanitization_runs" ("id") on delete set null;`);

    this.addSql(`alter table "itad_exception_events" add constraint "itad_exception_events_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);
    this.addSql(`alter table "itad_exception_events" add constraint "itad_exception_events_exception_id_foreign" foreign key ("exception_id") references "itad_exceptions" ("id");`);

    // Backfill (exceptions spec Q10): unresolved Epic 2/3 cases of non-terminal jobs become
    // OPEN exceptions. `on conflict do nothing` on the occurrence key keeps it re-runnable.
    const live = `j."status" not in ('completed', 'cancelled')`
    const pastReceiving = `(j."status" in ('processing', 'closeout_review') or (j."status" = 'on_hold' and j."status_before_hold" in ('processing', 'closeout_review')))`
    const conflict = `on conflict ("tenant_id", "organization_id", "source_key") do nothing`
    // Pending or different-device duplicate scans.
    this.addSql(`insert into "itad_exceptions" ("tenant_id", "organization_id", "job_id", "type", "status", "source_key", "asset_id", "intake_scan_id", "serial", "created_at", "updated_at")
      select s."tenant_id", s."organization_id", s."job_id", 'duplicate_serial', 'open', 'duplicate:' || s."id", s."asset_id", s."id", a."serial", now(), now()
      from "itad_intake_scans" s join "itad_jobs" j on j."id" = s."job_id" join "itad_assets" a on a."id" = s."asset_id"
      where s."result" = 'duplicate' and s."resolved_at" is null and ${live} ${conflict};`);
    // The latest run of an asset waiting in review, when it failed.
    this.addSql(`insert into "itad_exceptions" ("tenant_id", "organization_id", "job_id", "type", "status", "source_key", "asset_id", "sanitization_run_id", "serial", "created_at", "updated_at")
      select r."tenant_id", r."organization_id", r."job_id", 'sanitization_failed', 'open', 'sanitization_failed:' || r."id", r."asset_id", r."id", r."serial", now(), now()
      from (
        select distinct on (run."asset_id") run.*, a."serial" from "itad_sanitization_runs" run
        join "itad_assets" a on a."id" = run."asset_id"
        where a."status" = 'review_required' and a."deleted_at" is null
        order by run."asset_id", run."started_at" desc, run."id" desc
      ) r join "itad_jobs" j on j."id" = r."job_id"
      where r."result" = 'FAIL' and ${live} ${conflict};`);
    // Jobs already past receiving: manifest items still missing.
    this.addSql(`insert into "itad_exceptions" ("tenant_id", "organization_id", "job_id", "type", "status", "source_key", "manifest_item_id", "serial", "created_at", "updated_at")
      select m."tenant_id", m."organization_id", m."job_id", 'missing_from_delivery', 'open', 'missing:' || m."id", m."id", m."serial", now(), now()
      from "itad_manifest_items" m join "itad_jobs" j on j."id" = m."job_id"
      where m."deleted_at" is null and ${pastReceiving}
        and not exists (select 1 from "itad_assets" a where a."tenant_id" = m."tenant_id" and a."organization_id" = m."organization_id"
          and a."job_id" = m."job_id" and a."serial_normalized" = m."serial_normalized" and a."deleted_at" is null)
      ${conflict};`);
    // Jobs already past receiving: assets still unexpected.
    this.addSql(`insert into "itad_exceptions" ("tenant_id", "organization_id", "job_id", "type", "status", "source_key", "asset_id", "serial", "created_at", "updated_at")
      select a."tenant_id", a."organization_id", a."job_id", 'unexpected_asset', 'open', 'unexpected:' || a."id", a."id", a."serial", now(), now()
      from "itad_assets" a join "itad_jobs" j on j."id" = a."job_id"
      where a."deleted_at" is null and ${pastReceiving}
        and not exists (select 1 from "itad_manifest_items" m where m."tenant_id" = a."tenant_id" and m."organization_id" = a."organization_id"
          and m."job_id" = a."job_id" and m."serial_normalized" = a."serial_normalized" and m."deleted_at" is null)
      ${conflict};`);
    // A system `created` event for every exception that has no history yet.
    this.addSql(`insert into "itad_exception_events" ("tenant_id", "organization_id", "job_id", "exception_id", "kind", "actor_user_id", "created_at")
      select e."tenant_id", e."organization_id", e."job_id", e."id", 'created', null, e."created_at"
      from "itad_exceptions" e
      where not exists (select 1 from "itad_exception_events" ev where ev."exception_id" = e."id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "itad_exception_events";`);
    this.addSql(`drop table if exists "itad_exceptions";`);
  }

}
