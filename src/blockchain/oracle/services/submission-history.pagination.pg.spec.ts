import { randomUUID } from "crypto";
import { Client } from "pg";
import { DataSource } from "typeorm";
import { SubmissionHistory } from "../entities/submission-history.entity";
import { OracleSubmissionHistory1790630401000 } from "../../../migrations/1790630401000-oracle-submission-history";
import { AddOracleHistoryKeysetIndex1792346400000 } from "../../../migrations/1792346400000-add-oracle-history-keyset-index";
import { SubmissionHistoryService } from "./submission-history.service";

/*
 * Real-Postgres verification of bounded history pagination (#334). Opt-in:
 *
 *   ORACLE_HISTORY_PG_URL=postgres://localhost:5432/postgres \
 *     npx jest src/blockchain/oracle/services/submission-history.pagination.pg.spec.ts
 *
 * Runs in a throwaway schema that is dropped afterwards.
 */

const url = process.env.ORACLE_HISTORY_PG_URL;
const describePg = url ? describe : describe.skip;

describePg("oracle submission history keyset pagination on Postgres (#334)", () => {
  const schema = `history_page_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: Client;
  let dataSource: DataSource;
  let service: SubmissionHistoryService;

  const hex = (n: number, salt: string) => (salt + n.toString(16)).padStart(64, "0");
  async function insert(n: number, createdAt: string, status = "pending") {
    await dataSource.query(
      `INSERT INTO "oracle_submission_history"
         ("payloadHash", "submitter", "transactionHash", "verificationStatus", "createdAt")
       VALUES ($1, $2, $3, $4, $5::timestamp)`,
      [hex(n, "a"), "G" + "A".repeat(55), hex(n, "b"), status, createdAt],
    );
  }
  async function drain(limit: number, filter: { status?: any } = {}) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 1000; pages++) {
      const page = await service.historyPage({ ...filter, limit, cursor });
      expect(page.items.length).toBeLessThanOrEqual(limit);
      seen.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) return seen;
      cursor = page.nextCursor;
    }
    throw new Error("pagination did not terminate");
  }
  async function expectedOrder(where = "") {
    const rows = await dataSource.query(
      `SELECT id FROM "oracle_submission_history" ${where}
       ORDER BY date_trunc('milliseconds', "createdAt") DESC, id DESC`,
    );
    return rows.map((r: { id: string }) => r.id);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    dataSource = new DataSource({
      type: "postgres",
      url,
      entities: [SubmissionHistory],
      extra: { options: `-c search_path=${schema},public` },
    });
    await dataSource.initialize();
    const runner = dataSource.createQueryRunner();
    await new OracleSubmissionHistory1790630401000().up(runner);
    await new AddOracleHistoryKeysetIndex1792346400000().up(runner);
    await runner.release();
    service = new SubmissionHistoryService(dataSource.getRepository(SubmissionHistory));
  });

  afterAll(async () => {
    await dataSource?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await dataSource.query(`TRUNCATE "oracle_submission_history"`);
  });

  it("never skips or duplicates rows that share a millisecond but differ in microseconds", async () => {
    // 30 rows across 3 milliseconds with distinct microseconds — the case a
    // raw (createdAt, id) keyset with a millisecond cursor gets wrong.
    for (let n = 0; n < 30; n++)
      await insert(n, `2026-11-20 12:00:00.${String(100 + (n % 3)).padStart(3, "0")}${String(n).padStart(3, "0")}`);
    const expected = await expectedOrder();
    for (const limit of [1, 2, 7, 30, 100]) {
      const seen = await drain(limit);
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(30);
    }
  });

  it("stays stable when rows are inserted between page requests", async () => {
    for (let n = 0; n < 20; n++) await insert(n, `2026-11-20 12:00:${String(n).padStart(2, "0")}.000000`);
    const original = await expectedOrder();

    const first = await service.historyPage({ limit: 5 });
    for (let n = 100; n < 110; n++) await insert(n, `2026-11-20 13:00:00.${String(n).padStart(6, "0")}`);
    const rest: string[] = [];
    let cursor = first.nextCursor ?? undefined;
    while (cursor) {
      const page = await service.historyPage({ limit: 5, cursor });
      rest.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect([...first.items.map((i) => i.id), ...rest]).toEqual(original);
  });

  it("applies status filters consistently across pages", async () => {
    for (let n = 0; n < 24; n++)
      await insert(n, `2026-11-20 12:00:00.${String(n).padStart(6, "0")}`, n % 3 === 0 ? "verified" : "pending");
    expect(await drain(4, { status: "verified" })).toEqual(
      await expectedOrder(`WHERE "verificationStatus" = 'verified'`),
    );
  });

  it("serves pages from the keyset index", async () => {
    for (let n = 0; n < 50; n++) await insert(n, `2026-11-20 12:00:00.${String(n).padStart(6, "0")}`);
    await dataSource.query(`ANALYZE "oracle_submission_history"`);
    const runner = dataSource.createQueryRunner();
    await runner.query(`SET enable_seqscan = off`);
    const plan = await runner.query(
      `EXPLAIN SELECT * FROM "oracle_submission_history" history
       WHERE (date_trunc('milliseconds', history."createdAt") < now()::timestamp)
       ORDER BY date_trunc('milliseconds', history."createdAt") DESC, history.id DESC LIMIT 51`,
    );
    await runner.release();
    expect(JSON.stringify(plan)).toContain("IDX_oracle_history_keyset");
  });

  it("migration is idempotent and reversible", async () => {
    const runner = dataSource.createQueryRunner();
    const migration = new AddOracleHistoryKeysetIndex1792346400000();
    await migration.up(runner);
    await migration.down(runner);
    await migration.down(runner);
    const after = await runner.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'IDX_oracle_history_keyset'`,
      [schema],
    );
    expect(after).toHaveLength(0);
    await migration.up(runner);
    await runner.release();
  });
});
