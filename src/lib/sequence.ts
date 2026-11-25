import "server-only";
import type { Tx } from "./db";
import { dayKey } from "./date";

/** Atomic, gap-tolerant counter → unique human friendly numbers like PM-20261124-0007. */
export async function nextNumber(tx: Tx, prefix: string): Promise<string> {
  const day = dayKey(new Date()).replace(/-/g, "");
  const key = `${prefix}-${day}`;
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Counter" ("key", "value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "Counter"."value" + 1
    RETURNING "value"`;
  return `${prefix}-${day}-${String(rows[0].value).padStart(4, "0")}`;
}
