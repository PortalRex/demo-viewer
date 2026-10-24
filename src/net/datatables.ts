// Send tables and server classes (dem_datatables / svc_SendTable), and the
// flattened property list each class decodes with. Portal 2 = demo protocol 4.
import {BitReader} from '../core/readers.ts';

export const PropType = {INT: 0, FLOAT: 1, VEC3: 2, VEC2: 3, STRING: 4, ARRAY: 5, DT: 6} as const;

export const F = {
	UNSIGNED: 1 << 0,
	COORD: 1 << 1,
	NOSCALE: 1 << 2,
	NORMAL: 1 << 5,
	EXCLUDE: 1 << 6,
	INSIDEARRAY: 1 << 8,
	COLLAPSIBLE: 1 << 11,
	COORDMP: 1 << 12,
	COORDMPLP: 1 << 13,
	COORDMPINT: 1 << 14,
	CELLCOORD: 1 << 15,
	CELLCOORDLP: 1 << 16,
	CELLCOORDINT: 1 << 17,
	CHANGESOFTEN: 1 << 18,
} as const;

export interface SendProp {
	type: number;
	name: string;
	flags: number;
	priority: number;
	low: number;
	high: number;
	bits: number;
	elements: number;      // arrays
	dtName: string;        // data table props, and the table an exclude refers to
}

export interface SendTable {
	name: string;
	props: SendProp[];
}

export interface FlatProp {
	name: string;
	prop: SendProp;
	element?: SendProp;  // arrays: the element prop (the one before the array)
}

export interface ServerClass {
	id: number;
	name: string;
	table: string;
	flat: FlatProp[];
	index: Map<string, number>;  // prop name -> flat index
}

export interface DataTables {
	tables: Map<string, SendTable>;
	classes: ServerClass[];
	classBits: number;
}

export const highestBit = (v: number) => {
	let i = -1;
	while (v > 0) {
		v = Math.floor(v / 2);
		i++;
	}
	return i;
};

function readString(br: BitReader) {
	const out: number[] = [];
	for (;;) {
		const c = br.u(8);
		if (c === 0) break;
		out.push(c);
	}
	return String.fromCharCode(...out);
}
export {readString as readBitString};

export function parseDataTables(data: Uint8Array): DataTables {
	const br = new BitReader(data);
	const tables = new Map<string, SendTable>();
	while (br.bit()) {
		br.bit();  // needs decoder
		const name = readString(br);
		const n = br.u(10);
		const props: SendProp[] = [];
		for (let i = 0; i < n; i++) {
			const type = br.u(5);
			const pname = readString(br);
			const flags = br.u(19);
			const priority = br.u(8);
			const p: SendProp = {type, name: pname, flags, priority, low: 0, high: 0, bits: 0, elements: 0, dtName: ''};
			if (type === PropType.DT || flags & F.EXCLUDE) {
				p.dtName = readString(br);
			} else if (type === PropType.ARRAY) {
				p.elements = br.u(10);
			} else {
				p.low = br.f32();
				p.high = br.f32();
				p.bits = br.u(7);
			}
			props.push(p);
		}
		tables.set(name, {name, props});
	}
	const nClasses = br.u(16);
	const classes: ServerClass[] = [];
	for (let i = 0; i < nClasses; i++) {
		const id = br.u(16);
		const name = readString(br);
		const table = readString(br);
		classes.push({id, name, table, flat: [], index: new Map()});
	}
	for (const c of classes) {
		const t = tables.get(c.table);
		if (!t) continue;
		c.flat = flatten(tables, t);
		c.flat.forEach((f, i) => c.index.set(f.name, i));
	}
	return {tables, classes, classBits: highestBit(classes.length) + 1};
}

function flatten(tables: Map<string, SendTable>, root: SendTable): FlatProp[] {
	const excludes = new Set<string>();
	const gatherExcludes = (t: SendTable) => {
		for (const p of t.props) {
			if (p.type === PropType.DT) {
				const sub = tables.get(p.dtName);
				if (sub) gatherExcludes(sub);
			} else if (p.flags & F.EXCLUDE) {
				excludes.add(`${p.dtName}\0${p.name}`);
			}
		}
	};
	gatherExcludes(root);

	const out: FlatProp[] = [];
	const iterate = (t: SendTable, into: FlatProp[], prefix: string) => {
		t.props.forEach((p, i) => {
			if (p.flags & (F.EXCLUDE | F.INSIDEARRAY)) return;
			if (excludes.has(`${t.name}\0${p.name}`)) return;
			if (p.type === PropType.DT) {
				const sub = tables.get(p.dtName);
				if (!sub) return;
				if (p.flags & F.COLLAPSIBLE) iterate(sub, into, prefix);
				else gather(sub, p.name ? `${prefix}${p.name}.` : prefix);
			} else {
				into.push({name: prefix + p.name, prop: p, element: p.type === PropType.ARRAY ? t.props[i - 1] : undefined});
			}
		});
	};
	const gather = (t: SendTable, prefix: string) => {
		const into: FlatProp[] = [];
		iterate(t, into, prefix);
		out.push(...into);
	};
	gather(root, '');

	// priority sort (swap passes, as the engine does)
	const priorities = [...new Set([...out.map(f => f.prop.priority), 64])].sort((a, b) => a - b);
	let start = 0;
	for (const prio of priorities) {
		for (let i = start; i < out.length; i++) {
			const p = out[i].prop;
			if (p.priority === prio || (p.flags & F.CHANGESOFTEN && prio === 64)) {
				if (i !== start) [out[start], out[i]] = [out[i], out[start]];
				start++;
			}
		}
	}
	return out;
}
