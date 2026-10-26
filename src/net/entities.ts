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
	// out of the recording player's view (not sent, its last state kept) or
	// deleted; `nodraw`: EF_NODRAW as last sent
	dormant?: boolean;
	removed?: boolean;
	nodraw?: boolean;
	active?: boolean;  // portals: m_bActivated
	eyeZ?: number;     // players: view offset height
	anim?: AnimState;  // animated models
	extra?: Record<string, PropValue>;  // class-specific props (EXTRA_PROPS)
	// attached to another entity: origin/angles are then relative to the
	// parent (or to one of its model's attachments, 1-based)
	parent?: number;
	attachment?: number;
	skin?: number;     // m_nSkin (cube types, lit cubes and buttons)
	model?: string;    // the model here, where it isn't the track's
}

// Props kept for the classes the 3D view draws specially
export const EXTRA_PROPS: Record<string, string[]> = {
	CProp_Portal: ['m_hLinkedPortal', 'm_fNetworkHalfWidth', 'm_fNetworkHalfHeight', 'm_iTeamNum'],
	CPortalLaser: ['m_vStartPoint', 'm_vEndPoint', 'm_bLaserOn'],
	CProjectedWallEntity: ['m_vecStartPoint', 'm_vecEndPoint', 'm_flWidth', 'm_flHeight'],
	CProjectedTractorBeamEntity: ['m_vecStartPoint', 'm_vecEndPoint'],
	CTrigger_TractorBeam: ['m_vStart', 'm_vEnd', 'm_flRadius', 'm_bReversed', 'm_bDisabled', 'm_linearForce', 'm_bFromPortal', 'm_bToPortal'],
	// (and the objects in its range, and when a portal shot last hit it)
	CTriggerPortalCleanser: ['m_bDisabled', 'm_bVisible', 'm_bObject1InRange', 'm_bObject2InRange', 'm_hObject1', 'm_hObject2', 'm_flPortalShotTime'],
	// which fog and tonemap controllers apply to the player
	CPortal_Player: ['m_PlayerFog.m_hCtrl', 'localdata.m_hTonemapController', 'm_hAttachedObject', 'm_bUseVMGrab', 'm_bUsingVMGrabState', 'm_fFlags', 'm_hViewEntity',
		// challenge mode: its type, and the stats its HUD shows
		'localdata.m_iBonusChallenge', 'm_iBonusChallenge', 'm_StatsThisLevel.iNumPortalsPlaced', 'm_StatsThisLevel.fNumSecondsTaken',
		// the funnel they're in (the recording player's only)
		'm_PortalLocal.m_hTractorBeam',
		// taunts (the partner view: a taunt's camera, or a team taunt)
		'm_Shared.m_nPlayerCond', 'm_bTauntRemoteView', 'm_vecRemoteViewAngles', 'm_fTauntCameraDistance', 'm_nTeamTauntState'],
	// Bink movie screens: the vgui screen (a panel this wide and tall at its
	// origin) and the movie display it shows (elevator signs)
	// finale 4's neurotoxin clock (its vgui screens show the time left)
	CNeurotoxinCountdown: ['m_bEnabled', 'm_flCountdownTime'],
	CVGuiScreen: ['m_flWidth', 'm_flHeight', 'm_nPanelName', 'm_fScreenFlags', 'm_nAttachmentIndex', 'm_nOverlayMaterial'],
	CMovieDisplay: ['m_bEnabled', 'm_bLooping', 'm_szMovieFilename', 'm_szGroupName', 'm_bStretchToFill', 'm_bForcedSlave', 'm_bUseCustomUVs', 'm_flUMin', 'm_flUMax', 'm_flVMin', 'm_flVMax'],
	// which frame an overlay's texture shows (indicator lights' two colours)
	CInfoOverlayAccessor: ['m_iOverlayID', 'm_iTextureFrameIndex'],
	// (and a brush's: signs a texture toggle switches, co-op's team door signs)
	CFuncBrush: ['m_iTextureFrameIndex'],
	// indicator panels (their vgui screen shows a check, a cross or a countdown)
	CLabIndicatorPanel: ['m_bEnabled', 'm_bIsChecked', 'm_bCountingDown', 'm_bIsCountdownTimer', 'm_flTimerDuration', 'm_flTimerStart', 'm_bStopped'],
	CFogController: ['m_fog.enable', 'm_fog.colorPrimary', 'm_fog.start', 'm_fog.end', 'm_fog.maxdensity', 'm_fog.HDRColorScale'],
	CParticleSystem: ['m_iEffectIndex', 'm_bActive', 'm_flStartTime', 'm_hControlPointEnts.000', 'm_hControlPointEnts.001', 'm_hControlPointEnts.002'],
	// whose view model it is (co-op recordings have one per player)
	CPredictedViewModel: ['m_hOwner', 'm_nViewModelIndex', 'm_nBody'],
	CBaseViewModel: ['m_hOwner', 'm_nViewModelIndex', 'm_nBody'],
	// body groups (PotatOS)
	CWeaponPortalgun: ['m_nBody', 'm_iLastFiredPortal'],
	// gel sprayers: what the blobs they fire are fired by
	CPaintSprayer: ['m_bActive', 'm_bDrawOnly', 'm_nBlobRandomSeed', 'm_PaintPowerType', 'm_nMaxBlobCount', 'm_flBlobsPerSecond', 'm_flMinSpeed', 'm_flMaxSpeed', 'm_flBlobSpreadRadius', 'm_flBlobSpreadAngle', 'm_flStartTime'],
	// turrets' laser sights
	CNPC_Portal_FloorTurret: ['m_bLaserOn', 'm_bOutOfAmmo'],
	// a doorway's fade brush, drawn by distance (see View3D)
	CFuncAreaPortalWindow: ['m_flFadeStartDist', 'm_flFadeDist', 'm_flTranslucencyLimit', 'm_iBackgroundModelIndex'],
	// the projected spotlights (test chambers' key light for models and the world)
	CEnvProjectedTexture: ['m_hTargetEntity', 'm_bCameraSpace', 'm_bState', 'm_flLightFOV', 'm_LightColor', 'm_flBrightnessScale', 'm_SpotlightTextureName', 'm_flNearZ', 'm_flFarZ', 'm_bEnableShadows', 'm_bLightWorld'],
	// sprites (env_sprite): how they're drawn
	CSprite: ['m_nRenderMode', 'm_clrRender', 'm_hAttachedToEntity', 'm_nAttachment', 'm_flSpriteScale', 'm_flGlowProxySize', 'm_flHDRColorScale', 'm_nBrightness', 'm_bWorldSpaceScale'],
	// monitor cameras (point_camera): what _rt_Camera screens show
	CPointCamera: ['m_FOV', 'm_bActive', 'm_bUseScreenAspectRatio', 'm_bFogEnable', 'm_FogColor', 'm_flFogStart', 'm_flFogEnd', 'm_flFogMaxDensity'],
	// funnel projectors: their emitters' particles (direction and on)
	CPropTractorBeamProjector: ['m_flLinearForce', 'm_bEnabled', 'm_bNoEmitterParticles'],
	// fire on something (C_EntityFlame's burning_character): what it's on
	CEntityFlame: ['m_hEntAttached', 'm_bCheapEffect'],
	// how a held object faces its holder (co-op's view model grab draws it so)
	CPropWeightedCube: ['m_qPreferredPlayerCarryAngles'],
	CPhysicsProp: ['m_qPreferredPlayerCarryAngles'],
	CPhysicsPropMultiplayer: ['m_qPreferredPlayerCarryAngles'],
	// ropes: their ends and how they hang (see Ropes)
	CRopeKeyframe: ['m_hStartPoint', 'm_hEndPoint', 'm_iStartAttachment', 'm_iEndAttachment', 'm_Slack', 'm_RopeLength', 'm_fLockedPoints', 'm_RopeFlags', 'm_nSegments', 'm_Subdiv', 'm_TextureScale', 'm_Width'],
	CEnvTonemapController: ['m_bUseCustomAutoExposureMin', 'm_bUseCustomAutoExposureMax', 'm_flCustomAutoExposureMin', 'm_flCustomAutoExposureMax', 'm_bUseCustomBloomScale', 'm_flCustomBloomScale'],
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
	serial?: number;    // the entity's serial number (handles carry it: index | serial << 11)
	keys: EntityKey[];
	userData?: Record<string, unknown>;  // the viewer's per-track cache
}

export interface EntityTimeline {
	tracks: EntityTrack[];
	classCounts: Map<string, number>;
	errors: string[];
	player?: EntityTrack;
	paint: PaintEvent[];
	lightStyles: LightStyleChange[];  // in tick order
	particleNames: string[];          // "ParticleEffectNames" (info_particle_system's m_iEffectIndex)
	panelNames: string[];             // "VguiScreen" (vgui screens' m_nPanelName: sp_progress_sign, ...)
	effects: EffectEvent[];           // dispatched effects (temp entities), in tick order
	fades: ScreenFade[];              // screen fades sent to the recording player, in tick order
	hudMessages: HudMessage[];        // on-screen text (game_text: chapter titles), in tick order
}

// A "Fade" user message (ScreenFade_t): over `duration` seconds to or from
// the colour, held `hold` seconds; flags FFADE_IN 1, OUT 2, MODULATE 4,
// STAYOUT 8, PURGE 16
export interface ScreenFade {
	tick: number;
	duration: number;
	hold: number;
	flags: number;
	color: [number, number, number, number];  // 0..255
}
// Portal 2's user message number for it (registration order)
const MSG_FADE = 13;

// A "HudMsg" user message (game_text): text on a channel (a new one
// replaces the channel's last), at x/y in 0..1 of the screen (-1 centred),
// in colour1 (colour2 for effect 2's write-out flash), fading in, held,
// fading out (seconds; effect 2's fade in is per character)
export interface HudMessage {
	tick: number;
	channel: number;
	x: number;
	y: number;
	color1: [number, number, number, number];
	color2: [number, number, number, number];
	effect: number;
	fadeIn: number;
	fadeOut: number;
	hold: number;
	fxTime: number;
	text: string;     // may be a localization token (#portal2_Chapter3_Title)
}
const MSG_HUDMSG = 6;
// a portal shot's fizzle at the surface (PortalFX_Surface: the portal, its
// shooter, team, which portal, the fizzle type, where and facing which way);
// kept as an EffectEvent named "PortalFX_Surface" (color: which portal,
// damageType: the fizzle type, hitbox: the team)
const MSG_PORTALFX_SURFACE = 48;
const bitCoord = (b: BitReader) => {
	const hasInt = b.bit(), hasFrac = b.bit();
	if (!hasInt && !hasFrac) return 0;
	const sign = b.bit();
	const v = (hasInt ? b.u(14) + 1 : 0) + (hasFrac ? b.u(5) : 0) / 32;
	return sign ? -v : v;
};
const bitVec3Coord = (b: BitReader): Vec3 => {
	const has = [b.bit(), b.bit(), b.bit()];
	return [has[0] ? bitCoord(b) : 0, has[1] ? bitCoord(b) : 0, has[2] ? bitCoord(b) : 0];
};

// A DispatchEffect from the server (CTEEffectDispatch): "PortalBlast" for a
// portal shot (origin: where it left the gun, start: where the portal
// lands, color: 1 or 2 for which portal, entity: the shooter),
// "ParticleEffect" for a named particle system (hitbox: its index in
// ParticleEffectNames), and so on
export interface EffectEvent {
	tick: number;
	name: string;
	origin: Vec3;
	start: Vec3;
	angles: Vec3;
	normal: Vec3;
	scale: number;
	color: number;
	entity: number;
	attachment: number;
	hitbox: number;
	damageType: number;
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
		// (and every model's body groups: a Frankenturret's head, ...)
		extra: [...new Set([...(EXTRA_PROPS[cls.name] ?? []), 'm_nBody'])].map(n => [n, cls.index.get(n) ?? -1] as [string, number]).filter(([, i]) => i >= 0),
		cell: [find(cls, 'm_cellbits'), find(cls, 'm_cellX'), find(cls, 'm_cellY'), find(cls, 'm_cellZ')],
		cellOrigin: origin >= 0 && (cls.flat[origin].prop.flags & (F.CELLCOORD | F.CELLCOORDLP | F.CELLCOORDINT)) !== 0,
		angles: find(cls, 'm_angRotation', 'm_angAbsRotation'),
		// (a rope's material is in the model table too)
		model: cls.name === 'CRopeKeyframe' ? find(cls, 'm_iRopeMaterialModelIndex') : find(cls, 'm_nModelIndex'),
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
	removed?: boolean;
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
	const effects: EffectEvent[] = [];
	const fades: ScreenFade[] = [];
	const hudMessages: HudMessage[] = [];
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
		const nodraw = (num(s[f.effects]) & EF_NODRAW) !== 0;
		const visible = e.inSnapshot && !nodraw;
		const dormant = !e.inSnapshot && !e.removed ? true : undefined;
		const removed = e.removed ? true : undefined;
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
		// the track's model is its first; a key carries its own where the
		// entity has switched (a Frankencube becoming a box when picked up)
		const m = f.model >= 0 ? modelName(num(s[f.model])) : '';
		if (!t.model) t.model = m;
		const model = m && m !== t.model ? m : undefined;
		if (f.isPortal2 >= 0) t.orange = num(s[f.isPortal2]) !== 0;
		const last = t.keys[t.keys.length - 1];
		if (last && last.visible === visible && last.dormant === dormant && last.removed === removed && last.active === active && last.eyeZ === eyeZ && last.parent === parentIndex && last.attachment === attachment && last.skin === skin && last.model === model && sameVec(last.origin, origin) && sameVec(last.angles, angles) && sameAnim(last.anim, anim) && sameExtra(last.extra, extra)) return;
		if (last && last.tick === tick) t.keys.pop();
		t.keys.push({tick, origin, angles, visible, dormant, removed, nodraw, active, eyeZ, anim, extra, parent: parentIndex, attachment, skin, model});
	};

	const leave = (e: LiveEntity, tick: number, remove: boolean) => {
		e.inSnapshot = false;
		e.removed = remove;
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
					const track: EntityTrack = {index, className: cls.name, model: '', mins: [0, 0, 0], maxs: [0, 0, 0], serial, keys: []};
					tracks.push(track);
					classCounts.set(cls.name, (classCounts.get(cls.name) ?? 0) + 1);
					e = {classIndex, serial, state: base.slice(), track, inSnapshot: true};
					live.set(index, e);
				}
				e.inSnapshot = true;
				e.removed = false;
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

	// Temp entities: per entry an optional delay, then either a class and a
	// full set of props, or props as changes to the previous entry's
	function readTempEntities(count: number, br: BitReader, tick: number) {
		let classIndex = -1;
		let state: PropValue[] = [];
		for (let n = 0; n < Math.max(1, count); n++) {
			if (br.bit()) br.u(8);  // fire delay
			if (br.bit()) {
				classIndex = br.u(dt.classBits) - 1;
				state = [];
			}
			const cls = dt.classes[classIndex];
			if (!cls) throw new Error(`unknown temp entity class ${classIndex}`);
			readEntityProps(br, cls.flat, state);
			if (cls.name !== 'CTEEffectDispatch') continue;
			const at = (k: string) => state[cls.index.get(k) ?? -1];
			const n3 = (k: string): Vec3 => [num(at(`${k}.x`)), num(at(`${k}.y`)), num(at(`${k}.z`))];
			const v3 = (k: string): Vec3 => {
				const v = vec(at(k));
				return [v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0];
			};
			const nameIndex = num(at('m_EffectData.m_iEffectName'));
			effects.push({
				tick,
				name: tableByName.get('EffectDispatch')?.entries[nameIndex]?.name ?? '',
				origin: n3('m_EffectData.m_vOrigin'),
				start: n3('m_EffectData.m_vStart'),
				angles: v3('m_EffectData.m_vAngles'),
				normal: v3('m_EffectData.m_vNormal'),
				scale: num(at('m_EffectData.m_flScale')),
				color: num(at('m_EffectData.m_nColor')),
				entity: num(at('m_EffectData.entindex'), -1),
				attachment: num(at('m_EffectData.m_nAttachmentIndex')),
				hitbox: num(at('m_EffectData.m_nHitBox')),
				damageType: num(at('m_EffectData.m_nDamageType')),
			});
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
					if (type === MSG_HUDMSG) {
						try {
							const channel = data.u(8), x = data.f32(), y = data.f32();
							const color = (): [number, number, number, number] => [data.u(8), data.u(8), data.u(8), data.u(8)];
							const color1 = color(), color2 = color();
							const effect = data.u(8), fadeIn = data.f32(), fadeOut = data.f32(), hold = data.f32(), fxTime = data.f32();
							const bytes: number[] = [];
							for (let c = data.u(8); c && bytes.length < 512; c = data.u(8)) bytes.push(c);
							const text = new TextDecoder().decode(new Uint8Array(bytes));
							hudMessages.push({tick: r.tick, channel, x, y, color1, color2, effect, fadeIn, fadeOut, hold, fxTime, text});
						} catch {
							// a short message: ignore it
						}
						return;
					}
					if (type === MSG_FADE) {
						try {
							// (times in 1/512 s: SCREENFADE_FRACBITS 9)
							const duration = data.u(16) / 512, hold = data.u(16) / 512, flags = data.u(16);
							fades.push({tick: r.tick, duration, hold, flags, color: [data.u(8), data.u(8), data.u(8), data.u(8)]});
						} catch {
							// a short message: ignore it
						}
						return;
					}
					if (type === MSG_PORTALFX_SURFACE) {
						try {
							data.u(16);
							const owner = data.u(16), team = data.u(8), portal = data.u(8), fizzle = data.u(8);
							const origin = bitVec3Coord(data), angles = bitVec3Coord(data);
							effects.push({tick: r.tick, name: 'PortalFX_Surface', origin, start: origin, angles, normal: [0, 0, 0], scale: 0, color: portal, entity: owner, attachment: 0, hitbox: team, damageType: fizzle});
						} catch {
							// a short message: ignore it
						}
						return;
					}
					const e = readPaintMessage(type, data, r.tick);
					if (e) paint.push(e);
				},
				onTempEntities: (count, data) => {
					try {
						readTempEntities(count, data, r.tick);
					} catch (e) {
						if (errors.length < 20) errors.push(`temp entities at tick ${r.tick}: ${(e as Error).message}`);
					}
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
	const particleNames = (tableByName.get('ParticleEffectNames')?.entries ?? []).map(e => e?.name ?? '');
	const panelNames = (tableByName.get('VguiScreen')?.entries ?? []).map(e => e?.name ?? '');
	return {tracks, classCounts, errors, player, paint, lightStyles, particleNames, panelNames, effects, fades, hudMessages};
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
