/** A per-process sliding-window limit, enough for one long-lived task. */
export function createRateLimiter(windowMs: number, maxRequests: number) {
	const log = new Map<string, number[]>();
	return (key: string): boolean => {
		const now = Date.now();
		const recent = (log.get(key) ?? []).filter((ts) => now - ts < windowMs);
		const limited = recent.length >= maxRequests;
		if (!limited) recent.push(now);
		log.set(key, recent);
		if (log.size > 5000) {
			for (const [entryKey, timestamps] of log) {
				if (timestamps.every((ts) => now - ts >= windowMs))
					log.delete(entryKey);
			}
		}
		return limited;
	};
}
