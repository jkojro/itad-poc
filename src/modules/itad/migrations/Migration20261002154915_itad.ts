import { Migration } from '@mikro-orm/migrations';

export class Migration20261002154915_itad extends Migration {

  override name = 'Migration20261002154915';

  override up(): void | Promise<void> {
    this.addSql(`create table "itad_jobs" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "customer_id" uuid not null, "internal_reference" text not null, "customer_reference" text null, "name" text not null, "status" text not null default 'draft', "status_before_hold" text null, "held_at" timestamptz null, "held_by_user_id" uuid null, "hold_reason" text null, "expected_asset_estimate" int null, "scheduled_pickup_at" timestamptz null, "started_at" timestamptz null, "completed_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "itad_jobs_customer_reference_unique" on "itad_jobs" ("tenant_id", "organization_id", lower("customer_reference")) where "deleted_at" is null and "customer_reference" is not null;`);
    this.addSql(`create index "itad_jobs_scope_customer_idx" on "itad_jobs" ("tenant_id", "organization_id", "customer_id");`);
    this.addSql(`create index "itad_jobs_scope_status_idx" on "itad_jobs" ("tenant_id", "organization_id", "status");`);
    this.addSql(`alter table "itad_jobs" add constraint "itad_jobs_internal_reference_unique" unique ("tenant_id", "organization_id", "internal_reference");`);

    this.addSql(`create table "itad_reference_sequences" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "kind" text not null, "year" int not null, "last_value" int not null default 0, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "itad_reference_sequences" add constraint "itad_reference_sequences_scope_unique" unique ("tenant_id", "organization_id", "kind", "year");`);
  }

}
