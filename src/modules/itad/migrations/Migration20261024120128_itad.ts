import { Migration } from '@mikro-orm/migrations';

export class Migration20261024120128_itad extends Migration {

  override name = 'Migration20261024120128';

  override up(): void | Promise<void> {
    this.addSql(`create table "itad_inbox_messages" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "source" text not null, "inbox_email_id" uuid null, "message_id" text null, "in_reply_to" text null, "from_address" text not null, "from_name" text null, "customer_address" text not null, "customer_name" text null, "forwarded_by_user_id" uuid null, "subject" text not null, "current_text" text not null, "thread_messages" jsonb not null, "received_at" timestamptz not null, "created_by_user_id" uuid null, "status" text not null default 'processing', "generation" int not null default 1, "processing_started_at" timestamptz null, "intents" jsonb not null, "match" jsonb null, "job_id" uuid null, "extraction" jsonb null, "summary" text null, "draft_reply" text null, "draft_generated_at" timestamptz null, "processing_error" jsonb null, "model" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "itad_inbox_messages_job_idx" on "itad_inbox_messages" ("tenant_id", "organization_id", "job_id");`);
    this.addSql(`create index "itad_inbox_messages_list_idx" on "itad_inbox_messages" ("tenant_id", "organization_id", "status", "received_at");`);
    this.addSql(`alter table "itad_inbox_messages" add constraint "itad_inbox_messages_inbox_email_unique" unique ("tenant_id", "inbox_email_id");`);

    this.addSql(`create table "itad_inbox_actions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "message_id" uuid not null, "generation" int not null, "ordinal" int not null, "type" text not null, "target" jsonb not null, "payload" jsonb not null, "original_payload" jsonb not null, "field_sources" jsonb not null, "match_status" text not null, "missing_fields" jsonb not null, "target_version" text null, "status" text not null default 'pending', "decided_by_user_id" uuid null, "decided_at" timestamptz null, "reject_reason" text null, "result" jsonb null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "itad_inbox_actions_message_idx" on "itad_inbox_actions" ("tenant_id", "organization_id", "message_id", "status");`);
    this.addSql(`alter table "itad_inbox_actions" add constraint "itad_inbox_actions_generation_unique" unique ("message_id", "generation", "ordinal");`);

    this.addSql(`alter table "itad_inbox_actions" add constraint "itad_inbox_actions_message_id_foreign" foreign key ("message_id") references "itad_inbox_messages" ("id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "itad_inbox_actions" drop constraint if exists "itad_inbox_actions_message_id_foreign";`);
    this.addSql(`drop table if exists "itad_inbox_actions" cascade;`);
    this.addSql(`drop table if exists "itad_inbox_messages" cascade;`);
  }

}
