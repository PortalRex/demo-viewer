// Side panels: events, console, splits, file and verification, plus the
// segment list, header badges and input display.
import type {Run, SarEvent, Segment, Check} from '../core/model.ts';
import {segmentDuration} from '../core/model.ts';
import {describeSarEvent} from '../core/sardata.ts';
import {Buttons} from '../core/usercmd.ts';
import type {UserCmd} from '../core/model.ts';
import type {Trick} from '../player/tricks.ts';

export const fmtTime = (secs: number) => {
	const sign = secs < 0 ? '-' : '';
	secs = Math.abs(secs);
	const m = Math.floor(secs / 60);
	const s = secs - m * 60;
	return `${sign}${m}:${s.toFixed(2).padStart(5, '0')}`;
};

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);

// what the events tab shows; the rest is noise for watching a run
const SHOWN = new Set<SarEvent['kind']>(['portal', 'pause', 'timescale', 'speedrunTime', 'cmFlags', 'crouchFly', 'timestamp', 'speedrunId', 'waitRun']);

interface RowList {
	el: HTMLElement;
	ticks: number[];
	rows: HTMLElement[];
	current: number;
}

export class Panels {
	private events: RowList;
	private console: RowList;
	private seek: (segIndex: number, tick: number) => void;

	constructor(seek: (segIndex: number, tick: number) => void) {
		this.seek = seek;
		this.events = {el: document.getElementById('tab-events')!, ticks: [], rows: [], current: -2};
		this.console = {el: document.getElementById('tab-console')!, ticks: [], rows: [], current: -2};
		const tabs = document.getElementById('tabs')!;
		tabs.addEventListener('click', e => {
			const b = (e.target as HTMLElement).closest('button');
			if (!b) return;
			for (const x of tabs.querySelectorAll('button')) x.classList.toggle('on', x === b);
			for (const t of ['events', 'console', 'splits', 'file', 'race']) document.getElementById(`tab-${t}`)!.hidden = t !== b.dataset.tab;
		});
	}

	setRun(run: Run, onSegment: (i: number) => void) {
		const title = document.getElementById('run-title')!;
		const total = run.segments.reduce((n, s) => n + segmentDuration(s), 0);
		title.innerHTML = `<b>${esc(run.fileName)}</b> · ${esc(run.player || 'unknown player')} · ${esc(run.game)}`;
		document.getElementById('total-time')!.textContent = fmtTime(total);

		const badges = document.getElementById('badges')!;
		badges.innerHTML = '';
		const v = run.verification;
		const badge = (label: string, c: Check) => `<span class="badge ${c.state}" title="${esc(c.detail)}">${label}</span>`;
		if (v) {
			badges.innerHTML = badge(v.hashChain.state === 'ok' ? 'Intact' : v.hashChain.state === 'bad' ? 'Modified' : 'Unchecked', v.hashChain)
				+ badge(v.signature.state === 'ok' ? 'Signed' : v.signature.state === 'bad' ? 'Bad signature' : 'Unsigned', v.signature)
				+ badge(v.complete.state === 'ok' ? 'Complete' : 'Cut short', v.complete);
		} else {
			badges.innerHTML = `<span class="badge none" title="Demos have no integrity check in this viewer">Demo</span>`;
		}

		const list = document.getElementById('segment-list')!;
		list.innerHTML = run.segments.map((s, i) => `
			<li data-i="${i}">
				<span class="map">${esc(s.map)}</span><span class="dur">${fmtTime(segmentDuration(s))}</span>
				${s.endReason ? `<span class="why">${esc(s.endReason)}${s.startedMidMap ? ' · started mid-map' : ''}</span>` : ''}
			</li>`).join('');
		list.onclick = e => {
			const li = (e.target as HTMLElement).closest('li');
			if (li) onSegment(Number(li.dataset.i));
		};

		this.renderSplits(run);
		this.renderFile(run);
	}

	// (with the tricks found in it among its events; the portals SAR
	// recorded are there already)
	setSegment(index: number, seg: Segment, tricks: Trick[] = []) {
		for (const li of document.querySelectorAll('#segment-list li')) li.classList.toggle('on', Number((li as HTMLElement).dataset.i) === index);

		const fmt = (tick: number) => fmtTime(Math.max(0, tick - seg.firstTick) * seg.intervalPerTick);
		const sarPortals = seg.sar.some(e => e.kind === 'portal');
		const rows = [
			...seg.sar.filter(e => SHOWN.has(e.kind)).map(e => {
				const cls = e.kind === 'portal' ? (e.orange ? 'portal-orange' : 'portal-blue') : '';
				return {tick: e.tick, html: `<span class="t">${fmt(e.tick)}</span><span class="x ${cls}">${esc(describeSarEvent(e))}</span>`};
			}),
			...tricks.filter(t => t.kind !== 'portal' || !sarPortals).map(t =>
				({tick: t.tick, html: `<span class="t">${fmt(t.tick)}</span><span class="x trick" style="--trick: ${t.color}">${esc(t.label)}</span>`})),
		].sort((a, b) => a.tick - b.tick);
		this.fill(this.events, rows.map(r => r.tick), rows.map(r => r.html), 'No portal placements, pauses, timer events or tricks in this segment.', index);

		const cmds = seg.consoleCmds.filter(c => !c.initialValue);
		this.fill(this.console, cmds.map(c => c.tick), cmds.map(c =>
			`<span class="t">${fmt(c.tick)}</span><span class="x mono">${esc(c.text)}</span>`), 'No console commands in this segment.', index);
	}

	private fill(list: RowList, ticks: number[], html: string[], empty: string, segIndex: number) {
		list.ticks = ticks;
		list.current = -2;
		if (!html.length) {
			list.el.innerHTML = `<div class="empty">${empty}</div>`;
			list.rows = [];
			return;
		}
		list.el.innerHTML = html.map((h, i) => `<div class="row" data-i="${i}">${h}</div>`).join('');
		list.rows = [...list.el.querySelectorAll<HTMLElement>('.row')];
		list.el.onclick = e => {
			const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
			if (row) this.seek(segIndex, list.ticks[Number(row.dataset.i)]);
		};
	}

	update(tick: number) {
		for (const list of [this.events, this.console]) {
			let cur = -1;
			for (let i = 0; i < list.ticks.length && list.ticks[i] <= tick; i++) cur = i;
			if (cur === list.current) continue;
			list.rows.forEach((r, i) => {
				r.classList.toggle('past', i < cur);
				r.classList.toggle('now', i === cur);
			});
			if (cur >= 0 && !list.el.hidden) list.rows[cur].scrollIntoView({block: 'nearest'});
			list.current = cur;
		}
	}

	private renderSplits(run: Run) {
		const el = document.getElementById('tab-splits')!;
		let summary: Extract<SarEvent, {kind: 'speedrunTime'}> | undefined;
		let interval = 1 / 60;
		for (const s of run.segments) {
			for (const e of s.sar) {
				if (e.kind === 'speedrunTime' && (!summary || e.complete || !summary.complete)) {
					summary = e;
					interval = s.intervalPerTick;
				}
			}
		}
		if (!summary) {
			el.innerHTML = '<div class="empty">No speedrun timer data. SAR writes split times when its timer finishes or the recording stops during a run.</div>';
			return;
		}
		let total = 0;
		const parts = summary.splits.map(sp => {
			const ticks = sp.segments.reduce((n, s) => n + s.ticks, 0);
			total += ticks;
			return `<div class="split"><div class="name"><span>${esc(sp.name)}</span><span>${fmtTime(ticks * interval)}</span></div>
				${sp.segments.length > 1 ? sp.segments.map(s => `<div class="seg"><span>${esc(s.name)}</span><span>${fmtTime(s.ticks * interval)}</span></div>`).join('') : ''}</div>`;
		});
		el.innerHTML = `<h3>${summary.complete ? 'Finished run' : 'Run in progress'} · ${fmtTime(total * interval)}</h3>${parts.join('')}`
			+ (summary.rules.length ? `<h3>Category rules</h3><dl class="kv">${summary.rules.map(r => `<dt>${esc(r.name)}</dt><dd>${esc(r.description)}</dd>`).join('')}</dl>` : '');
	}

	private renderFile(run: Run) {
		const el = document.getElementById('tab-file')!;
		let html = '';
		if (run.verification) {
			const v = run.verification;
			const check = (title: string, c: Check) => `<div class="check ${c.state}"><b>${title}</b>${esc(c.detail)}</div>`;
			html += `<h3>Verification</h3>${check('Hash chain', v.hashChain)}${check('Signature', v.signature)}${check('Recording', v.complete)}`;
		}
		html += `<h3>File</h3><dl class="kv"><dt>Format</dt><dd>${run.format === 'sarp' ? 'SAR proof' : 'Source demo'}</dd><dt>Size</dt><dd>${(run.fileSize / 1024).toFixed(0)} KB</dd>`
			+ run.info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') + '</dl>';
		if (run.warnings.length) html += `<h3>Warnings</h3>${run.warnings.map(w => `<div class="check unknown">${esc(w)}</div>`).join('')}`;
		el.innerHTML = html;
	}
}

export class InputDisplay {
	private keys: Record<string, HTMLElement> = {};

	constructor(el: HTMLElement) {
		const layout: [string, string, string][] = [
			['', '', ''], ['W', 'W', ''], ['E', 'Use', ''], ['', '', 'gap'], ['Jump', 'Jump', 'wide'], ['LMB', 'Blue', 'wide'],
			['A', 'A', ''], ['S', 'S', ''], ['D', 'D', ''], ['', '', 'gap'], ['Duck', 'Duck', 'wide'], ['RMB', 'Orange', 'wide'],
		];
		el.innerHTML = layout.map(([id, label, cls]) => (id ? `<div class="key ${cls}" data-k="${id}" title="${label}">${id}</div>` : '<div></div>')).join('');
		for (const k of el.querySelectorAll<HTMLElement>('.key')) this.keys[k.dataset.k!] = k;
	}

	show(cmd: UserCmd | null) {
		const b = cmd?.buttons ?? 0;
		const on = {
			W: (b & Buttons.FORWARD) !== 0 || (cmd?.forwardMove ?? 0) > 0,
			S: (b & Buttons.BACK) !== 0 || (cmd?.forwardMove ?? 0) < 0,
			A: (b & Buttons.MOVELEFT) !== 0 || (cmd?.sideMove ?? 0) < 0,
			D: (b & Buttons.MOVERIGHT) !== 0 || (cmd?.sideMove ?? 0) > 0,
			E: (b & Buttons.USE) !== 0,
			Jump: (b & Buttons.JUMP) !== 0,
			Duck: (b & Buttons.DUCK) !== 0,
			LMB: (b & Buttons.ATTACK) !== 0,
			RMB: (b & Buttons.ATTACK2) !== 0,
		};
		for (const [k, v] of Object.entries(on)) this.keys[k]?.classList.toggle('on', v);
	}
}
