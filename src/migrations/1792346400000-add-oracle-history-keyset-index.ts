import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Keyset index for bounded oracle submission history pagination (#334).
 *
 * Matches the ORDER BY of SubmissionHistoryService.historyPage exactly
 * (millisecond-truncated createdAt, then id, both descending) so each page is
 * a single index range scan. date_trunc on `timestamp` (without time zone) is
 * immutable, so it is indexable.
 *
 * Additive and idempotent: on very large tables operators may pre-create the
 * index with CREATE INDEX CONCURRENTLY under the same name, after which this
 * migration is a no-op. See docs/BOUNDED_EVENT_PAGINATION.md.
 */
export class AddOracleHistoryKeysetIndex1792346400000 implements MigrationInterface {
  name = "AddOracleHistoryKeysetIndex1792346400000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_oracle_history_keyset" ON "oracle_submission_history" ` +
        `((date_trunc('milliseconds', "createdAt")) DESC, "id" DESC)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_oracle_history_keyset"`);
  }
}
