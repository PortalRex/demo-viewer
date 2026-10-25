// Gameplay visuals: lasers, light bridges, excursion funnels, fizzlers and
// the portal surface material (the portal views themselves are rendered in
// View3D). Their shapes come from the entities' networked state; their looks
// from the game's own materials (SolidEnergy, sprites), approximated here.
import * as THREE from 'three';
import type {PropValue} from '../net/props.ts';
import type {Materials} from '../game/materials.ts';
import type {TextureCache} from './textures.ts';

export const vec3 = (v: PropValue | undefined): THREE.Vector3 | null =>
	Array.isArray(v) && v.length >= 3 && typeof v[0] === 'number' ? new THREE.Vector3(v[0] as number, v[1] as number, v[2] as number) : null;

const UP = new THREE.Vector3(0, 1, 0);

// a unit cylinder along +Y placed from a to b
function placeBetween(o: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, radius: number) {
	const d = b.clone().sub(a);
	const len = d.length();
	o.position.copy(a).addScaledVector(d, 0.5);
	o.quaternion.setFromUnitVectors(UP, len > 0 ? d.clone().divideScalar(len) : UP);
	o.scale.set(radius, Math.max(len, 0.001), radius);
}

const num = (p: Map<string, string>, key: string, d: number) => {
	const v = Number((p.get(key) ?? '').replace(/["[\]{}]/g, '').trim().split(/\s+/)[0]);
	return isFinite(v) ? v : d;
};
const vec = (p: Map<string, string>, key: string, d: [number, number, number]): [number, number, number] => {
	const v = (p.get(key) ?? '').replace(/["[\]{}]/g, ' ').trim().split(/\s+/).map(Number);
	return v.length >= 3 && v.every(isFinite) ? [v[0], v[1], v[2]] : d;
};
// "$outputintensity" comes per platform; "!srgb?" is for platforms without
// sRGB blending (not PC)
const outputIntensity = (p: Map<string, string>) => {
	for (const k of ['srgb_pc?$outputintensity', '$outputintensity']) if (p.has(k)) return num(p, k, 1);
	return 1;
};

// Loads effect materials and textures for the current map
export class EffectAssets {
	readonly materials: Materials;
	readonly textures: TextureCache;
	white: THREE.Texture;

	constructor(materials: Materials, textures: TextureCache) {
		this.materials = materials;
		this.textures = textures;
		this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
		this.white.needsUpdate = true;
	}

	async texture(path: string | undefined): Promise<THREE.Texture> {
		if (!path) return this.white;
		return (await this.textures.get(path.toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, ''))) ?? this.white;
	}
}

// ---- SolidEnergy (light bridges, funnels) ----
// base x detail1 (x2, or blended by base alpha) then detail2 (added or
// multiplied), each with its own scrolling texture transform; additive.

function solidEnergyMaterial(): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		uniforms: {
			base: {value: null}, detail1: {value: null}, detail2: {value: null},
			baseOffset: {value: new THREE.Vector2()}, detail1Offset: {value: new THREE.Vector2()}, detail2Offset: {value: new THREE.Vector2()},
			detail1Mode: {value: 0}, detail2Mode: {value: 0}, hasDetail1: {value: 0}, hasDetail2: {value: 0},
			intensity: {value: 1}, color: {value: new THREE.Color(1, 1, 1)}, edgeFade: {value: 0},
			// $tangenttopacityranges (opacity by how the view runs along the
			// surface's T axis, and its front faces' share), and a vertex colour
			tangentRanges: {value: new THREE.Vector4(1, 1, 1, 1)}, useTangent: {value: 0}, tangentAround: {value: 0},
			vertexColor: {value: new THREE.Color(1, 1, 1)}, useVertexColor: {value: 0},
		},
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		blending: THREE.AdditiveBlending,
		vertexShader: `
			uniform float tangentAround;
			varying vec2 vUv;
			varying vec3 vNormalV;
			varying vec3 vViewDir;
			varying vec3 vTangentV;
			varying vec3 vAxisV;
			void main() {
				vUv = uv;
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vNormalV = normalize(normalMatrix * normal);
				// T (where v increases) runs along the column (its local Y), or
				// round it when the texture's u runs along it (funnels)
				vec3 t = tangentAround > 0.5 ? vec3(-position.z, 0.0, position.x) : vec3(0.0, 1.0, 0.0);
				vTangentV = normalize((modelViewMatrix * vec4(t, 0.0)).xyz);
				vAxisV = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
				vViewDir = normalize(-mv.xyz);
				gl_Position = projectionMatrix * mv;
			}`,
		fragmentShader: `
			uniform sampler2D base, detail1, detail2;
			uniform vec2 baseOffset, detail1Offset, detail2Offset;
			uniform float detail1Mode, detail2Mode, hasDetail1, hasDetail2, intensity, edgeFade, useTangent, useVertexColor;
			uniform vec3 color, vertexColor;
			uniform vec4 tangentRanges;
			varying vec2 vUv;
			varying vec3 vNormalV;
			varying vec3 vViewDir;
			varying vec3 vTangentV;
			varying vec3 vAxisV;
			uniform float tangentAround;
			void main() {
				vec4 c = texture2D(base, vUv + baseOffset);
				if (hasDetail1 > 0.5) {
					vec3 d1 = texture2D(detail1, vUv + detail1Offset).rgb;
					c.rgb = detail1Mode < 0.5 ? c.rgb * 2.0 * d1 : mix(c.rgb * d1, c.rgb, c.a);
				}
				if (hasDetail2 > 0.5) {
					vec3 d2 = texture2D(detail2, vUv + detail2Offset).rgb;
					// (added, scaled by detail 1 when there is one; or multiplied)
					if (hasDetail1 > 0.5 && detail2Mode < 0.5) d2 *= texture2D(detail1, vUv + detail1Offset).rgb;
					c.rgb = detail2Mode < 0.5 ? c.rgb + d2 : c.rgb * d2;
				}
				vec3 view = normalize(vViewDir);
				float alpha = 1.0;
				if (useTangent > 0.5) {
					// as SolidEnergy's tangent-T opacity: faint looking along the
					// column, and on its near side; additive, so it scales the colour
					// (funnels: against the view with its part along the axis, S,
					// taken out, as the shader's tangent-aligned view)
					vec3 aligned = tangentAround > 0.5 ? normalize(cross(vAxisV, cross(vAxisV, view))) : view;
					float along = abs(dot(normalize(vTangentV), aligned));
					alpha = mix(tangentRanges.x, tangentRanges.y, pow(along, tangentRanges.z));
					float front = dot(view, normalize(vNormalV)) * 0.5 + 0.5;
					alpha *= mix(1.0, tangentRanges.w, front * front);
					c.rgb *= 1.0 + alpha;
				} else {
					// funnels fade where the surface faces the viewer
					float facing = abs(dot(normalize(vNormalV), view));
					c.rgb *= mix(1.0, 1.0 - pow(facing, 2.0) * 0.85, edgeFade);
				}
				// the vertex colour, more saturated where it's fainter
				if (useVertexColor > 0.5) c.rgb *= pow(vertexColor, vec3((2.0 - alpha) * 2.0));
				gl_FragColor = vec4(max(c.rgb, 0.0) * color * intensity, 1.0);
				#ifdef TONE_MAPPING
				// SolidEnergy caps the exposure it takes at 1
				gl_FragColor.rgb /= max(toneMappingExposure, 1.0);
				#endif
				#include <tonemapping_fragment>
				#include <colorspace_fragment>
			}`,
	});
}

async function loadSolidEnergy(assets: EffectAssets, name: string, m: THREE.ShaderMaterial) {
	const raw = await assets.materials.raw(name);
	if (!raw) return;
	const p = raw.params;
	const u = m.uniforms;
	u.base.value = await assets.texture(p.get('$basetexture'));
	if (p.has('$detail1')) {
		u.detail1.value = await assets.texture(p.get('$detail1'));
		u.hasDetail1.value = 1;
		u.detail1Mode.value = num(p, '$detail1blendmode', 0);
	}
	if (p.has('$detail2')) {
		u.detail2.value = await assets.texture(p.get('$detail2'));
		u.hasDetail2.value = 1;
		u.detail2Mode.value = num(p, '$detail2blendmode', 0);
	}
	u.intensity.value = outputIntensity(p);
	u.color.value.setRGB(...vec(p, '$color', [1, 1, 1]));
	if (p.has('$tangenttopacityranges')) {
		const r = (p.get('$tangenttopacityranges') ?? '').replace(/["[\]{}]/g, ' ').trim().split(/\s+/).map(Number);
		if (r.length >= 4 && r.every(isFinite)) {
			u.tangentRanges.value.set(r[0], r[1], r[2], r[3]);
			u.useTangent.value = 1;
		}
	}
}

// ---- lasers ----

export class Laser {
	readonly group = new THREE.Group();
	private segments: THREE.Mesh[] = [];
	private material: THREE.MeshBasicMaterial;

	constructor(assets: EffectAssets | null) {
		this.material = new THREE.MeshBasicMaterial({color: 0xff4020, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false});
		assets?.texture('effects/redlaser1').then(t => {
			if (t === assets.white) return;
			const tex = t.clone();
			// the texture's u runs across the beam (hot core, red edges), v along it
			tex.wrapS = THREE.ClampToEdgeWrapping;
			tex.wrapT = THREE.RepeatWrapping;
			tex.needsUpdate = true;
			this.material.map = tex;
			this.material.color.setRGB(1, 1, 1);
			this.material.needsUpdate = true;
		});
	}

	// segments: pairs of points (the beam, then its continuations through
	// portals), drawn as ribbons turned towards the camera
	set(points: [THREE.Vector3, THREE.Vector3][], camera: THREE.Vector3) {
		while (this.segments.length < points.length) {
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(18), 3));
			g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(12), 2));
			const mesh = new THREE.Mesh(g, this.material);
			mesh.frustumCulled = false;
			mesh.renderOrder = 2;
			this.group.add(mesh);
			this.segments.push(mesh);
		}
		const width = 12;
		this.segments.forEach((mesh, i) => {
			const p = points[i];
			mesh.visible = !!p;
			if (!p) return;
			const [a, b] = p;
			const dir = b.clone().sub(a);
			const len = dir.length();
			const mid = a.clone().add(b).multiplyScalar(0.5);
			const side = dir.clone().cross(camera.clone().sub(mid)).normalize().multiplyScalar(width / 2);
			const q = [a.clone().sub(side), a.clone().add(side), b.clone().add(side), b.clone().sub(side)];
			const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
			const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
			const uvs = [[0, 0], [1, 0], [1, len / 128], [0, len / 128]];
			[0, 1, 2, 0, 2, 3].forEach((k, j) => {
				pos.setXYZ(j, q[k].x, q[k].y, q[k].z);
				uv.setXY(j, uvs[k][0], uvs[k][1]);
			});
			pos.needsUpdate = uv.needsUpdate = true;
		});
	}
}

// ---- light bridges (effects/projected_wall) ----

export class Bridge {
	readonly mesh: THREE.Mesh;
	private geometry = new THREE.BufferGeometry();
	private material = solidEnergyMaterial();

	constructor(assets: EffectAssets | null) {
		this.mesh = new THREE.Mesh(this.geometry, this.material);
		this.mesh.renderOrder = 2;
		this.mesh.frustumCulled = false;
		if (assets) loadSolidEnergy(assets, 'effects/projected_wall', this.material);
	}

	// start/end along the bridge, `right` across it, `width` in units
	set(start: THREE.Vector3, end: THREE.Vector3, right: THREE.Vector3, width: number, time: number) {
		const h = right.clone().multiplyScalar(width / 2);
		const len = start.distanceTo(end);
		const p = [start.clone().sub(h), start.clone().add(h), end.clone().add(h), end.clone().sub(h)];
		const pos: number[] = [], uv: number[] = [], nrm: number[] = [];
		const n = right.clone().cross(end.clone().sub(start)).normalize();
		// one texture repeat per bridge width along its length
		const uvs = [[0, 0], [1, 0], [1, len / width], [0, len / width]];
		for (const i of [0, 1, 2, 0, 2, 3]) {
			pos.push(p[i].x, p[i].y, p[i].z);
			uv.push(uvs[i][0], uvs[i][1]);
			nrm.push(n.x, n.y, n.z);
		}
		this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
		this.geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
		// projected_wall's proxies: base drifts along, detail1 sweeps and
		// races, detail2 creeps
		const u = this.material.uniforms;
		u.baseOffset.value.set(0, 0.15 * time);
		u.detail1Offset.value.set(0.47 + 0.47 * Math.sin((time + 3) * 2 * Math.PI / 5), -3 * time);
		u.detail2Offset.value.set(0, 0.18 * time);
	}
}

// ---- excursion funnels (effects/tractor_beam) ----

// Two columns as the game draws them: tractor_beam at radius 58 and
// tractor_beam2 around it at 60, coloured by vertex colour (blue, or orange
// when reversed)
export class Funnel {
	readonly mesh = new THREE.Group();
	private columns: {mesh: THREE.Mesh; material: THREE.ShaderMaterial; radius: number}[] = [];

	constructor(assets: EffectAssets | null) {
		for (const [name, radius] of [['effects/tractor_beam', 58], ['effects/tractor_beam2', 60]] as const) {
			const material = solidEnergyMaterial();
			const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 64, 1, true), material);
			mesh.renderOrder = 2;
			material.uniforms.edgeFade.value = 1;
			material.uniforms.useVertexColor.value = 1;
			material.uniforms.tangentAround.value = 1;
			if (assets) loadSolidEnergy(assets, name, material);
			this.mesh.add(mesh);
			this.columns.push({mesh, material, radius});
		}
	}

	set(start: THREE.Vector3, end: THREE.Vector3, _radius: number, reversed: boolean, time: number) {
		// tractor_beam's scroll comes from the TractorBeam proxy (with the
		// flow); tractor_beam2's is a fixed -0.4
		const flow = (reversed ? -1 : 1) * 0.25 * time, fixed = -0.4 * time;
		const len = start.distanceTo(end);
		this.columns.forEach(({mesh, radius, material}, n) => {
			placeBetween(mesh, start, end, radius);
			// as the client's column mesh (C_Trigger_TractorBeam): u along the
			// funnel, one repeat per 256 units; v once round it
			const g = mesh.geometry as THREE.CylinderGeometry;
			const uv = g.getAttribute('uv') as THREE.BufferAttribute;
			if (g.userData.len !== len) {
				g.userData.len = len;
				const base = (g.userData.baseUv ??= Float32Array.from(uv.array as Float32Array)) as Float32Array;
				for (let i = 0; i < uv.count; i++) uv.setXY(i, base[i * 2 + 1] * len / 256, base[i * 2]);
				uv.needsUpdate = true;
			}
			// TextureScroll proxies: rate along the scroll angle
			const scroll = (v: THREE.Vector2, rate: number, angle: number) => v.set(Math.cos(angle * Math.PI / 180) * rate, Math.sin(angle * Math.PI / 180) * rate);
			const u = material.uniforms;
			if (n === 0) {
				scroll(u.baseOffset.value, flow, -180);
				scroll(u.detail1Offset.value, -0.1 * flow, 190);
				scroll(u.detail2Offset.value, 1.15 * flow, 180);
			} else {
				scroll(u.baseOffset.value, fixed, 70);
				scroll(u.detail1Offset.value, fixed, 90);
				scroll(u.detail2Offset.value, fixed, 0);
			}
			// the client's vertex colours: (10, 160, 255), reversed (255, 160, 32)
			u.vertexColor.value.setRGB(...(reversed ? [1, 0.627, 0.125] as const : [0.039, 0.627, 1] as const), THREE.LinearSRGBColorSpace);
		});
	}
}

// ---- fizzlers (SolidEnergy flowmap materials on the trigger's faces) ----
// The ripple texture, in world space, is pushed along the flow map in two
// phases that cross-fade; its alpha tints the flow colour; the bounds
// texture (in the face's own texture space) fades it out at the edges.

export function fizzlerMaterial(assets: EffectAssets | null, name: string): THREE.ShaderMaterial {
	const m = new THREE.ShaderMaterial({
		uniforms: {
			base: {value: null}, flow: {value: null}, bounds: {value: null},
			time: {value: 0}, interval: {value: 1.2}, scroll: {value: 0.25}, worldScale: {value: 0.008},
			flowColor: {value: new THREE.Color(0.025, 0.08, 0.1)}, intensity: {value: 2.0},
		},
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		blending: THREE.AdditiveBlending,
		vertexShader: `
			varying vec2 vUv;
			varying vec2 vWorldUv;
			void main() {
				vUv = uv;
				vec3 w = (modelMatrix * vec4(position, 1.0)).xyz;
				vec3 n = abs(normalize(mat3(modelMatrix) * normal));
				// world coordinates on the plane the face mostly lies in
				vWorldUv = n.x > n.y && n.x > n.z ? w.yz : n.y > n.z ? w.xz : w.xy;
				gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
			}`,
		fragmentShader: `
			uniform sampler2D base, flow, bounds;
			uniform float time, interval, scroll, worldScale, intensity;
			uniform vec3 flowColor;
			varying vec2 vUv;
			varying vec2 vWorldUv;
			void main() {
				vec4 b = texture2D(bounds, vUv);
				vec2 f = (texture2D(flow, vUv).rg * 2.0 - 1.0) * b.r;
				float t1 = fract(time / interval), t2 = fract(t1 + 0.5);
				float w1 = 1.0 - abs(t1 * 2.0 - 1.0);
				vec2 uv = vWorldUv * worldScale;
				vec4 c = texture2D(base, uv + f * t1 * scroll) * w1 + texture2D(base, uv + f * t2 * scroll) * (1.0 - w1);
				vec3 rgb = (c.a * flowColor + b.g * flowColor * 4.0) * b.b * intensity;
				gl_FragColor = vec4(rgb, 1.0);
				#ifdef TONE_MAPPING
				// SolidEnergy caps the exposure it takes at 1
				gl_FragColor.rgb /= max(toneMappingExposure, 1.0);
				#endif
				#include <tonemapping_fragment>
				#include <colorspace_fragment>
			}`,
	});
	if (assets) {
		assets.materials.raw(name).then(async raw => {
			if (!raw) return;
			const p = raw.params;
			const u = m.uniforms;
			const repeat = (t: THREE.Texture) => {
				const c = t.clone();
				c.wrapS = c.wrapT = THREE.RepeatWrapping;
				c.needsUpdate = true;
				return c;
			};
			u.base.value = repeat(await assets.texture(p.get('$basetexture')));
			u.flow.value = await assets.texture(p.get('$flowmap'));
			u.bounds.value = await assets.texture(p.get('$flowbounds'));
			u.interval.value = num(p, '$flow_timeintervalinseconds', 1.2);
			u.scroll.value = num(p, '$flow_uvscrolldistance', 0.25);
			u.worldScale.value = num(p, '$flow_worlduvscale', 0.008);
			u.flowColor.value.setRGB(...vec(p, '$flow_color', [0.025, 0.08, 0.1]));
			u.intensity.value = outputIntensity(p);
		});
	}
	return m;
}

// ---- portal surfaces ----

// The view through a portal, rendered from the linked portal into a target
// the size of the screen, and drawn where the portal is by screen position.
// Without a view (no linked portal) it shows the portal's colour.
// ---- portals (as the PortalRefract shader) ----
// The portal quad is 7.5% larger than the opening. Inside the opening
// (an ellipse in the portal's own proportions, growing as it opens): the
// view through the linked portal. Around its edge: flames from two layers
// of scrolling noise, coloured by a 1D gradient texture, brighter towards
// the bottom; an unlinked portal fills with them.

// `tint`: co-op portals (the tinted variant): the flames run from black to
// the player's portal colour instead of through the colour texture
export function portalMaterial(assets: EffectAssets | null, orange: boolean, tint: number[] | null = null): THREE.ShaderMaterial {
	const m = new THREE.ShaderMaterial({
		uniforms: {
			view: {value: null}, hasView: {value: 0}, resolution: {value: new THREE.Vector2(1, 1)},
			noise: {value: assets?.white ?? null}, gradient: {value: assets?.white ?? null},
			open: {value: 1}, time: {value: 0}, exposure: {value: 1}, colorScale: {value: tint ? 1.5 : 4},
			tint: {value: new THREE.Vector3(...(tint ?? [1, 1, 1]))}, tinted: {value: tint ? 1 : 0},
		},
		transparent: true,
		depthWrite: false,
		side: THREE.FrontSide,
		vertexShader: `
			varying vec2 vBase;
			void main() {
				// plane: x across the portal, y up; Source's v runs downwards
				vBase = vec2(0.5 - position.x * 0.5, 0.5 - position.y * 0.5);
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}`,
		fragmentShader: `
			uniform sampler2D view, noise, gradient;
			uniform float hasView, open, time, exposure, colorScale, tinted;
			uniform vec3 tint;
			uniform vec2 resolution;
			varying vec2 vBase;
			float linearstep(float a, float b, float x) { return clamp((x - a) / (b - a), 0.0, 1.0); }
			void main() {
				const float OUTER = 0.075, INNER = OUTER * 4.0;
				vec2 uv = vBase * (1.0 + OUTER) - OUTER * 0.5;
				float openAmount = smoothstep(0.0, 1.0, clamp(open, 0.0, 1.0));
				float open2 = openAmount * openAmount;
				float dist = length(uv * 2.0 - 1.0);
				float hole = step(dist, open2);

				// flames
				vec2 noiseUv = (vBase - 0.5) / max(openAmount, 0.01) + 0.5;
				float scroll = time * 0.0275;
				vec4 n1 = texture2D(noise, noiseUv * 0.3 + vec2(scroll, 0.0));
				vec4 n2 = texture2D(noise, (noiseUv * 0.3 - vec2(scroll, 0.0)).yx - n1.rg * 0.02);
				n1 = texture2D(noise, noiseUv * 0.3 + vec2(scroll, 0.0) - n2.rg * 0.02);
				float outerMask = (1.0 - linearstep(open2, open2 + OUTER, dist)) * (1.0 - hole);
				float innerMask = linearstep(open2 - INNER, open2, dist) * hole;
				float portalActive = hasView;
				float fadeIn = max(clamp(openAmount * 2.5, 0.0, 1.0), 1.0 - portalActive);
				float mask = (innerMask + outerMask) * fadeIn;
				float flame = (n1.g + n2.g) * 0.5;
				float activeNoise = smoothstep(0.0, flame, portalActive);
				float border = 1.0 - smoothstep(mask - 0.875, mask + 0.875, flame);
				mask *= border;
				float alpha = clamp(mask + hole * (1.0 - activeNoise), 0.0, 1.0) * 1.5;
				float shift = pow(abs(uv.y), 1.5) * 0.8 + 0.2;
				float sampleAt = pow(border, 0.5) * shift * alpha;
				vec3 flameColor = (tinted > 0.5 ? tint * clamp(sampleAt, 0.0, 1.0) : texture2D(gradient, vec2(sampleAt, 0.5)).rgb) * colorScale;
				alpha = clamp(alpha, 0.0, 1.0);

				vec3 inside = hasView > 0.5 ? texture2D(view, gl_FragCoord.xy / resolution).rgb * exposure : vec3(0.0);
				vec4 outColor = hole > 0.5 ? vec4(mix(inside, flameColor, alpha), 1.0) : vec4(flameColor, alpha);
				if (outColor.a <= 0.003) discard;
				gl_FragColor = linearToOutputTexel(outColor);
			}`,
	});
	if (assets) {
		const clamp = (t: THREE.Texture, repeat: boolean) => {
			const c = t.clone();
			c.wrapS = c.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
			c.needsUpdate = true;
			return c;
		};
		assets.texture('models/portals/noise-blur-256x256').then(t => {
			const c = clamp(t, true);
			c.colorSpace = THREE.NoColorSpace;
			m.uniforms.noise.value = c;
		});
		assets.texture(`models/portals/portal-${orange ? 'orange' : 'blue'}-color`).then(t => (m.uniforms.gradient.value = clamp(t, false)));
	}
	return m;
}
