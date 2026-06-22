/** Feature J — addressable output. Per-session store of run records, oldest evicted. */

import { config } from "./config.js";
import type { RunRecord } from "./types.js";

const records = new Map<string, RunRecord>();
let counter = 0;

export function nextId(): string {
  return `cmd${++counter}`;
}

export function put(rec: RunRecord): void {
  records.set(rec.id, rec);
  if (config.maxRecords > 0) {
    while (records.size > config.maxRecords) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
    }
  }
}

export function get(id: string): RunRecord | undefined {
  return records.get(id);
}
