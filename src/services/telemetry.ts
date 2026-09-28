import type { CustomerProfile, MiaDecision } from "../types.js";
import type { SignalCase } from "./signals.js";
import type { BloomreachWriteLog } from "../integrations/gemini.js";

/**
 * One real turn's full reasoning trail — the signal case Mia was handed and
 * the decision she actually made from it, including every `hold_back` that
 * never became a visible message. Exists purely for the admin/troubleshooting
 * panel (public/admin.html); nothing in the actual chat flow reads this back.
 * In-memory only, same lifetime/scope as the session store itself (see
 * chat.ts) — a demo troubleshooting aid, not an audit log that needs to
 * survive a restart.
 */
export interface TurnLog {
  id: string;
  sessionId: string;
  customerId: string;
  identityTier: string;
  timestamp: string;
  durationMs: number;
  isProactive: boolean;
  customerMessage?: string;
  signalCase: SignalCase;
  decision: MiaDecision;
  spoke: boolean;
  replyText?: string;
  chips?: string[];
  pendingCartAddsCount: number;
  cart: { totalQuantity: number; totalAmount: number } | null;
  /** The real Bloomreach profile this turn's decision was made with — a snapshot at decision time, not re-fetched here. Answers "did the known-identity read actually reach Mia." */
  profile: CustomerProfile | null;
  /** Every real Bloomreach write attempted this turn (log_event tool calls plus the phase B writeBack), success or failure. */
  bloomreachWrites: BloomreachWriteLog[];
  /** enforceGuardrails' own violations list — real things the model claimed or requested that ground truth didn't back up, and that were dropped before the shopper ever saw them (or, for a writeBack, before Bloomreach did). Empty is the expected case. */
  violations: string[];
}

// A demo/troubleshooting ring buffer, not a real log store — bounded so a
// long-running session never grows this unboundedly.
const MAX_LOGS = 500;
const logs: TurnLog[] = [];
let nextId = 1;

export function recordTurnLog(entry: Omit<TurnLog, "id">): void {
  logs.push({ id: String(nextId++), ...entry });
  if (logs.length > MAX_LOGS) logs.shift();
}

export function getTurnLogs(opts: { sessionId?: string; limit?: number } = {}): TurnLog[] {
  let result = logs;
  if (opts.sessionId) result = result.filter((l) => l.sessionId === opts.sessionId);
  const limit = opts.limit ?? 200;
  return result.slice(-limit).reverse();
}
