// Particle system definitions (.pcf): DMX binary (encoding versions 2 to 5).
// The file is a header line, a string table, then elements (type, name,
// GUID) and each element's typed attributes. Particle systems are
// DmeParticleSystemDefinition elements; their emitters, initializers,
// operators and renderers are DmeParticleOperator elements named by
// "functionName", with their settings as attributes.

export type DmxValue = number | boolean | string | number[] | DmxElement | null | (DmxElement | null)[] | string[] | number[][];

export interface DmxElement {
	type: string;
	name: string;
	attrs: Map<string, DmxValue>;
}

const AT = {
	ELEMENT: 1, INT: 2, FLOAT: 3, BOOL: 4, STRING: 5, VOID: 6, TIME: 7, COLOR: 8,
	VECTOR2: 9, VECTOR3: 10, VECTOR4: 11, QANGLE: 12, QUATERNION: 13, VMATRIX: 14,
	FIRST_ARRAY: 15,
} as const;

const VALUE_SIZE: Record<number, number> = {
	[AT.INT]: 4, [AT.FLOAT]: 4, [AT.BOOL]: 1, [AT.TIME]: 4, [AT.COLOR]: 4,
	[AT.VECTOR2]: 8, [AT.VECTOR3]: 12, [AT.VECTOR4]: 16, [AT.QANGLE]: 12, [AT.QUATERNION]: 16, [AT.VMATRIX]: 64,
};

export function readDmx(bytes: Uint8Array): DmxElement[] {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let p = bytes.indexOf(10);  // header line
	const header = new TextDecoder('latin1').decode(bytes.subarray(0, p));
	const m = /encoding binary (\d+)/.exec(header);
	if (!m) throw new Error('not a binary DMX file');
	const version = Number(m[1]);
	p++;
	if (bytes[p] === 0) p++;
	const cstr = () => {
		let end = p;
		while (end < bytes.length && bytes[end]) end++;
		const s = new TextDecoder('latin1').decode(bytes.subarray(p, end));
		p = end + 1;
		return s;
	};
	const i32 = () => {
		const x = v.getInt32(p, true);
		p += 4;
		return x;
	};
	const strings: string[] = [];
	if (version >= 2) {
		const n = version >= 4 ? i32() : (p += 2, v.getInt16(p - 2, true));
		for (let i = 0; i < n; i++) strings.push(cstr());
	}
	const symbol = () => {
		if (version >= 5) return strings[i32()] ?? '';
		p += 2;
		return strings[v.getUint16(p - 2, true)] ?? '';
	};

	const count = i32();
	const elements: DmxElement[] = [];
	for (let i = 0; i < count; i++) {
		const type = version >= 2 ? symbol() : cstr();
		const name = version >= 4 ? symbol() : cstr();
		p += 16;  // GUID
		elements.push({type, name, attrs: new Map()});
	}
	const element = (): DmxElement | null => {
		const index = i32();
		if (index === -2) {
			cstr();  // external element GUID
			return null;
		}
		return index >= 0 ? elements[index] ?? null : null;
	};
	const scalar = (type: number): DmxValue => {
		switch (type) {
		case AT.ELEMENT: return element();
		case AT.INT: return i32();
		case AT.FLOAT: p += 4; return v.getFloat32(p - 4, true);
		case AT.BOOL: return bytes[p++] !== 0;
		case AT.STRING: return version >= 4 ? symbol() : cstr();
		case AT.VOID: {
			const n = i32();
			p += n;
			return null;
		}
		case AT.TIME: return i32() / 10000;
		case AT.COLOR: p += 4; return [bytes[p - 4], bytes[p - 3], bytes[p - 2], bytes[p - 1]];
		default: {
			const size = VALUE_SIZE[type];
			if (!size) throw new Error(`DMX: unknown attribute type ${type}`);
			const out: number[] = [];
			for (let k = 0; k < size / 4; k++) out.push(v.getFloat32(p + k * 4, true));
			p += size;
			return out;
		}
		}
	};
	for (const el of elements) {
		const n = i32();
		for (let a = 0; a < n; a++) {
			const name = version >= 2 ? symbol() : cstr();
			const type = bytes[p++];
			if (type < AT.FIRST_ARRAY) {
				el.attrs.set(name, scalar(type));
				continue;
			}
			const base = type - AT.FIRST_ARRAY + 1;
			const len = i32();
			const list: DmxValue[] = [];
			for (let k = 0; k < len; k++) {
				// string arrays are always stored inline
				list.push(base === AT.STRING ? cstr() : scalar(base));
			}
			el.attrs.set(name, list as DmxValue);
		}
	}
	return elements;
}

// ---- particle systems ----

export interface ParticleOperator {
	fn: string;  // functionName, lower case
	params: Map<string, DmxValue>;
}

export interface ParticleChild {
	name: string;
	delay: number;
}

export interface ParticleSystemDef {
	name: string;
	material: string;
	maxParticles: number;
	initialParticles: number;
	color: number[];      // 0..255 rgba
	radius: number;
	rotation: number;
	sequence: number;
	emitters: ParticleOperator[];
	initializers: ParticleOperator[];
	operators: ParticleOperator[];
	renderers: ParticleOperator[];
	children: ParticleChild[];
	cullRadius: number;
}

const ops = (v: DmxValue | undefined): ParticleOperator[] =>
	(Array.isArray(v) ? v : []).filter((e): e is DmxElement => !!e && typeof e === 'object' && 'attrs' in e).map(e => ({
		fn: String(e.attrs.get('functionName') ?? e.name).toLowerCase(),
		params: e.attrs,
	}));

export function readParticleSystems(bytes: Uint8Array): ParticleSystemDef[] {
	const out: ParticleSystemDef[] = [];
	for (const el of readDmx(bytes)) {
		if (el.type !== 'DmeParticleSystemDefinition') continue;
		const a = el.attrs;
		const num = (k: string, d: number) => (typeof a.get(k) === 'number' ? a.get(k) as number : d);
		const children: ParticleChild[] = [];
		for (const c of (Array.isArray(a.get('children')) ? a.get('children') as (DmxElement | null)[] : [])) {
			const child = c?.attrs.get('child') as DmxElement | null | undefined;
			if (child) children.push({name: child.name, delay: Number(c!.attrs.get('delay') ?? 0)});
		}
		out.push({
			name: el.name,
			material: String(a.get('material') ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.vmt$/, ''),
			maxParticles: num('max_particles', 1000),
			initialParticles: num('initial_particles', 0),
			color: (a.get('color') as number[] | undefined) ?? [255, 255, 255, 255],
			radius: num('radius', 5),
			rotation: num('rotation', 0),
			sequence: num('sequence_number', 0),
			emitters: ops(a.get('emitters')),
			initializers: ops(a.get('initializers')),
			operators: ops(a.get('operators')),
			renderers: ops(a.get('renderers')),
			children,
			cullRadius: num('cull_radius', 0),
		});
	}
	return out;
}
