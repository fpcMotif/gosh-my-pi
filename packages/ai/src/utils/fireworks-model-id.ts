/**
 * Stub for Fireworks model id translation.
 *
 * The original helper rewrote model ids into Fireworks' wire format (e.g.
 * `accounts/fireworks/models/<id>`). The migration removed it; this stub keeps
 * the call site loadable by passing the id through unchanged. Anyone using
 * Fireworks should restore the real translation.
 */
export function toFireworksWireModelId(modelId: string): string {
	return modelId;
}
