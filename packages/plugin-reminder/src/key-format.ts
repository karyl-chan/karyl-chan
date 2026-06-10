// Single source of truth for the reminder KV key format.
//
// Reminders are stored under `r:${dueAtMs padded to DUE_DIGITS}:${id}` so that
// lexical key order == chronological due order, which the scheduler relies on
// to scan the earliest-due reminders first. That invariant holds only while
// every `dueAtMs` is a fixed-width, decimal, <= DUE_DIGITS-digit integer — i.e.
// `0 <= dueAtMs < MAX_DUE_MS`. A larger value would be 14+ digits (and >= 1e21
// stringifies in exponential form), so its key sorts AHEAD of real reminders
// and starves the scan window — due reminders then silently never fire.
//
// parseWhen enforces the upper bound at ingestion. DUE_DIGITS=13 covers any ms
// timestamp before ~year 2286, well past any legitimate reminder.
export const KEY_PREFIX = "r:";
export const DUE_DIGITS = 13;
export const MAX_DUE_MS = 10 ** DUE_DIGITS;
