/** LLM triage abstraction — one call per email, summary + classification. */

export interface TriageInput {
  fromName: string;
  fromAddress: string;
  subject: string;
  bodyText: string;
  /** The user's own classification instructions (may be empty). */
  instructions?: string;
}

/** Matches the shared Priority type ("urgent" | "important" | "everything"). */
export type TriagePriority = "urgent" | "important" | "everything";

export interface TriageResult {
  /** One-sentence gist of the message. */
  summary: string;
  priority: TriagePriority;
  /** True when a human reply/decision is genuinely required. */
  needsAttention: boolean;
  /** Short action label for urgent items, e.g. "Reply now". */
  suggestedAction?: string;
}

export interface LlmProvider {
  readonly name: string;
  triage(input: TriageInput): Promise<TriageResult>;
}

export const PRIORITIES: readonly TriagePriority[] = ["urgent", "important", "everything"];

export function normalizePriority(value: unknown): TriagePriority {
  const s = String(value ?? "").toLowerCase().trim();
  if (s === "urgent" || s === "important") return s;
  return "everything";
}

/** Clamp a model-produced summary to one reasonable sentence. */
export function normalizeSummary(value: unknown, fallback: string): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return fallback;
  return s.length > 240 ? s.slice(0, 237) + "…" : s;
}
