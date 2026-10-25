/** Local lease supervision shared by analysis and graph build claims. */

export const LEASE_LOST = "Runner lease lost; analysis was stopped";

/**
 * Sequential heartbeats with a local lease deadline. Aborts `signal` on an
 * explicit heartbeat failure or when no heartbeat has succeeded within two
 * thirds of the lease, so a hung transport cannot hide lease loss.
 */
export function startLeaseWatchdog(
	beat: () => Promise<unknown>,
	leaseSeconds: number,
	initialSentAt: number,
	lostMessage = LEASE_LOST,
): { signal: AbortSignal; stop(): void } {
	const controller = new AbortController();
	const leaseMs = leaseSeconds * 1_000;
	const intervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
	const deadlineMs = Math.max(intervalMs * 2, Math.floor((leaseMs * 2) / 3));
	let stopped = false;
	let beatTimer: ReturnType<typeof setTimeout> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	// `cause` keeps a rejected heartbeat's detail for the failure report.
	const fence = (cause?: unknown) => {
		if (!controller.signal.aborted) {
			controller.abort(
				cause === undefined
					? new Error(lostMessage)
					: new Error(lostMessage, { cause }),
			);
		}
		stop();
	};
	// The server extends the lease when it processes a heartbeat, so the
	// deadline runs from when that heartbeat was sent, not when it was answered.
	const armDeadline = (sentAt: number) => {
		clearTimeout(deadlineTimer);
		const remaining = deadlineMs - (Date.now() - sentAt);
		if (remaining <= 0) {
			fence();
			return;
		}
		deadlineTimer = setTimeout(() => fence(), remaining);
	};
	const schedule = () => {
		beatTimer = setTimeout(() => {
			const sentAt = Date.now();
			beat().then(() => {
				if (stopped) return;
				armDeadline(sentAt);
				if (!stopped) schedule();
			}, fence);
		}, intervalMs);
	};
	const stop = () => {
		stopped = true;
		clearTimeout(beatTimer);
		clearTimeout(deadlineTimer);
	};
	armDeadline(initialSentAt);
	schedule();
	return { signal: controller.signal, stop };
}
