/// <reference types="@logseq/libs" />
import type { Action } from "../action";
import { debugLog, PREVIEW_TRUNCATION_LIMIT, truncate } from "../debug-log";
import { type LLMProvider, LLMProviderError } from "../provider";
import type { ResolvedSettings } from "./settings";

/**
 * Build the OpenAI-completions request body for a text action. Pulled out
 * of `run-action.ts` so the per-block / batched runners share the same
 * payload shape and the debug-log truncation stays in sync with the
 * actual request. The caller passes the text to send as the `user`
 * message; everything else (model, temperature, system prompt, timeout,
 * optional api key) is taken straight from the action + settings.
 */
export function buildProviderRequest(action: Action, llmInput: string, settings: ResolvedSettings) {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    system: action.systemPrompt,
    user: llmInput,
    temperature: settings.temperature,
    timeoutMs: settings.timeoutMs,
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
  };
}

/**
 * Format an LLM error for toast display. `LLMProviderError` already carries
 * a useful message; we tack on the HTTP status when present so the user
 * can tell CORS from 401 from a missing model.
 */
export function formatProviderError(err: unknown): string {
  if (err instanceof LLMProviderError) {
    return `${err.message}${err.details?.status ? ` (HTTP ${err.details.status})` : ""}`;
  }
  return (err as Error).message;
}

/**
 * Record a debug-log entry for a single LLM call. Skipped entirely when
 * the user hasn't enabled the debug log setting — the ring buffer
 * machinery is untouched. Caller passes the started-at timestamp, the
 * resolved text output (or undefined on error), and the formatted error
 * (or undefined on success).
 */
export function recordDebugEntry(
  action: Action,
  llmInput: string,
  settings: ResolvedSettings,
  startedAt: number,
  output: string | undefined,
  error: string | undefined,
): void {
  if (!settings.debugLog) return;
  debugLog.push({
    timestamp: startedAt,
    actionId: action.id,
    actionTitle: action.title,
    scope: action.scope,
    outputMode: action.outputMode,
    model: settings.model,
    baseUrl: settings.baseUrl,
    requestPreview: truncate(llmInput, PREVIEW_TRUNCATION_LIMIT),
    durationMs: Date.now() - startedAt,
    ...(output !== undefined
      ? { responsePreview: truncate(output, PREVIEW_TRUNCATION_LIMIT) }
      : {}),
    ...(error !== undefined ? { error } : {}),
  });
}

/**
 * `logseq.UI.closeMsg` throws when the key is unknown (e.g., the toast
 * timed out on its own). Wrap once and swallow — every call site treated
 * the throw as ignorable.
 */
export function closeBusyToast(key: string | number | null): void {
  if (key === null) return;
  try {
    logseq.UI.closeMsg(key as string);
  } catch {
    /* ignore — closeMsg throws on unknown key */
  }
}

/**
 * Run a single LLM call (streaming when `onChunk` is provided, one-shot
 * otherwise) and record a debug-log entry. Shared by every text-action
 * path so the debug-log shape stays identical regardless of which runner
 * invoked it (single-block, per-block, batched, replace, append, outline).
 *
 * `llmInput` is the exact text sent as the `user` message. Callers that
 * have a `ResolvedInput` can pass `input.llmInput`; the per-block / batched
 * runners pass the block's text directly.
 */
export async function performLLM(
  provider: LLMProvider,
  action: Action,
  llmInput: string,
  settings: ResolvedSettings,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const startedAt = Date.now();
  let output: string | undefined;
  let error: string | undefined;
  try {
    const req = buildProviderRequest(action, llmInput, settings);
    output = onChunk ? await provider.stream(req, onChunk) : await provider.complete(req);
    return output;
  } catch (err) {
    error = formatProviderError(err);
    throw err;
  } finally {
    recordDebugEntry(action, llmInput, settings, startedAt, output, error);
  }
}
