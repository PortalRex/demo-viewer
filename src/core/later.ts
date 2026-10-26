// Timers that keep time in a hidden page. Browsers throttle a background
// page's setTimeout to a second or even a minute, and stop its frame
// callbacks, which stalls loading and scripted captures; message-channel
// tasks aren't throttled, so a hidden page waits by yielding through them.

// run `fn` after the current task (setTimeout(fn, 0) without the clamp)
export function soon(fn: () => void) {
	const c = new MessageChannel();
	c.port1.onmessage = () => {
		c.port1.close();
		fn();
	};
	c.port2.postMessage(0);
}

// run `fn` in `ms` milliseconds; returns a cancel function
export function later(fn: () => void, ms: number): () => void {
	if (typeof document === 'undefined' || !document.hidden) {
		const id = setTimeout(fn, ms);
		return () => clearTimeout(id);
	}
	const end = performance.now() + ms;
	let cancelled = false;
	const tick = () => {
		if (cancelled) return;
		if (performance.now() >= end) fn();
		else soon(tick);
	};
	soon(tick);
	return () => {
		cancelled = true;
	};
}
