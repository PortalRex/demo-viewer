// Decodes a segment's network data into every entity's state over time.
//
// Demos carry entities in svc_PacketEntities. Proofs carry them there too in
// co-op, and as ENTITIES records in single player (where the game's local
// backdoor skips the network); there the packets' own svc_PacketEntities are
// ignored, as the converter does.
import {BitReader} from '../core/readers.ts';
import type {NetRecord, Segment, Vec3} from '../core/model.ts';
import {parseDataTables, F} from './datatables.ts';
import type {DataTables, ServerClass} from './datatables.ts';
import {readEntityProps, readUBitInt} from './props.ts';
import type {PropValue} from './props.ts';
import {walkPacket} from './messages.ts';
import type {PacketEntitiesHeader} from './messages.ts';
import {readStringTableSnapshot} from './stringtables.ts';
import {readPaintMessage, readPaintmap} from './paint.ts';
import type {PaintEvent} from './paint.ts';
import type {StringTable} from './stringtables.ts';

const MAX_EDICT_BITS = 11;
const MAX_COORD = 16384;
const EF_NODRAW = 32;

export interface EntityKey {
	tick: number;
	origin: Vec3;
	angles: Vec3;
	visible: boolean;  // in the snapshot and not EF_NODRAW
	active?: boolean;  // portals: m_bActivated
	eyeZ?: number;     // players: view offset height
	anim?: AnimState;  // animated models
	extra?: Record<string, PropValue>;  // class-specific props (EXTRA_PROPS)
	// attached to another entity: origin/angles are then relative to the
	// parent (or to one of its model's attachments, 1-based)
	parent?: number;
	attachment?: number;
	skin?: number;     // m_nSkin (cube types, lit cubes and buttons)
}

// Props kept for the classes the 3D view draws specially
export const EXTRA_PROPS: Record<string, string[]> = {
	CProp_Portal: ['m_hLinkedPortal', 'm_fNetworkHalfWidth', 'm_fNetworkHalfHeight'],
	CPortalLaser: ['m_vStartPoint', 'm_vEndPoint', 'm_bLaserOn'],
	CProjectedWallEntity: ['m_vecStartPoint', 'm_vecEndPoint', 'm_flWidth', 'm_flHeight'],
	CProjectedTractorBeamEntity: ['m_vecStartPoint', 'm_vecEndPoint'],
	CTrigger_TractorBeam: ['m_vStart', 'm_vEnd', 'm_flRadius', 'm_bReversed', 'm_bDisabled'],
	CTriggerPortalCleanser: ['m_bDisabled', 'm_bVisible'],
	// which fog and tonemap controllers apply to the player
	CPortal_Player: ['m_PlayerFog.m_hCtrl', 'localdata.m_hTonemapController'],
	CFogController: ['m_fog.enable', 'm_fog.colorPrimary', 'm_fog.start', 'm_fog.end', 'm_fog.maxdensity', 'm_fog.HDRColorScale'],
	CEnvTonemapController: ['m_bUseCustomAutoExposureMin', 'm_bUseCustomAutoExposureMax', 'm_flCustomAutoExposureMin', 'm_flCustomAutoExposureMax'],
};

export interface AnimState {
	sequence: number;
	cycle: number;        // 0..1; only meaningful when !clientSide
	rate: number;         // playback rate
	clientSide: boolean;  // the client advances the cycle itself
	parity: number;       // m_nNewSequenceParity: changes when the sequence restarts
}

export interface EntityTrack {
	index: number;
	className: string;
	model: string;
	mins: Vec3;
	maxs: Vec3;
	orange?: boolean;   // portals
	keys: EntityKey[];
}

export interface EntityTimeline {
	tracks: EntityTrack[];
	classCounts: Map<string, number>;
	errors: string[];
	player?: EntityTrack;
	paint: PaintEvent[];
	lightStyles: LightStyleChange[];  // in tick order
}

// a light style's pattern ("lightstyles" string table entry = style number)
export interface LightStyleChange {
	tick: number;
	style: number;
	pattern: string;
}

// per-class indices of the props the viewer uses
interface ClassFields {
	cls: ServerClass;
	origin: number;
	origins: {origin: number; z: number}[];  // every origin copy the class has         // m_vecOrigin (vec3, or vec2 with originZ)
	originZ: number;        // m_vecOrigin[2]
	cell: [number, number, number, number];  // m_cellbits, m_cellX/Y/Z
	cellOrigin: boolean;    // m_vecOrigin is cell-relative
	angles: number;         // m_angRotation
	eyePitch: number;       // players: m_angEyeAngles[0], [1]
	eyeYaw: number;
	viewOffset: number;     // players: m_vecViewOffset (vec3) or its [2]
	viewOffsetIsVec: boolean;
	sequence: number;
	cycle: number;
	rate: number;
	clientSide: number;
	parity: number;
	extra: [string, number][];
	model: number;          // m_nModelIndex
	effects: number;        // m_fEffects
	mins: number;
	maxs: number;
	activated: number;      // portals
	moveParent: number;     // moveparent (EHANDLE)
	parentAttachment: number;
	skin: number;
	isPortal2: number;
}

const find = (c: ServerClass, ...names: string[]) => {
	for (const n of names) {
		const i = c.index.get(n);
		if (i !== undefined) return i;
	}
	return -1;
};

// players send their origin as x/y plus a separate z, in the owner's
// local data (or the non-local copy other clients get)
const ORIGIN_SOURCES = ['m_vecOrigin', 'portallocaldata.m_vecOrigin', 'localdata.m_vecOrigin', 'portalnonlocaldata.m_vecOrigin', 'nonlocaldata.m_vecOrigin'];

function fieldsFor(cls: ServerClass): ClassFields {
	const src = ORIGIN_SOURCES.find(n => cls.index.has(n));
	const origin = src ? cls.index.get(src)! : -1;
	// players have two copies: the owner's (local) and everyone else's
	const origins = ORIGIN_SOURCES.filter(n => cls.index.has(n)).map(n => ({origin: cls.index.get(n)!, z: find(cls, `${n}[2]`)}));
	return {
		cls,
		origin,
		origins,
		originZ: src ? find(cls, `${src}[2]`) : -1,
		eyePitch: find(cls, 'm_angEyeAngles[0]'),
		eyeYaw: find(cls, 'm_angEyeAngles[1]'),
		viewOffset: find(cls, 'portallocaldata.m_vecViewOffset', 'localdata.m_vecViewOffset', 'portalnonlocaldata.m_vecViewOffset[2]', 'm_vecViewOffset[2]'),
		viewOffsetIsVec: cls.index.has('portallocaldata.m_vecViewOffset') || cls.index.has('localdata.m_vecViewOffset'),
		sequence: find(cls, 'm_nSequence'),
		cycle: find(cls, 'serveranimdata.m_flCycle', 'm_flCycle'),
		rate: find(cls, 'm_flPlaybackRate'),
		clientSide: find(cls, 'm_bClientSideAnimation'),
		parity: find(cls, 'm_nNewSequenceParity'),
		extra: (EXTRA_PROPS[cls.name] ?? []).map(n => [n, cls.index.get(n) ?? -1] as [string, number]).filter(([, i]) => i >= 0),
		cell: [find(cls, 'm_cellbits'), find(cls, 'm_cellX'), find(cls, 'm_cellY'), find(cls, 'm_cellZ')],
		cellOrigin: origin >= 0 && (cls.flat[origin].prop.flags & (F.CELLCOORD | F.CELLCOORDLP | F.CELLCOORDINT)) !== 0,
		angles: find(cls, 'm_angRotation', 'm_angAbsRotation'),
		model: find(cls, 'm_nModelIndex'),
		effects: find(cls, 'm_fEffects'),
		mins: find(cls, 'm_Collision.m_vecMins', 'm_vecMins'),
		maxs: find(cls, 'm_Collision.m_vecMaxs', 'm_vecMaxs'),
		activated: find(cls, 'm_bActivated'),
		moveParent: find(cls, 'moveparent', 'm_hMoveParent'),
		parentAttachment: find(cls, 'm_iParentAttachment'),
		skin: find(cls, 'm_nSkin'),
		isPortal2: find(cls, 'm_bIsPortal2'),
	};
}

interface LiveEntity {
	classIndex: number;
	serial: number;
	state: PropValue[];
	track: EntityTrack;
	inSnapshot: boolean;
	originCopy?: number;  // which of the class's origin copies this entity gets sent (players)
}

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' ? v : d);
const vec = (v: PropValue | undefined): number[] | undefined => (Array.isArray(v) && typeof v[0] === 'number' ? (v as number[]) : undefined);

export function decodeEntities(seg: Segment, dataTablesBlob: Uint8Array): EntityTimeline {
	const dt: DataTables = parseDataTables(dataTablesBlob);
	const fields = dt.classes.map(fieldsFor);
	const errors: string[] = [];
	const tables: StringTable[] = [];
	const tableByName = new Map<string, StringTable>();
	const live = new Map<number, LiveEntity>();
	const baselines: [Map<number, {classIndex: number; state: PropValue[]}>, Map<number, {classIndex: number; state: PropValue[]}>] = [new Map(), new Map()];
	const instanceBaselines = new Map<number, PropValue[]>();
	const tracks: EntityTrack[] = [];
	const classCounts = new Map<string, number>();
	const backdoorSeen = seg.net.some(r => r.kind === 'entities');
	const paint: PaintEvent[] = [];
	const lightStyles: LightStyleChange[] = [];
	const stylePatterns = new Map<number, string>();
	let tableTick = 0;

	const modelName = (index: number) => tableByName.get('modelprecache')?.entries[index]?.name ?? '';

	// class baselines are decoded on first use and dropped when the table changes
	const instanceBaseline = (classIndex: number): PropValue[] => {
		let b = instanceBaselines.get(classIndex);
		if (b) return b;
		b = [];
		const entry = tableByName.get('instancebaseline')?.entries.find(e => e.name === String(dt.classes[classIndex].id));
		if (entry?.data) {
			try {
				readEntityProps(new BitReader(entry.data), dt.classes[classIndex].flat, b);
			} catch (e) {
				errors.push(`baseline for ${dt.classes[classIndex].name}: ${(e as Error).message}`);
			}
		}
		instanceBaselines.set(classIndex, b);
		return b;
	};
	const onTableChange = (t: StringTable) => {
		tableByName.set(t.name, t);
		if (t.name === 'instancebaseline') instanceBaselines.clear();
		if (t.name === 'lightstyles') {
			t.entries.forEach((e, style) => {
				if (!e?.data) return;
				let end = e.data.indexOf(0);
				if (end < 0) end = e.data.length;
				const pattern = String.fromCharCode(...e.data.subarray(0, end));
				if (stylePatterns.get(style) === pattern) return;
				stylePatterns.set(style, pattern);
				lightStyles.push({tick: tableTick, style, pattern});
			});
		}
	};

	const noteOriginCopy = (e: LiveEntity, changed: number[]) => {
		const copies = fields[e.classIndex].origins;
		if (copies.length < 2) return;
		const i = copies.findIndex(c => changed.includes(c.origin) || changed.includes(c.z));
		if (i >= 0) e.originCopy = i;
	};

	const record = (e: LiveEntity, tick: number) => {
		const f = fields[e.classIndex];
		const s = e.state;
		let origin: Vec3;
		const copy = f.origins[e.originCopy ?? 0];
		const o = vec(s[copy ? copy.origin : f.origin]);
		if (f.cellOrigin && f.cell[1] >= 0) {
			const width = 2 ** num(s[f.cell[0]], 5);
			const c = (i: number) => num(s[f.cell[i + 1]]) * width - MAX_COORD;
			origin = [c(0) + (o?.[0] ?? 0), c(1) + (o?.[1] ?? 0), c(2) + (o?.[2] ?? 0)];
		} else {
			origin = [o?.[0] ?? 0, o?.[1] ?? 0, o && o.length > 2 ? o[2] : num(s[copy ? copy.z : f.originZ])];
		}
		const a = vec(s[f.angles]);
		const angles: Vec3 = f.eyeYaw >= 0 ? [num(s[f.eyePitch]), num(s[f.eyeYaw]), 0] : [a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0];
		const visible = e.inSnapshot && !(num(s[f.effects]) & EF_NODRAW);
		const active = f.activated >= 0 ? num(s[f.activated]) !== 0 : undefined;
		const eyeZ = f.viewOffset < 0 ? undefined : f.viewOffsetIsVec ? vec(s[f.viewOffset])?.[2] : num(s[f.viewOffset]);
		let extra: Record<string, PropValue> | undefined;
		if (f.extra.length) {
			extra = {};
			for (const [n, i] of f.extra) if (s[i] !== undefined) extra[n] = s[i];
		}
		const anim: AnimState | undefined = f.sequence < 0 ? undefined : {
			sequence: num(s[f.sequence]),
			cycle: num(s[f.cycle]),
			rate: f.rate >= 0 && s[f.rate] !== undefined ? num(s[f.rate]) : 1,
			clientSide: num(s[f.clientSide]) !== 0,
			parity: num(s[f.parity]),
		};
		// handles: index in the low bits, 0x7ff... = none
		const ph = f.moveParent >= 0 ? num(s[f.moveParent], -1) : -1;
		const parentIndex = ph >= 0 && (ph & 2047) !== 2047 ? ph & 2047 : undefined;
		const attachment = parentIndex !== undefined && f.parentAttachment >= 0 ? num(s[f.parentAttachment]) || undefined : undefined;
		const skin = f.skin >= 0 ? num(s[f.skin]) || undefined : undefined;
		const t = e.track;
		const mins = vec(s[f.mins]), maxs = vec(s[f.maxs]);
		if (mins) t.mins = [mins[0], mins[1], mins[2]];
		if (maxs) t.maxs = [maxs[0], maxs[1], maxs[2]];
		if (f.model >= 0) t.model = modelName(num(s[f.model]));
		if (f.isPortal2 >= 0) t.orange = num(s[f.isPortal2]) !== 0;
		const last = t.keys[t.keys.length - 1];
		if (last && last.visible === visible && last.active === active && last.eyeZ === eyeZ && last.parent === parentIndex && last.attachment === attachment && last.skin === skin && sameVec(last.origin, origin) && sameVec(last.angles, angles) && sameAnim(last.anim, anim) && sameExtra(last.extra, extra)) return;
		if (last && last.tick === tick) t.keys.pop();
		t.keys.push({tick, origin, angles, visible, active, eyeZ, anim, extra, parent: parentIndex, attachment, skin});
	};

	const leave = (e: LiveEntity, tick: number, remove: boolean) => {
		e.inSnapshot = false;
		record(e, tick);
		if (remove) live.delete(e.track.index);
	};

	const applyPacketEntities = (h: Omit<PacketEntitiesHeader, 'deltaFrom'>, tick: number) => {
		if (!h.isDelta) {
			// a full snapshot replaces everything
			for (const e of live.values()) leave(e, tick, false);
			live.clear();
		}
		if (h.updateBaseline) {
			baselines[1 - h.baseline] = new Map(baselines[h.baseline]);
		}
		const br = h.data;
		let index = -1;
		for (let n = 0; n < h.updated; n++) {
			index += 1 + readUBitInt(br);
			const type = br.u(2);
			if (type === 0) {
				const e = live.get(index);
				if (!e) throw new Error(`update for entity ${index}, which doesn't exist`);
				noteOriginCopy(e, readEntityProps(br, dt.classes[e.classIndex].flat, e.state));
				record(e, tick);
			} else if (type === 2) {
				const classIndex = br.u(dt.classBits);
				const serial = br.u(10);
				const cls = dt.classes[classIndex];
				if (!cls) throw new Error(`entity ${index} has unknown class ${classIndex}`);
				let e = live.get(index);
				if (!e || e.classIndex !== classIndex || e.serial !== serial) {
					if (e) leave(e, tick, true);
					const eb = baselines[h.baseline].get(index);
					const base = eb && eb.classIndex === classIndex ? eb.state : instanceBaseline(classIndex);
					const track: EntityTrack = {index, className: cls.name, model: '', mins: [0, 0, 0], maxs: [0, 0, 0], keys: []};
					tracks.push(track);
					classCounts.set(cls.name, (classCounts.get(cls.name) ?? 0) + 1);
					e = {classIndex, serial, state: base.slice(), track, inSnapshot: true};
					live.set(index, e);
				}
				e.inSnapshot = true;
				noteOriginCopy(e, readEntityProps(br, cls.flat, e.state));
				if (h.updateBaseline) baselines[1 - h.baseline].set(index, {classIndex, state: e.state.slice()});
				record(e, tick);
			} else {
				const e = live.get(index);
				if (e) leave(e, tick, type === 3);
			}
		}
		if (h.isDelta) {
			// explicit deletions
			while (br.remaining > 0 && br.bit()) {
				const e = live.get(br.u(MAX_EDICT_BITS));
				if (e) leave(e, tick, true);
			}
		}
	};

	for (const r of seg.net) {
		try {
			handle(r);
		} catch (e) {
			if (errors.length < 20) errors.push(`${r.kind} at tick ${r.tick}: ${(e as Error).message}`);
		}
	}

	function handle(r: NetRecord) {
		tableTick = Math.max(0, r.tick);
		switch (r.kind) {
		case 'packet':
			walkPacket(r.data, r.bits, {
				tables,
				classBits: dt.classBits,
				onTableChange,
				onPacketEntities: h => {
					if (backdoorSeen && r.backdoor) return;
					applyPacketEntities(h, r.tick);
				},
				onUserMessage: (type, data) => {
					const e = readPaintMessage(type, data, r.tick);
					if (e) paint.push(e);
				},
				onPaintmap: data => {
					const e = readPaintmap(data, r.tick);
					if (e) paint.push(e);
				},
			});
			break;
		case 'entities':
			applyPacketEntities({maxEntries: r.maxEntries, isDelta: r.isDelta, baseline: 0, updated: r.updated, updateBaseline: false, data: new BitReader(r.data, r.bits)}, r.tick);
			break;
		case 'table': {
			let t = tableByName.get(r.name);
			if (!t) {
				t = {name: r.name, maxEntries: 0, fixedSize: false, userDataBits: 0, entries: []};
				tables.push(t);
			}
			for (const e of r.entries) {
				const entry = t.entries[e.index] ?? (t.entries[e.index] = {name: ''});
				if (e.name !== undefined) entry.name = e.name;
				if (e.data !== undefined) entry.data = e.data;
			}
			onTableChange(t);
			break;
		}
		case 'snapshot': {
			const map = new Map(tables.map(t => [t.name, t]));
			readStringTableSnapshot(r.data, map);
			for (const t of map.values()) {
				if (!tables.includes(t)) tables.push(t);
				onTableChange(t);
			}
			break;
		}
		}
	}

	// the recording player: in co-op that can be either player, so take the
	// one that follows the recorded view
	const players = tracks.filter(t => t.className === 'CPortal_Player' && t.keys.length);
	let player = players[0];
	if (players.length > 1 && seg.views.length) {
		let best = Infinity;
		for (const p of players) {
			let sum = 0, n = 0;
			for (let i = 0; i < seg.views.length; i += Math.max(1, Math.floor(seg.views.length / 50))) {
				const v = seg.views[i], k = keyAt(p, v.tick);
				if (!k) continue;
				sum += Math.hypot(k.origin[0] - v.origin[0], k.origin[1] - v.origin[1], k.origin[2] - v.origin[2]);
				n++;
			}
			const score = n ? sum / n : Infinity;
			if (score < best) {
				best = score;
				player = p;
			}
		}
	}
	return {tracks, classCounts, errors, player, paint, lightStyles};
}

const sameVec = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const sameExtra = (a?: Record<string, PropValue>, b?: Record<string, PropValue>) => a === b || JSON.stringify(a) === JSON.stringify(b);
const sameAnim = (a?: AnimState, b?: AnimState) => a === b || (!!a && !!b && a.sequence === b.sequence && a.cycle === b.cycle && a.rate === b.rate && a.clientSide === b.clientSide && a.parity === b.parity);

// The key in effect at a tick (or undefined before the entity exists)
export function keyAt(track: EntityTrack, tick: number): EntityKey | undefined {
	const i = keyIndexAt(track, tick);
	return i < 0 ? undefined : track.keys[i];
}

export function keyIndexAt(track: EntityTrack, tick: number): number {
	const k = track.keys;
	let lo = 0, hi = k.length - 1, ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (k[mid].tick <= tick) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}
