import type { WarpConfigInput } from "@/lib/types/warp";
/**
 * Validation helpers for the Warp settings form.
 *
 * These live outside the component because the form itself has no render
 * harness in this repo, and a rule that cannot be tested is a rule that quietly
 * stops holding.
 */

/**
 * Rejects a numeric field that was cleared rather than filled in.
 *
 * `valueAsNumber: true` hands React Hook Form `NaN` for an empty input, and RHF
 * treats the empty DOM value as "no value" and skips `min`/`max` entirely. With
 * nothing else checking, `NaN` reaches the PUT body, where `JSON.stringify`
 * writes it as `null` - so clearing the box silently sends null for a field the
 * server reads as a number.
 */
export function requireFiniteNumber(value: unknown, message: string): true | string {
	return isFiniteNumber(value) ? true : message;
}

/**
 * Narrows to a real, comparable number.
 *
 * The form parses its numeric inputs with `Number(...)`, and every comparison
 * against `NaN` is false - so a range check alone reports a non-numeric value
 * as valid. This is the guard that has to run before the range check, not after.
 */
export function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
/**
 * Checks a Warp base URL.
 *
 * A prefix test accepts "https://" with nothing after it, and the value is
 * handed to the provider config verbatim - so a scheme-only string is only
 * discovered on the first outbound call, long after the operator left this
 * page.
 */
export function isValidBaseURL(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	if (!parsed.hostname) return false;
	// The server rejects userinfo here, and for a good reason: this column is
	// stored unencrypted and read back unredacted, because Warp is designed to
	// hold a key reference and no secret of its own. Accepting it in the form
	// only to fail the save would teach operators the field takes credentials.
	return parsed.username === "" && parsed.password === "";
}