// Single-player chamber signs: the vgui_screen panel sp_progress_sign
// (CVGUI_SP_ProgressSignScreen), painted onto a canvas as the client paints
// its 400 x 808 panel. From scripts/vscripts/transitions/sp_lightboard_icons.txt,
// per map: the level number, the levels in the chapter, up to ten icons
// (lit or not) and the dirt overlay. Painted, in order: the board (grey 100),
// the number's two digits, the progress bar, the icons (black, lit at 255 and
// unlit at 112), the dirt; then the "01/19" label over it. The startup
// flicker isn't played: signs show as they settle.
import type {GameFiles} from '../game/files.ts';
import {parseKeyValues, type KV} from '../game/materials.ts';
import {readVtf, decodeVtf} from '../game/vtf.ts';

const W = 400, H = 808;
const BACKGROUND = 100, UNLIT = 112;
const LABEL_FONT = 'P2 UniversLTStd-BoldCn', LABEL_TALL = 28;
// the icon names in the lightboard sheet's order (after "dummy"),
// g_pszLightboardIcons
const ICONS = ['cube_drop', 'cube_button', 'cube_bonk', 'drink_water', 'goop', 'crushers', 'laser_cube', 'turret', 'turret_burn', 'portal_fling',
	'plate_fling', 'bridges', 'bridge_block', 'grinders', 'tbeams', 'paint_bounce', 'paint_speed', 'handoff', 'button_stand', 'laser_power',
	'portal_fling_2', 'tbeam_polarity', 'danger_field'];
const IMAGES = {
	board: 'vgui/screens/vgui_coop_progress_board', numbers: 'vgui/screens/vgui_coop_progress_board_numbers',
	bar: 'vgui/screens/vgui_coop_progress_board_bar', icons: 'vgui/screens/P2_lightboard_vgui',
	dirt1: 'vgui/elevator_video_overlay1', dirt2: 'vgui/elevator_video_overlay2', dirt3: 'vgui/elevator_video_overlay3',
};
type Images = Record<keyof typeof IMAGES, HTMLCanvasElement | null>;

interface SignData {
	level: number;
	total: number;
	dirt: number;   // -1 for none
	icons: {sheet: number; lit: boolean}[];
}

const child = (kv: KV, key: string) => kv.find(e => e.key === key)?.value;

export class ProgressSigns {
	private files: GameFiles;
	private loading: Promise<void> | null = null;
	private maps = new Map<string, SignData>();
	private images: Images | null = null;
	private signs = new Map<string, HTMLCanvasElement>();
	onChange = () => {};

	constructor(files: GameFiles) {
		this.files = files;
	}

	// the sign painted for a map (undefined while loading, null for a map
	// with no sign data)
	sign(map: string): HTMLCanvasElement | null | undefined {
		if (!this.images) {
			this.loading ??= this.load().then(() => this.onChange()).catch(() => {});
			return undefined;
		}
		let c = this.signs.get(map);
		if (!c) {
			const data = this.maps.get(map.toLowerCase());
			if (!data) return null;
			this.signs.set(map, c = this.paint(data, this.images));
		}
		return c;
	}

	private async load() {
		const text = await this.files.text('scripts/vscripts/transitions/sp_lightboard_icons.txt').catch(() => null);
		const maps = text ? child(parseKeyValues(text), 'sp_lightboard_icons') : undefined;
		const list = typeof maps === 'object' ? child(maps, 'maps') : undefined;
		if (typeof list === 'object') {
			for (const {key, value} of list) {
				if (typeof value !== 'object') continue;
				const num = (k: string, d: number) => {
					const v = child(value, k);
					return typeof v === 'string' && v.trim() !== '' ? Math.trunc(Number(v)) || 0 : d;
				};
				const icons: SignData['icons'] = [];
				const iconList = child(value, 'icons');
				if (typeof iconList === 'object') {
					for (const {key: name, value: on} of iconList) {
						const i = ICONS.indexOf(name);
						if (i >= 0 && icons.length < 10) icons.push({sheet: i, lit: Number(on) !== 0});
					}
				}
				const dirt = num('dirt', -1);
				this.maps.set(key, {level: num('level_number', 0), total: num('total_levels', 0), dirt: dirt < 0 ? -1 : Math.min(2, dirt), icons});
			}
		}
		const entries = await Promise.all(Object.entries(IMAGES).map(async ([k, m]) => [k, await this.image(m)] as const));
		this.images = Object.fromEntries(entries) as Images;
		// the label's font (the chapter titles' too)
		const raw = await this.files.read('platform/vgui/fonts/univercb.vfont').catch(() => null);
		const {decodeVfont} = await import('./hudtext.ts');
		const ttf = raw && decodeVfont(raw);
		if (ttf) {
			const face = new FontFace(LABEL_FONT, ttf.slice().buffer);
			await face.load();
			document.fonts.add(face);
		}
	}

	// a vgui material's texture, decoded onto a canvas
	private async image(material: string): Promise<HTMLCanvasElement | null> {
		const vmt = await this.files.text(`materials/${material}.vmt`).catch(() => null);
		const kv = vmt ? parseKeyValues(vmt)[0]?.value : undefined;
		const base = typeof kv === 'object' ? child(kv, '$basetexture') : undefined;
		const path = (typeof base === 'string' ? base : material).toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '');
		const bytes = await this.files.read(`materials/${path}.vtf`).catch(() => null);
		const img = bytes && readVtf(bytes);
		if (!img) return null;
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(decodeVtf(img)), img.width, img.height), 0, 0);
		return c;
	}

	private paint(data: SignData, im: Images): HTMLCanvasElement {
		const c = document.createElement('canvas');
		c.width = W;
		c.height = H;
		const g = c.getContext('2d')!;
		const tmp = document.createElement('canvas');
		// a texture's [u0, v0, u1, v1] into a rectangle, times a colour (as
		// vgui's DrawTexturedSubRect with DrawSetColor)
		const rect = (img: HTMLCanvasElement | null, uv: number[], x0: number, y0: number, x1: number, y1: number, color: number[]) => {
			const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
			if (!img || w <= 0 || h <= 0) return;
			tmp.width = w;
			tmp.height = h;
			const t = tmp.getContext('2d', {willReadFrequently: true})!;
			t.drawImage(img, uv[0] * img.width, uv[1] * img.height, (uv[2] - uv[0]) * img.width, (uv[3] - uv[1]) * img.height, 0, 0, w, h);
			const d = t.getImageData(0, 0, w, h);
			for (let i = 0; i < d.data.length; i += 4) {
				for (let k = 0; k < 3; k++) d.data[i + k] = d.data[i + k] * color[k] / 255;
				d.data[i + 3] = d.data[i + 3] * color[3] / 255;
			}
			t.putImageData(d, 0, 0);
			g.drawImage(tmp, Math.round(x0), Math.round(y0));
		};
		rect(im.board, [0, 0, 1, 1], 0, 0, W, H, [BACKGROUND, BACKGROUND, BACKGROUND, 255]);
		// the number: two digits from a 6 x 2 sheet, a third of 40% of the
		// panel's height wide each, a quarter of that down
		const tall = Math.trunc(H * 0.4), top = Math.trunc(tall / 4), wide = Math.trunc(tall / 3);
		const digit = (d: number, x0: number, x1: number) => {
			const col = d > 5 ? d - 6 : d, row = d > 5 ? 0.5 : 0;
			rect(im.numbers, [col / 6, row, (col + 1) / 6, row + 0.5], x0, top, x1, tall + top, [255, 255, 255, 255]);
		};
		const level = Math.max(0, data.level);
		digit(Math.trunc(level / 10) % 10, 70, wide + 70);
		digit(level % 10, wide + 70, wide * 2 + 70);
		// the bar: as far along as the level is through the chapter, its
		// texture repeating every 32 pixels
		if (data.total > 0) {
			const frac = data.level > 0 ? data.level / data.total : 1;
			const end = (W - 162) * frac + 81;
			for (let x = 81; x < end; x += 32) rect(im.bar, [0, 0, Math.min(32, end - x) / 32, 1], x, 461, Math.min(x + 32, end), 493, [255, 255, 255, 255]);
		}
		// the icons: rows of five, 53 pixels on a 63 pixel step
		data.icons.forEach((icon, i) => {
			const x = 81 + (i % 5) * 63, y = 577 + Math.trunc(i / 5) * 63;
			const u = (icon.sheet % 5) * 0.2, v = Math.trunc(icon.sheet / 5) * 0.2;
			rect(im.icons, [u, v, u + 0.2, v + 0.2], x, y, x + 53, y + 53, [0, 0, 0, icon.lit ? 255 : UNLIT]);
		});
		if (data.dirt >= 0) rect(im[`dirt${data.dirt + 1}` as 'dirt1'], [0, 0, 1, 1], 0, 0, W, H, [255, 255, 255, 255]);
		// LevelProgressLabel: "13/19", left at 81, its line centred in 386..486
		const text = `${String(data.level).padStart(2, '0')}/${String(data.total).padStart(2, '0')}`;
		g.font = `100px "${LABEL_FONT}"`;
		const m = g.measureText('0');
		const cell = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) || 120;
		const size = 100 * LABEL_TALL / cell;
		g.font = `${size}px "${LABEL_FONT}"`;
		g.fillStyle = 'black';
		g.textBaseline = 'alphabetic';
		g.fillText(text, 81, 386 + (100 - LABEL_TALL) / 2 + m.fontBoundingBoxAscent * size / 100);
		return c;
	}
}
