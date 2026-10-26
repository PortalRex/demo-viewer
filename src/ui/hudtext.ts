// On-screen text (game_text's HudMsg: chapter titles, playtest notices),
// drawn over the 3D view as the client's message panel draws it: the newest
// message on each channel, placed by its x/y (fractions of the screen, -1
// centred), faded in, held and faded out; effect 2 writes it out a character
// at a time, each flashing from colour 2 to colour 1. Portal 2 sets the
// chapter title channels' fonts (2 the title, 3 the subtitle); the game's own
// Univers faces are read from its .vfont files.
import type {GameFiles} from '../game/files.ts';
import type {HudMessage} from '../net/entities.ts';

// font heights in 480-line units (basemodui_scheme.res, proportional)
const CHANNEL_FONTS: Record<number, {family: string; tall: number}> = {
	2: {family: 'P2 UniversLTStd-Cn', tall: 19},
	3: {family: 'P2 UniversLTStd-BoldCn', tall: 34},
};
const DEFAULT_FONT = {family: 'Trebuchet MS, sans-serif', tall: 24};

// .vfont: a font file XOR-obfuscated with a rolling key seeded from salt
// bytes kept after it, then the salt count and the tag "VFONT1"
export function decodeVfont(bytes: Uint8Array): Uint8Array | null {
	const tag = 'VFONT1';
	let n = bytes.length - tag.length;
	if (n <= 1 || String.fromCharCode(...bytes.subarray(n)) !== tag) return null;
	const salt = bytes[n - 1];
	n -= salt;
	if (n <= 0) return null;
	let key = 0xa7;
	for (let i = n; i < n + salt - 1; i++) key ^= (bytes[i] + 0xa7) & 255;
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		out[i] = bytes[i] ^ key;
		key = (bytes[i] + 0xa7) & 255;
	}
	return out;
}

export class HudText {
	readonly canvas: HTMLCanvasElement;
	readonly files: GameFiles;
	private strings: Map<string, string> | null = null;
	private loading: Promise<void> | null = null;
	onLoaded = () => {};

	constructor(files: GameFiles, canvas: HTMLCanvasElement) {
		this.files = files;
		this.canvas = canvas;
	}

	// the fonts and the English strings, once
	private load() {
		this.loading ??= (async () => {
			const fonts: [string, string][] = [['P2 UniversLTStd-Cn', 'universc'], ['P2 UniversLTStd-BoldCn', 'univercb']];
			await Promise.all(fonts.map(async ([family, file]) => {
				const raw = await this.files.fs.read(`platform/vgui/fonts/${file}.vfont`).catch(() => null);
				const ttf = raw && decodeVfont(raw);
				if (!ttf) return;
				const face = new FontFace(family, ttf.slice().buffer);
				document.fonts.add(await face.load());
			}));
			const raw = await this.files.read('resource/portal2_english.txt').catch(() => null);
			this.strings = new Map();
			if (raw) {
				const text = new TextDecoder(raw[0] === 0xff && raw[1] === 0xfe ? 'utf-16le' : 'utf-8').decode(raw);
				for (const m of text.matchAll(/"([^"]+)"\s+"([^"]*)"/g)) this.strings.set(m[1].toLowerCase(), m[2]);
			}
			this.onLoaded();
		})().catch(() => {});
		return this.loading;
	}

	// the messages showing at `time` (seconds; messages' ticks x interval)
	draw(messages: HudMessage[] | null, time: number, interval: number) {
		const c = this.canvas;
		const w = Math.round(c.clientWidth * devicePixelRatio), h = Math.round(c.clientHeight * devicePixelRatio);
		if (c.width !== w || c.height !== h) {
			c.width = w;
			c.height = h;
		}
		const g = c.getContext('2d')!;
		g.clearRect(0, 0, w, h);
		if (!messages?.length || !w || !h) return;
		if (!this.strings) {
			void this.load();
			return;
		}
		// (the newest message on each channel)
		const current = new Map<number, HudMessage>();
		for (const m of messages) {
			if (m.tick * interval > time) break;
			current.set(m.channel, m);
		}
		for (const m of current.values()) this.drawMessage(g, m, time - m.tick * interval, w, h);
	}

	private drawMessage(g: CanvasRenderingContext2D, m: HudMessage, t: number, w: number, h: number) {
		const text = m.text.startsWith('#') ? this.strings!.get(m.text.slice(1).toLowerCase()) ?? m.text : m.text;
		const chars = [...text.replace(/\n/g, '')];
		const lifetime = (m.effect === 2 ? m.fadeIn * chars.length : m.fadeIn) + m.hold + m.fadeOut;
		if (t < 0 || t > lifetime) return;
		const font = CHANNEL_FONTS[m.channel] ?? DEFAULT_FONT;
		const size = font.tall * h / 480;
		g.font = `${size}px ${font.family.includes(',') ? font.family : `"${font.family}"`}`;
		g.textBaseline = 'top';
		const lines = text.split('\n');
		const widths = lines.map(l => g.measureText(l).width);
		const total = Math.max(...widths), height = lines.length * size;
		const place = (v: number, extent: number, span: number) => (v === -1 ? (span - extent) / 2 : v < 0 ? (1 + v) * span - extent : v * span);
		// how far it has faded out (0..1): effect 2 holds after its last
		// character, the others after their fade in
		const fadeAt = (m.effect === 2 ? m.fadeIn * chars.length : m.fadeIn) + m.hold;
		const out = t > fadeAt ? (m.fadeOut > 0 ? Math.min(1, (t - fadeAt) / m.fadeOut) : 1) : 0;
		const fadeIn = m.effect !== 2 && m.fadeIn > 0 && t < m.fadeIn ? t / m.fadeIn : 1;
		let index = 0, y = place(m.y, height, h);
		lines.forEach((line, n) => {
			let x = place(m.x, widths[n], w);
			for (const ch of line) {
				index++;
				let rgb = m.color1;
				if (m.effect === 2) {
					// (the n-th character appears n fade-ins in, flashing from colour 2)
					const shown = index * m.fadeIn;
					if (shown > t) return;
					const since = t - shown;
					if (t <= fadeAt && since <= m.fxTime && m.fxTime > 0) {
						const k = 1 - since / m.fxTime;
						rgb = [0, 1, 2].map(i => m.color1[i] + (m.color2[i] - m.color1[i]) * k) as typeof rgb;
					}
				}
				g.fillStyle = `rgba(${rgb[0] | 0}, ${rgb[1] | 0}, ${rgb[2] | 0}, ${(1 - out) * fadeIn})`;
				g.fillText(ch, x, y);
				x += g.measureText(ch).width;
			}
			y += size;
		});
	}
}
