// Getting parsed data across to another thread cheaply: every typed array
// and DataView in a value handed over (transferred) rather than copied. A view
// onto part of a bigger buffer (a lump of a whole file, a file of a batched
// download) is first copied to a buffer of its own, or the whole bigger
// buffer would go along with it.
export function handOver<T>(value: T): {value: T; transfer: ArrayBuffer[]} {
	const buffers = new Set<ArrayBuffer>();
	const seen = new Set<object>();
	const own = (v: ArrayBufferView): ArrayBufferView => {
		if (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength) return v;
		const copy = new Uint8Array(v.byteLength);
		copy.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
		const Ctor = v.constructor as new (b: ArrayBuffer, o?: number, l?: number) => ArrayBufferView;
		return v instanceof DataView ? new DataView(copy.buffer) : new Ctor(copy.buffer, 0, v.byteLength / ((v as Uint8Array).BYTES_PER_ELEMENT ?? 1));
	};
	// (each view made whole where it sits, its buffer listed)
	const visit = (v: unknown): unknown => {
		if (!v || typeof v !== 'object') return v;
		if (ArrayBuffer.isView(v)) {
			const whole = own(v);
			buffers.add(whole.buffer as ArrayBuffer);
			return whole;
		}
		if (v instanceof ArrayBuffer) {
			buffers.add(v);
			return v;
		}
		if (seen.has(v)) return v;
		seen.add(v);
		if (v instanceof Map) {
			for (const [k, x] of v) v.set(k, visit(x));
		} else if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) v[i] = visit(v[i]);
		} else {
			const o = v as Record<string, unknown>;
			for (const k of Object.keys(o)) o[k] = visit(o[k]);
		}
		return v;
	};
	const out = visit(value) as T;
	return {value: out, transfer: [...buffers]};
}
