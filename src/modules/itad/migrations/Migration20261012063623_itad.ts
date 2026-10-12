import { Migration } from '@mikro-orm/migrations';

export class Migration20261012063623_itad extends Migration {

  override name = 'Migration20261012063623';

  override up(): void | Promise<void> {
    this.addSql(`create table "itad_job_pickup_tasks" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "interaction_id" uuid not null, "state" text not null, "is_current" boolean not null, "scheduled_at" timestamptz not null, "caused_by_user_id" uuid null, "last_synced_at" timestamptz null, "last_error" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create unique index "itad_job_pickup_tasks_current_unique" on "itad_job_pickup_tasks" ("tenant_id", "organization_id", "job_id") where "is_current";`);
    this.addSql(`create index "itad_job_pickup_tasks_job_idx" on "itad_job_pickup_tasks" ("tenant_id", "organization_id", "job_id", "created_at");`);
    this.addSql(`alter table "itad_job_pickup_tasks" add constraint "itad_job_pickup_tasks_interaction_unique" unique ("tenant_id", "organization_id", "interaction_id");`);

    this.addSql(`alter table "itad_jobs" add "pickup_coordinator_user_id" uuid null;`);

    this.addSql(`alter table "itad_job_pickup_tasks" add constraint "itad_job_pickup_tasks_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "itad_job_pickup_tasks" cascade;`);
    this.addSql(`alter table "itad_jobs" drop column "pickup_coordinator_user_id";`);
  }

}
