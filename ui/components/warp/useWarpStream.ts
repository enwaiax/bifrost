import { encodeTurnError, isEncodedTurnError, parseWarpFrame, splitWarpFrames, type WarpEvent } from "@/components/warp/warpStream.utils";
import type { WarpTurn, WarpTurnToolCall } from "@/lib/contexts/warpContext";
import { getApiBaseUrl } from "@/lib/utils/port";
import { useCallback, useRef, useState } from "react";

interface UseWarpStreamOptions {
	/** Called once the turn is complete, so the finished turn can join the conversation. */
	onTurnComplete: (turn: WarpTurn) => void;
}

interface UseWarpStreamResult {
	/** Text streamed so far for the in-flight answer. */
	streamingText: string;
	/** Tool calls made during the in-flight answer, in order. */
	streamingToolCalls: WarpTurnToolCall[];
	isStreaming: boolean;
	/** Terminal error for the in-flight turn, if it failed. */
	error: string | null;
	send: (history: WarpTurn[], question: string) => Promise<void>;
	/** Abandons the in-flight request and its partial answer. See discard(). */
	discard: () => void;
	stop: () => void;
}

/**
 * Drives one Warp request and exposes the in-flight answer.
 *
 * The streaming text lives here rather than in WarpProvider on purpose: a
 * context update re-renders every consumer, and pushing a state change per token
 * would repaint the topbar and the whole dashboard chrome dozens of times a
 * second. Only the finished turn is handed upward.
 */
export function useWarpStream({ onTurnComplete }: UseWarpStreamOptions): UseWarpStreamResult {
	const [streamingText, setStreamingText] = useState("");
	const [streamingToolCalls, setStreamingToolCalls] = useState<WarpTurnToolCall[]>([]);
	const [isStreaming, setIsStreaming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	// Identifies the request currently allowed to own the stream state. A second
	// send aborts the first, but the first still runs its finally block after
	// that - and without this guard it would null out the *new* controller
	// (leaving the live request unstoppable), flip isStreaming off underneath it,
	// and commit its own abandoned turn into the transcript.
	const requestIdRef = useRef(0);

	const stop = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
	}, []);

	/**
	 * Abandons the in-flight request outright.
	 *
	 * Distinct from stop(): stop only aborts, leaving requestIdRef untouched, so
	 * isCurrent() still passes and the completion path commits the partial answer
	 * it already has. That is right for "stop generating" - you keep what arrived
	 * - and wrong for New Chat, where warp.clear() empties the transcript and the
	 * abandoned turn is then appended straight back into it through appendTurn's
	 * functional update.
	 *
	 * Incrementing the id first is what makes the abort final: every later guard
	 * on that request sees a stale id and declines to write.
	 */
	const discard = useCallback(() => {
		requestIdRef.current++;
		abortRef.current?.abort();
		abortRef.current = null;
		setStreamingText("");
		setStreamingToolCalls([]);
		setIsStreaming(false);
		setError(null);
	}, []);

	const send = useCallback(
		async (history: WarpTurn[], question: string) => {
			stop();
			const controller = new AbortController();
			abortRef.current = controller;
			const requestId = ++requestIdRef.current;
			const isCurrent = () => requestIdRef.current === requestId;

			setStreamingText("");
			setStreamingToolCalls([]);
			setError(null);
			setIsStreaming(true);

			// Accumulated locally as well as in state: the state setters are async,
			// so the completion handler cannot read them back to build the turn.
			let text = "";
			let toolCalls: WarpTurnToolCall[] = [];
			let terminalError: string | null = null;

			const applyEvent = (event: WarpEvent) => {
				switch (event.type) {
					case "delta":
						text += event.delta ?? "";
						setStreamingText(text);
						break;
					case "tool_call_start":
						toolCalls = [...toolCalls, { id: event.tool_id ?? "", name: event.tool_name ?? "" }];
						setStreamingToolCalls(toolCalls);
						break;
					case "tool_call_end":
						toolCalls = toolCalls.map((call) =>
							call.id === event.tool_id ? { ...call, durationMs: event.duration_ms, failed: event.failed } : call,
						);
						setStreamingToolCalls(toolCalls);
						break;
					case "error":
						// An error frame is terminal on the server side and never followed
						// by done, so this is the end of the turn.
						// Encoded either way. A code-less frame whose message contains a
						// colon would otherwise have its first word read back as a code.
						terminalError = encodeTurnError(event.code, event.message ?? (event.code ? "" : "error"));
						break;
					default:
						break;
				}
			};

			try {
				const response = await fetch(`${getApiBaseUrl()}/warp/chat`, {
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					signal: controller.signal,
					body: JSON.stringify({
						messages: [...history.map((turn) => ({ role: turn.role, content: turn.content })), { role: "user", content: question }],
						stream: true,
					}),
				});

				if (!response.ok) {
					// 503 carries a machine-readable reason so the panel can distinguish
					// "not set up yet" from a real failure.
					let reason = "";
					try {
						reason = ((await response.json()) as { reason?: string }).reason ?? "";
					} catch {
						reason = "";
					}
					throw new Error(encodeTurnError(reason || undefined, reason ? "" : `Warp request failed (${response.status})`));
				}

				const reader = response.body?.getReader();
				if (!reader) throw new Error(encodeTurnError(undefined, "Warp returned no response body"));

				const decoder = new TextDecoder();
				let buffer = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const { frames, rest } = splitWarpFrames(buffer);
					buffer = rest;
					for (const frame of frames) {
						const event = parseWarpFrame(frame);
						if (event) applyEvent(event);
					}
				}
			} catch (caught) {
				// An abort is the user pressing stop, not a failure. The partial answer
				// is kept, because a half-written answer is often still useful.
				if (!(caught instanceof DOMException && caught.name === "AbortError")) {
					const raw = caught instanceof Error ? caught.message : "Warp request failed";
					// Encoded unless it already is. Checked against the known codes
					// rather than "has a colon", because a raw fetch failure reads
					// "TypeError: Failed to fetch" and its first word is not a code.
					terminalError = isEncodedTurnError(raw) ? raw : encodeTurnError(undefined, raw);
				}
			} finally {
				// A superseded request must leave the live one alone: no clearing its
				// controller, no flipping its streaming flag, and above all no
				// committing an abandoned turn into a transcript that has moved on.
				if (isCurrent()) {
					setIsStreaming(false);
					abortRef.current = null;
					onTurnComplete({
						role: "assistant",
						content: text,
						toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
						error: terminalError ?? undefined,
					});
					setStreamingText("");
					setStreamingToolCalls([]);
				}
			}
		},
		[onTurnComplete, stop],
	);

	return { streamingText, streamingToolCalls, isStreaming, error, send, stop, discard };
}