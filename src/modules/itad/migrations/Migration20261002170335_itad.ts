import { Migration } from '@mikro-orm/migrations';

export class Migration20261002170335_itad extends Migration {

  override name = 'Migration20261002170335';

  override up(): void | Promise<void> {
    this.addSql(`create table "itad_job_status_transitions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "action" text not null, "from_status" text not null, "to_status" text not null, "reason" text null, "actor_user_id" uuid not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "itad_job_status_transitions_scope_job_idx" on "itad_job_status_transitions" ("tenant_id", "organization_id", "job_id", "created_at");`);

    this.addSql(`create table "itad_job_condition_confirmations" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "job_id" uuid not null, "transition_id" uuid not null, "condition" text not null, "comment" text not null, "confirmed_by_user_id" uuid not null, "confirmed_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "itad_job_condition_confirmations_scope_job_idx" on "itad_job_condition_confirmations" ("tenant_id", "organization_id", "job_id");`);

    this.addSql(`alter table "itad_job_status_transitions" add constraint "itad_job_status_transitions_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);

    this.addSql(`alter table "itad_job_condition_confirmations" add constraint "itad_job_condition_confirmations_job_id_foreign" foreign key ("job_id") references "itad_jobs" ("id");`);
    this.addSql(`alter table "itad_job_condition_confirmations" add constraint "itad_job_condition_confirmations_transition_id_foreign" foreign key ("transition_id") references "itad_job_status_transitions" ("id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "itad_job_condition_confirmations" drop constraint if exists "itad_job_condition_confirmations_transition_id_foreign";`);
  }

}
