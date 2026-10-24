// What the viewer knows about a run, whichever file it came from.

export type Vec3 = [number, number, number];

export interface ViewFrame {
	tick: number;     // demo tick within the segment
	origin: Vec3;     // view (eye) position
	angles: Vec3;     // pitch, yaw, roll
}

export interface UserCmd {
	tick: number;
	slot: number;
	commandNumber: number;
	viewAngles: Vec3;
	forwardMove: number;
	sideMove: number;
	upMove: number;
	buttons: number;
	impulse: number;
	mouseDx: number;
	mouseDy: number;
}

export interface ConsoleCmd {
	tick: number;
	text: string;
	initialValue?: boolean;  // a FCVAR_DEMO value written at the start
}

export interface SarSplit {
	name: string;
	segments: {name: string; ticks: number}[];
}

export type SarEvent = {tick: number} & (
	| {kind: 'timescale'; timescale: number}
	| {kind: 'cvar'; name: string; value: string}
	| {kind: 'entityInput'; slot?: number; target: string; className: string; input: string; param: string}
	| {kind: 'portal'; slot: number; orange: boolean; pos: Vec3}
	| {kind: 'cmFlags'; slot: number}
	| {kind: 'crouchFly'; slot: number}
	| {kind: 'pause'; ticks: number; timed: boolean}
	| {kind: 'waitRun'; tick2: number; cmd: string}
	| {kind: 'speedrunTime'; complete: boolean; splits: SarSplit[]; rules: {name: string; description: string}[]}
	| {kind: 'timestamp'; date: Date}
	| {kind: 'fileChecksum'; sum: number; path: string}
	| {kind: 'entitySerial'; slot: number; serial: number}
	| {kind: 'frametime'; frametime: number}
	| {kind: 'queuedCmd'; cmd: string}
	| {kind: 'speedrunId'; id: string}
	| {kind: 'vscriptChecksum'; sum: number; path: string}
	| {kind: 'other'; type: number; size: number}
);

export interface Segment {
	index: number;
	map: string;
	startedMidMap: boolean;
	intervalPerTick: number;
	endReason?: string;
	firstTick: number;
	lastTick: number;
	views: ViewFrame[];
	userCmds: UserCmd[];
	consoleCmds: ConsoleCmd[];
	sar: SarEvent[];
}

export type Check = {state: 'ok' | 'bad' | 'unknown' | 'none'; detail: string};

export interface Verification {
	hashChain: Check;
	signature: Check;
	complete: Check;  // the file ended with a clean stop
}

export interface Run {
	format: 'sarp' | 'dem';
	fileName: string;
	fileSize: number;
	info: [string, string][];
	game: string;
	player: string;
	segments: Segment[];
	verification?: Verification;
	warnings: string[];
}

export const segmentDuration = (s: Segment) => Math.max(0, s.lastTick - s.firstTick) * s.intervalPerTick;
