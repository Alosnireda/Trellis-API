import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PermissionsGuard } from "src/common/guard/permissions.guard";
import { Role } from "src/common/guard/roles.enum";
import { CursorPaginationService } from "src/common/pagination/cursor-pagination.service";
import { SubmissionHistoryController } from "../submission-history.controller";
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  SubmissionHistoryService,
} from "./submission-history.service";

/*
 * Bounded keyset pagination over oracle submission history (#334): query
 * shape, bounds, cursor handling and authorization. The real-Postgres
 * behaviour (microsecond collisions, concurrent inserts) is covered by
 * submission-history.pagination.pg.spec.ts.
 */

function row(n: number, createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 1000 - n))) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return { id, createdAt, payloadHash: "a".repeat(64), submitter: "G" + "A".repeat(55) };
}

function fakeQueryBuilder(rows: unknown[]) {
  const qb: any = {
    calls: [] as Array<[string, ...unknown[]]>,
  };
  for (const method of ["orderBy", "addOrderBy", "limit", "andWhere"])
    qb[method] = jest.fn((...args: unknown[]) => {
      qb.calls.push([method, ...args]);
      return qb;
    });
  qb.getMany = jest.fn(async () => rows);
  return qb;
}

describe("SubmissionHistoryService.historyPage (#334)", () => {
  let qb: any;
  let repository: any;
  let service: SubmissionHistoryService;
  const setRows = (rows: unknown[]) => {
    qb = fakeQueryBuilder(rows);
    repository = { createQueryBuilder: jest.fn(() => qb) };
    service = new SubmissionHistoryService(repository);
  };

  beforeEach(() => setRows([]));

  describe("normal path", () => {
    it("reads at most limit + 1 rows in a stable millisecond-truncated order", async () => {
      await service.historyPage();
      expect(qb.calls).toEqual([
        ["orderBy", `date_trunc('milliseconds', history."createdAt")`, "DESC"],
        ["addOrderBy", "history.id", "DESC"],
        ["limit", DEFAULT_HISTORY_PAGE_SIZE + 1],
      ]);
    });

    it("returns a cursor at the last item only when more rows exist", async () => {
      const rows = [row(1), row(2), row(3)];
      setRows(rows);
      const page = await service.historyPage({ limit: 2 });
      expect(page.items).toEqual(rows.slice(0, 2));
      expect(page.hasMore).toBe(true);
      expect(new CursorPaginationService().decode(page.nextCursor!)).toEqual({
        createdAt: rows[1].createdAt,
        id: rows[1].id,
      });

      setRows(rows.slice(0, 2));
      expect(await service.historyPage({ limit: 2 })).toMatchObject({ hasMore: false, nextCursor: null });
    });

    it("applies the cursor and filters as bound parameters", async () => {
      const cursor = new CursorPaginationService().encode({ createdAt: row(5).createdAt, id: row(5).id });
      await service.historyPage({ cursor, status: "pending", submitter: "G" + "B".repeat(55) });
      const wheres = qb.calls.filter(([m]: [string]) => m === "andWhere");
      expect(wheres).toEqual([
        ["andWhere", "history.verificationStatus = :status", { status: "pending" }],
        ["andWhere", "history.submitter = :submitter", { submitter: "G" + "B".repeat(55) }],
        [
          "andWhere",
          expect.stringContaining(`date_trunc('milliseconds', history."createdAt") < :cursorCreatedAt`),
          { cursorCreatedAt: row(5).createdAt, cursorId: row(5).id },
        ],
      ]);
    });
  });

  describe("failure path", () => {
    it.each([0, -1, MAX_HISTORY_PAGE_SIZE + 1, 1.5])("rejects limit %p", async (limit) => {
      await expect(service.historyPage({ limit })).rejects.toBeInstanceOf(BadRequestException);
      expect(qb.getMany).not.toHaveBeenCalled();
    });

    it.each([
      ["a malformed cursor", { cursor: "not a cursor" }],
      ["an oversized cursor", { cursor: "A".repeat(600) }],
      ["an unknown status", { status: "deleted" as any }],
      ["a malformed submitter", { submitter: "nope" }],
    ])("rejects %s with 400 before querying", async (_label, query) => {
      await expect(service.historyPage(query)).rejects.toBeInstanceOf(BadRequestException);
      expect(qb.getMany).not.toHaveBeenCalled();
    });
  });

  describe("retry path", () => {
    it("returns the same page for the same cursor (cursors are stateless)", async () => {
      const rows = [row(1), row(2), row(3)];
      setRows(rows);
      const first = await service.historyPage({ limit: 2 });
      const again = await service.historyPage({ limit: 2 });
      expect(again).toEqual(first);
    });
  });

  it("keeps the deprecated offset contract unchanged", async () => {
    repository.find = jest.fn().mockResolvedValue([]);
    await service.history(10, 20);
    expect(repository.find).toHaveBeenCalledWith({
      order: { createdAt: "DESC", id: "DESC" },
      take: 10,
      skip: 20,
    });
  });
});

describe("SubmissionHistoryController.historyPage authorization (#334)", () => {
  const guard = new PermissionsGuard(new Reflector());
  const allowed = (role: Role) => {
    const context: any = {
      getHandler: () => SubmissionHistoryController.prototype.historyPage,
      getClass: () => SubmissionHistoryController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: "u", role } }) }),
    };
    try {
      return guard.canActivate(context);
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  };

  it.each([
    [Role.OPERATOR, true],
    [Role.USER, false],
  ])("authorizes %s: %s", (role, expected) => {
    expect(allowed(role)).toBe(expected);
  });

  it("delegates to the service with parsed query parameters", async () => {
    const historyService = { historyPage: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new SubmissionHistoryController(historyService as any, {} as any, {} as any);
    await controller.historyPage(25, "c", "verified", undefined);
    expect(historyService.historyPage).toHaveBeenCalledWith({
      cursor: "c",
      limit: 25,
      status: "verified",
      submitter: undefined,
    });
  });
});
