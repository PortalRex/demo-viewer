// Ropes and cables (C_RopeKeyframe). The demo has each rope's ends, length
// and slack but not its shape: the client hangs it itself, as a chain of
// nodes falling under gravity (1500) with springs that only resist being
// stretched, stepped at 50 Hz with a little damping. Here each rope is
// stepped the same way until it has settled (again whenever its ends move),
// and drawn as the SplineRope shader draws it: a Catmull-Rom strip through
// the nodes turned to face the camera, its texture across and along it,
// lit by the light at its nodes with a half-lambert from the cable's normal
// map.
import * as THREE from 'three';
import type {EffectAssets} from './effects.ts';

const GRAVITY = 1500;          // ROPE_GRAVITY
const TIME_STEP = 1 / 50;      // CBaseRopePhysics's
const DAMP = 0.98;             // (its "energy")
const ITERATIONS = 3;          // spring passes per step
const SETTLE_STEPS = 400;      // 8 s: hanging still
const SLACK_FUDGE = -100;      // ROPESLACK_FUDGEFACTOR

export interface RopeSpec {
	key: string;
	start: THREE.Vector3;
	end: THREE.Vector3 | null;     // null: dangling
	startLocked: boolean;
	endLocked: boolean;
	length: number;                // m_RopeLength
	slack: number;                 // m_Slack
	segments: number;              // m_nSegments (nodes)
	subdiv: number;                // m_Subdiv (255: the default, 2)
	width: number;
	textureScale: number;
	material: string;              // under materials/, without .vmt
	light: (p: THREE.Vector3) => [number, number, number];
}

interface Rope {
	mesh: THREE.Mesh;
	nodes: THREE.Vector3[];
	shapeKey: string;
	material: string;
}

const VERTEX = `
	attribute vec3 ropeTangent;
	attribute float ropeSide;
	attribute float ropeWidth;
	attribute vec3 color;
	varying vec2 vUv;
	varying vec3 vLight;
	void main() {
		vec4 world = modelMatrix * vec4(position, 1.0);
		vec3 ofs = normalize(cross(world.xyz - cameraPosition, normalize(ropeTangent)));
		world.xyz += ofs * ropeWidth * (ropeSide - 0.5);
		vUv = uv;
		vLight = color;
		gl_Position = projectionMatrix * viewMatrix * world;
	}`;

const FRAGMENT = `
	uniform sampler2D map;
	uniform sampler2D normalMap;
	uniform float alphaTest;
	varying vec2 vUv;
	varying vec3 vLight;
	void main() {
		vec4 tex = texture2D(map, vUv);
		if (tex.a < alphaTest) discard;
		float n = (texture2D(normalMap, vUv).z - 0.5) * 2.0;
		float l = n * 0.5 + 0.5;
		gl_FragColor = vec4(l * l * tex.rgb * vLight, 1.0);
	}`;

export class Ropes {
	readonly group = new THREE.Group();
	private ropes = new Map<string, Rope>();
	private materials = new Map<string, THREE.ShaderMaterial>();
	private textureHeights = new Map<string, number>();
	private assets: EffectAssets;

	// called when a new mesh joins the group (its material's shader is to compile)
	onNewMesh = () => {};

	constructor(assets: EffectAssets) {
		this.assets = assets;
	}

	update(specs: RopeSpec[]) {
		const seen = new Set<string>();
		for (const s of specs) {
			seen.add(s.key);
			let rope = this.ropes.get(s.key);
			const fmt = (v: THREE.Vector3 | null) => v ? `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}` : '-';
			const shapeKey = `${fmt(s.start)}|${fmt(s.end)}|${s.length}|${s.slack}|${s.segments}|${s.width}|${s.material}|${s.startLocked}|${s.endLocked}`;
			if (rope && rope.shapeKey === shapeKey) {
				rope.mesh.visible = true;
				continue;
			}
			const nodes = this.settle(s, rope?.nodes);
			const geometry = this.strip(s, nodes);
			if (rope) {
				rope.mesh.geometry.dispose();
				rope.mesh.geometry = geometry;
				rope.mesh.material = this.material(s.material);
				rope.nodes = nodes;
				rope.shapeKey = shapeKey;
				rope.mesh.visible = true;
			} else {
				const mesh = new THREE.Mesh(geometry, this.material(s.material));
				mesh.frustumCulled = false;
				this.group.add(mesh);
				this.ropes.set(s.key, {mesh, nodes, shapeKey, material: s.material});
				this.onNewMesh();
			}
		}
		for (const [key, rope] of this.ropes) if (!seen.has(key)) rope.mesh.visible = false;
	}

	// the nodes once the rope hangs still (from where they were, if it had
	// settled before)
	private settle(s: RopeSpec, from?: THREE.Vector3[]): THREE.Vector3[] {
		const n = Math.max(2, Math.min(10, s.segments));
		const total = Math.max(1, s.length + s.slack + SLACK_FUDGE);
		const springDist = total / (n - 1);
		const end = s.end ?? s.start.clone().add(new THREE.Vector3(0, 0, -total));
		const pos = from && from.length === n ? from.map(v => v.clone()) : Array.from({length: n}, (_, i) => s.start.clone().lerp(end, i / (n - 1)));
		const prev = pos.map(v => v.clone());
		const accel = 0.5 * GRAVITY * TIME_STEP * TIME_STEP;
		const lockEnd = s.end !== null && s.endLocked, lockStart = s.startLocked || !lockEnd;
		const d = new THREE.Vector3();
		for (let step = 0; step < SETTLE_STEPS; step++) {
			for (let i = 0; i < n; i++) {
				const p = pos[i];
				d.copy(p).sub(prev[i]).multiplyScalar(DAMP);
				prev[i].copy(p);
				p.add(d);
				p.z -= accel;
			}
			for (let it = 0; it < ITERATIONS; it++) {
				for (let i = 0; i < n - 1; i++) {
					d.copy(pos[i]).sub(pos[i + 1]);
					const dist = d.length();
					if (dist > springDist) {
						d.multiplyScalar((1 - springDist / dist) * 0.5);
						pos[i].sub(d);
						pos[i + 1].add(d);
					}
				}
				// (the locked ends stay put)
				if (lockStart) pos[0].copy(s.start);
				if (lockEnd) pos[n - 1].copy(end);
			}
		}
		return pos;
	}

	// a Catmull-Rom strip through the nodes: two vertices per point (one
	// each side, turned to the camera in the vertex shader)
	private strip(s: RopeSpec, nodes: THREE.Vector3[]): THREE.BufferGeometry {
		const slices = (s.subdiv !== 255 ? s.subdiv : 2) + 1;
		const n = nodes.length;
		const ext = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().multiplyScalar(2).sub(b);
		const pts = [ext(nodes[0], nodes[1]), ...nodes, ext(nodes[n - 1], nodes[n - 2])];
		const positions: number[] = [], tangents: number[] = [], sides: number[] = [], widths: number[] = [], uvs: number[] = [], colors: number[] = [];
		const index: number[] = [];
		const total = Math.max(1, s.length + s.slack + SLACK_FUDGE);
		const points = (n - 1) * slices + 1;
		const height = this.textureHeights.get(s.material) ?? 16;
		const du = (4 / Math.max(0.1, s.textureScale)) * total / points / height;
		const p = new THREE.Vector3(), t = new THREE.Vector3();
		let u = 0, k = 0;
		for (let seg = 0; seg < n - 1; seg++) {
			const [p0, p1, p2, p3] = [pts[seg], pts[seg + 1], pts[seg + 2], pts[seg + 3]];
			const light0 = s.light(nodes[seg]), light1 = s.light(nodes[seg + 1]);
			for (let j = seg === 0 ? 0 : 1; j <= slices; j++) {
				const f = j / slices;
				catmull(p0, p1, p2, p3, f, p);
				catmullTangent(p0, p1, p2, p3, f, t);
				if (t.lengthSq() < 1e-8) t.copy(p2).sub(p1);
				for (let side = 0; side < 2; side++) {
					positions.push(p.x, p.y, p.z);
					tangents.push(t.x, t.y, t.z);
					sides.push(side);
					widths.push(s.width);
					uvs.push(1 - side, u);
					colors.push(...[0, 1, 2].map(c => light0[c] + (light1[c] - light0[c]) * f));
				}
				if (k > 0) {
					const a = (k - 1) * 2, b = k * 2;
					index.push(a, a + 1, b, a + 1, b + 1, b);
				}
				k++;
				u += du;
			}
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		g.setAttribute('ropeTangent', new THREE.Float32BufferAttribute(tangents, 3));
		g.setAttribute('ropeSide', new THREE.Float32BufferAttribute(sides, 1));
		g.setAttribute('ropeWidth', new THREE.Float32BufferAttribute(widths, 1));
		g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
		g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
		g.setIndex(index);
		return g;
	}

	private material(name: string): THREE.ShaderMaterial {
		let m = this.materials.get(name);
		if (m) return m;
		m = new THREE.ShaderMaterial({
			uniforms: {map: {value: this.assets.white}, normalMap: {value: this.assets.white}, alphaTest: {value: 0}},
			vertexShader: VERTEX,
			fragmentShader: FRAGMENT,
			side: THREE.DoubleSide,
		});
		const mat = m;
		this.materials.set(name, mat);
		this.assets.materials.raw(name).then(async raw => {
			const base = raw?.params.get('$basetexture')?.toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '');
			const bump = (raw?.params.get('$bumpmap') ?? 'cable/cablenormalmap').toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '');
			const [map, normal] = await Promise.all([this.assets.texture(base), this.assets.texture(bump)]);
			mat.uniforms.map.value = map;
			mat.uniforms.normalMap.value = normal === this.assets.white ? flatNormal : normal;
			mat.uniforms.alphaTest.value = raw?.params.get('$alphatest') === '1' ? 0.5 : 0;
			const h = (map.image as {height?: number} | undefined)?.height;
			if (h && h !== this.textureHeights.get(name)) {
				this.textureHeights.set(name, h);
				// (the strips were laid out for a guessed height)
				for (const [, rope] of this.ropes) if (rope.material === name) rope.shapeKey = '';
			}
		});
		return mat;
	}

	clear() {
		for (const rope of this.ropes.values()) {
			rope.mesh.geometry.dispose();
			this.group.remove(rope.mesh);
		}
		this.ropes.clear();
	}

	dispose() {
		this.clear();
		for (const m of this.materials.values()) m.dispose();
		this.materials.clear();
	}
}

// (a normal map facing straight out, for a material without one)
const flatNormal = (() => {
	const t = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
	t.needsUpdate = true;
	return t;
})();

function catmull(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number, out: THREE.Vector3) {
	const t2 = t * t, t3 = t2 * t;
	const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
	return out.set(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

function catmullTangent(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number, out: THREE.Vector3) {
	const t2 = t * t;
	const f = (a: number, b: number, c: number, d: number) => 0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t2);
	return out.set(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}
