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
	shader: string;
	baseTexture: string;    // under materials/, without .vtf
	alphaTest: boolean;
	additive: boolean;
	noCull: boolean;
	unlit: boolean;         // not lightmapped (UnlitGeneric, sprites, ...)
	alpha: number;          // $alpha
	color: [number, number, number];  // $color / $color2 tint
	bumpMap: string;        // $bumpmap (a normal map, or a self-shadowed one with $ssbump)
	ssbump: boolean;
	envMap: string;         // $envmap: a cubemap reflected (env_cubemap: the nearest one)
	envTint: [number, number, number];
	envMask: 'none' | 'base' | 'bump' | 'texture';  // where the reflection's strength comes from
	envMaskTexture: string;
	envContrast: number;
	envSaturation: [number, number, number];  // per channel (one number for all three)
	refractTint: [number, number, number];  // Refract: what's behind is multiplied by this
	refractTintTexture: string;             // (times twice this texture, where there is one)
	detail: string;          // $detail: a second texture at $detailscale x the base's coordinates
	detailScale: number;
	detailBlendFactor: number;
	detailBlendMode: number; // how it combines (LightmappedGeneric's TCOMBINE_ modes)
	envLightScale: number;   // $envmaplightscale: reflections darkened where the light is
	selfIllum: boolean;      // $selfillum (VertexLitGeneric): unlit where the mask (or base alpha) says
	selfIllumMask: string;
	selfIllumTint: [number, number, number];
	phong: boolean;          // $phong (VertexLitGeneric): highlights from the model's lights
	phongExponent: number;
	phongBoost: number;
	phongFresnel: [number, number, number];  // $phongfresnelranges: low, mid, high
	phongTint: [number, number, number];
	phongBaseMask: boolean;  // $basemapalphaphongmask: the mask is in the base texture's alpha (else the bump map's)
	phongExponentTexture: string;  // $phongexponenttexture: exponent 1 + 149 x its red
	cloakFactor: number;     // $cloakfactor (VertexLitGeneric): how far it's drawn as the screen behind it
	normalMap: string;       // $normalmap (Refract: its alpha masks the reflection)
	water: WaterParams | null;  // the Water shader's settings
}

// a Water material: a flowing normal map (and, with a base texture, a
// sludge layer flowing over it) over fog, with a reflection by fresnel
export interface WaterParams {
	normalMap: string;
	flowMap: string;         // per map: the flow direction in red/green, the sludge's mask in alpha
	noiseTexture: string;    // offsets the flow's cycle per place
	worldUvScale: number;    // the flow map across the face's texture coordinates
	normalUvScale: number;   // world units per normal map repeat
	timeInterval: number;    // seconds per flow cycle (half of it per layer)
	scrollDistance: number;
	bumpStrength: number;
	noiseScale: number;
	colorUvScale: number;    // world units per sludge texture repeat
	colorInterval: number;
	colorScroll: number;
	colorLerpExp: number;
	colorDisplace: number;   // parallax by the normal map's alpha
	reflect: 'planar' | 'cube' | 'none';  // a reflection of the scene ($reflecttexture), or the cubemap
	reflectSkyboxOnly: boolean;
	reflectAmount: number;   // how far the normal bends the reflection
	reflectTint: [number, number, number];
	refract: boolean;        // what's below shows through ($refracttexture)
	fogColor: [number, number, number];
	lightmapFog: boolean;    // the fog colour lit by the light map
	aboveWater: boolean;     // the top side (the other is the view from under the surface)
}

const MISSING: MaterialInfo = {
	noPortal: false, translucent: false, liquid: false, found: false, shader: '', baseTexture: '', alphaTest: false,
	additive: false, noCull: false, unlit: false, alpha: 1, color: [1, 1, 1], bumpMap: '', ssbump: false,
	envMap: '', envTint: [1, 1, 1], envMask: 'none', envMaskTexture: '', envContrast: 0, envSaturation: [1, 1, 1],
	refractTint: [1, 1, 1], refractTintTexture: '',
	detail: '', detailScale: 4, detailBlendFactor: 1, detailBlendMode: 0, envLightScale: 0,
	selfIllum: false, selfIllumMask: '', selfIllumTint: [1, 1, 1],
	phong: false, phongExponent: 5, phongBoost: 1, phongFresnel: [0, 0.5, 1], phongTint: [1, 1, 1], phongBaseMask: false, phongExponentTexture: '',
	cloakFactor: 0, normalMap: '', water: null,
};

function parseColor(v: string | undefined): [number, number, number] | null {
	if (!v) return null;
	const nums = v.replace(/[[\]{}]/g, ' ').trim().split(/\s+/).map(Number);
	if (nums.length < 3 || nums.some(n => !isFinite(n))) return null;
	const scale = v.includes('{') ? 1 / 255 : 1;
	return [nums[0] * scale, nums[1] * scale, nums[2] * scale];
}

// a tint: three numbers, or one for all three
function parseTint(v: string | undefined): [number, number, number] | null {
	if (!v) return null;
	const c = parseColor(v);
	if (c) return c;
	const n = Number(v.replace(/[[\]{}]/g, ' ').trim());
	return isFinite(n) ? [n, n, n] : null;
}

// the conditional blocks Portal 2 applies on PC in HDR, at high GPU settings
const CONDITIONS = new Set(['hdr', 'hdr_dx9', '>=dx90', '>=dx90_20b', 'dx90', 'dx90_20b', '>=dx80', '>=dx81', 'srgb', 'srgb_pc', '>=hdr_dx9', 'gpu>=1', 'gpu>=2']);

// whether a condition on a parameter holds ("!" negates)
function condition(c: string): boolean {
	return c.startsWith('!') ? !condition(c.slice(1)) : CONDITIONS.has(c);
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

	// a material's shader and parameters (lower-case keys), patches resolved
	raw(name: string): Promise<{shader: string; params: Map<string, string>} | null> {
		return this.params(`materials/${name.toLowerCase().replace(/\\/g, '/').replace(/\.vmt$/, '')}.vmt`, 0);
	}

	private async params(path: string, depth: number): Promise<{shader: string; params: Map<string, string>} | null> {
		const text = await this.files.text(path);
		if (!text) return null;
		const kv = parseKeyValues(text);
		const root = kv[0];
		if (!root || typeof root.value === 'string') return null;
		const shader = root.key;
		const params = new Map<string, string>();
		// (blocks for the renderer's settings: those for an HDR, DX9-class,
		// sRGB PC renderer override the plain values, in order)
		// (and keys behind a condition: "gpu>=1?$key", "!gameconsole?$key")
		const take = (list: KV) => {
			for (const e of list) {
				if (typeof e.value !== 'string') continue;
				const q = e.key.indexOf('?');
				if (q < 0) params.set(e.key, e.value);
				else if (condition(e.key.slice(0, q))) params.set(e.key.slice(q + 1), e.value);
			}
			for (const e of list) if (typeof e.value !== 'string' && CONDITIONS.has(e.key)) take(e.value);
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
		if (!m) return MISSING;
		const p = m.params;
		const shader = m.shader;
		const alphaTest = truthy(p.get('$alphatest'));
		return {
			found: true,
			shader,
			noPortal: truthy(p.get('%noportal')),
			translucent: truthy(p.get('$translucent')) || shader === 'refract' || truthy(p.get('$additive')),
			// (by the name's last part: a map's patch folder can say "goo" too)
			liquid: shader === 'water' || /water|goo/.test(name.slice(name.lastIndexOf('/') + 1)) && shader !== 'lightmappedgeneric',
			// (eyes: the iris texture, projected by the model loader)
			baseTexture: (p.get('$basetexture') ?? (/^eye/.test(shader) ? p.get('$iris') : undefined) ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, ''),
			alphaTest,
			additive: truthy(p.get('$additive')),
			noCull: truthy(p.get('$nocull')),
			unlit: /unlitgeneric|unlittwotexture|sprite|monitorscreen|^sky$/.test(shader),
			alpha: p.has('$alpha') ? Number(p.get('$alpha')) || 0 : 1,
			color: parseColor(p.get('$color')) ?? parseColor(p.get('$color2')) ?? parseColor(p.get('$refracttint')) ?? [1, 1, 1],
			bumpMap: (p.get('$bumpmap') ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, ''),
			ssbump: truthy(p.get('$ssbump')),
			envMap: (p.get('$envmap') ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, ''),
			envTint: parseTint(p.get('$envmaptint')) ?? [1, 1, 1],
			envMask: truthy(p.get('$basealphaenvmapmask')) ? 'base' : truthy(p.get('$normalmapalphaenvmapmask')) ? 'bump' : p.get('$envmapmask') ? 'texture' : 'none',
			envMaskTexture: (p.get('$envmapmask') ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, ''),
			envContrast: Number(p.get('$envmapcontrast') ?? 0) || 0,
			envSaturation: parseTint(p.get('$envmapsaturation')) ?? [1, 1, 1],
			refractTint: parseColor(p.get('$refracttint')) ?? [1, 1, 1],
			refractTintTexture: (p.get('$refracttinttexture') ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.(vtf|vmt)$/, ''),
			detail: (p.get('$detail') ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, ''),
			detailScale: p.has('$detailscale') ? Number(p.get('$detailscale')) || 4 : 4,
			detailBlendFactor: p.has('$detailblendfactor') ? Number(p.get('$detailblendfactor')) || 0 : 1,
			detailBlendMode: Number(p.get('$detailblendmode') ?? 0) || 0,
			envLightScale: Number(p.get('$envmaplightscale') ?? 0) || 0,
			selfIllum: truthy(p.get('$selfillum')),
			// (some name the mask with a .tga extension; the engine finds the .vtf)
			selfIllumMask: (p.get('$selfillummask') ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.(vtf|tga)$/, ''),
			selfIllumTint: parseTint(p.get('$selfillumtint')) ?? [1, 1, 1],
			phong: truthy(p.get('$phong')),
			phongExponent: p.has('$phongexponent') ? Number(p.get('$phongexponent')) || 5 : 5,
			phongBoost: p.has('$phongboost') ? Number(p.get('$phongboost')) || 0 : 1,
			phongFresnel: (parseColor(p.get('$phongfresnelranges')) ?? [0, 0.5, 1]) as [number, number, number],
			phongTint: parseTint(p.get('$phongtint')) ?? [1, 1, 1],
			phongBaseMask: truthy(p.get('$basemapalphaphongmask')),
			phongExponentTexture: (p.get('$phongexponenttexture') ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, ''),
			cloakFactor: Number(p.get('$cloakfactor') ?? 0) || 0,
			normalMap: texturePath(p.get('$normalmap')),
			water: shader === 'water' ? waterParams(p) : null,
		};
	}
}

const texturePath = (v: string | undefined) => (v ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '');

function waterParams(p: Map<string, string>): WaterParams {
	const num = (k: string, d: number) => p.has(k) && isFinite(Number(p.get(k))) ? Number(p.get(k)) : d;
	const envMap = p.has('$envmap');
	return {
		normalMap: texturePath(p.get('$normalmap') ?? 'dev/water_normal'),
		flowMap: texturePath(p.get('$flowmap')),
		noiseTexture: texturePath(p.get('$flow_noise_texture')),
		worldUvScale: num('$flow_worlduvscale', 1),
		normalUvScale: num('$flow_normaluvscale', 1),
		timeInterval: num('$flow_timeintervalinseconds', 1),
		scrollDistance: num('$flow_uvscrolldistance', 0),
		bumpStrength: num('$flow_bumpstrength', 1),
		noiseScale: num('$flow_noise_scale', 0),
		colorUvScale: num('$color_flow_uvscale', 1),
		colorInterval: num('$color_flow_timeintervalinseconds', 1),
		colorScroll: num('$color_flow_uvscrolldistance', 0),
		colorLerpExp: num('$color_flow_lerpexp', 1),
		colorDisplace: num('$color_flow_displacebynormalstrength', 0),
		// (with neither, no reflection: its tint is zeroed)
		reflect: p.has('$reflecttexture') ? 'planar' : envMap ? 'cube' : 'none',
		reflectSkyboxOnly: truthy(p.get('$reflectskyboxonly')),
		reflectAmount: num('$reflectamount', 0.8),
		reflectTint: parseColor(p.get('$reflecttint')) ?? [1, 1, 1],
		refract: p.has('$refracttexture'),
		fogColor: parseColor(p.get('$fogcolor')) ?? [1, 0, 0],
		lightmapFog: truthy(p.get('$lightmapwaterfog')),
		aboveWater: truthy(p.get('$abovewater')),
	};
}
