import { Migration } from '@mikro-orm/migrations';

export class Migration20261026085326_itad extends Migration {

  override name = 'Migration20261026085326';

  override up(): void | Promise<void> {
    this.addSql(`alter table "itad_inbox_messages" add "reply_sent_at" timestamptz null, add "reply_sent_by_user_id" uuid null, add "reply_send_claimed_at" timestamptz null, add "reply_to_address" text null, add "reply_subject" text null, add "reply_body" text null, add "reply_error" jsonb null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "itad_inbox_messages" drop column "reply_sent_at", drop column "reply_sent_by_user_id", drop column "reply_send_claimed_at", drop column "reply_to_address", drop column "reply_subject", drop column "reply_body", drop column "reply_error";`);
  }

}
