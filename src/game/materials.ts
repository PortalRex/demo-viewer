// Material (.vmt) properties the 3D view needs: whether portals can be
// placed on it (Portal 2 marks the ones they can't with %noportal), and
// whether it's see-through or a liquid. Map-specific "patch" materials are
// followed to the material they include.
import type {GameFiles} from './files.ts';

type KV = {key: string; value: string | KV}[];

function parseKeyValues(text: string): KV {
	let p = 0;
	const token = (): string | null => {
		for (;;) {
			while (p < text.length && /\s/.test(text[p])) p++;
			if (text.startsWith('//', p)) {
				while (p < text.length && text[p] !== '\n') p++;
				continue;
			}
			break;
		}
		if (p >= text.length) return null;
		const c = text[p];
		if (c === '{' || c === '}') {
			p++;
			return c;
		}
		if (c === '"') {
			const end = text.indexOf('"', p + 1);
			const s = text.slice(p + 1, end < 0 ? text.length : end);
			p = end < 0 ? text.length : end + 1;
			return s;
		}
		const start = p;
		while (p < text.length && !/[\s{}"]/.test(text[p])) p++;
		return text.slice(start, p);
	};
	const block = (): KV => {
		const out: KV = [];
		for (;;) {
			const k = token();
			if (k === null || k === '}') return out;
			if (k === '{') continue;
			const v = token();
			if (v === null) return out;
			out.push({key: k.toLowerCase(), value: v === '{' ? block() : v});
		}
	};
	return block();
}

export interface MaterialInfo {
	noPortal: boolean;
	translucent: boolean;
	liquid: boolean;
	found: boolean;
}

const truthy = (v: string | undefined) => v !== undefined && v !== '0' && v.toLowerCase() !== 'false';

export class Materials {
	private cache = new Map<string, Promise<MaterialInfo>>();
	readonly files: GameFiles;

	constructor(files: GameFiles) {
		this.files = files;
	}

	get(name: string): Promise<MaterialInfo> {
		const key = name.toLowerCase().replace(/\\/g, '/').replace(/\.vmt$/, '');
		let p = this.cache.get(key);
		if (!p) {
			p = this.load(key, 0);
			this.cache.set(key, p);
		}
		return p;
	}

	private async params(path: string, depth: number): Promise<{shader: string; params: Map<string, string>} | null> {
		const text = await this.files.text(path);
		if (!text) return null;
		const kv = parseKeyValues(text);
		const root = kv[0];
		if (!root || typeof root.value === 'string') return null;
		const shader = root.key;
		const params = new Map<string, string>();
		const take = (list: KV) => {
			for (const e of list) if (typeof e.value === 'string') params.set(e.key, e.value);
		};
		if (shader === 'patch' && depth < 4) {
			const include = root.value.find(e => e.key === 'include');
			const base = typeof include?.value === 'string' ? await this.params(include.value.toLowerCase().replace(/\\/g, '/'), depth + 1) : null;
			if (base) for (const [k, v] of base.params) params.set(k, v);
			for (const e of root.value) if ((e.key === 'insert' || e.key === 'replace') && typeof e.value !== 'string') take(e.value);
			return {shader: base?.shader ?? shader, params};
		}
		take(root.value);
		return {shader, params};
	}

	private async load(name: string, depth: number): Promise<MaterialInfo> {
		const m = await this.params(`materials/${name}.vmt`, depth);
		if (!m) return {noPortal: false, translucent: false, liquid: false, found: false};
		const p = m.params;
		return {
			found: true,
			noPortal: truthy(p.get('%noportal')),
			translucent: truthy(p.get('$translucent')) || m.shader === 'refract' || truthy(p.get('$alphatest')) && /glass|grate|fence/.test(name),
			liquid: m.shader === 'water' || /water|goo/.test(name) && m.shader !== 'lightmappedgeneric',
		};
	}
}
