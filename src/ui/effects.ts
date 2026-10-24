// Gameplay visuals: lasers, light bridges, excursion funnels, fizzlers and
// the portal surface material (the portal views themselves are rendered in
// View3D). All of them come from the entities' networked state.
import * as THREE from 'three';
import type {PropValue} from '../net/props.ts';

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

// ---- lasers ----

const laserCore = new THREE.MeshBasicMaterial({color: 0xffd0c8, fog: false});
const laserGlow = new THREE.MeshBasicMaterial({color: 0xff2a10, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false});
const unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);

export class Laser {
	readonly group = new THREE.Group();
	private segments: {core: THREE.Mesh; glow: THREE.Mesh}[] = [];

	// segments: pairs of points (the emitter's beam, then continuations
	// through portals)
	set(points: [THREE.Vector3, THREE.Vector3][]) {
		while (this.segments.length < points.length) {
			const core = new THREE.Mesh(unitCylinder, laserCore);
			const glow = new THREE.Mesh(unitCylinder, laserGlow);
			glow.renderOrder = 2;
			this.group.add(core, glow);
			this.segments.push({core, glow});
		}
		this.segments.forEach((s, i) => {
			const p = points[i];
			s.core.visible = s.glow.visible = !!p;
			if (!p) return;
			placeBetween(s.core, p[0], p[1], 0.8);
			placeBetween(s.glow, p[0], p[1], 4);
		});
	}
}

// ---- light bridges ----

const bridgeMaterial = new THREE.ShaderMaterial({
	uniforms: {time: {value: 0}},
	transparent: true,
	depthWrite: false,
	side: THREE.DoubleSide,
	blending: THREE.AdditiveBlending,
	vertexShader: `
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		}`,
	fragmentShader: `
		uniform float time;
		varying vec2 vUv;
		void main() {
			// brighter edges, faint moving bands along the length
			float edge = smoothstep(0.42, 0.5, abs(vUv.x - 0.5));
			float bands = 0.5 + 0.5 * sin(vUv.y * 0.35 - time * 2.0);
			float a = 0.22 + 0.5 * edge + 0.06 * bands;
			gl_FragColor = vec4(vec3(0.35, 0.75, 1.0) * a, 1.0);
		}`,
});

export class Bridge {
	readonly mesh: THREE.Mesh;
	private geometry = new THREE.BufferGeometry();

	constructor() {
		this.mesh = new THREE.Mesh(this.geometry, bridgeMaterial);
		this.mesh.renderOrder = 2;
		this.mesh.frustumCulled = false;
	}

	// start/end along the bridge, `right` across it, `width` in units
	set(start: THREE.Vector3, end: THREE.Vector3, right: THREE.Vector3, width: number) {
		const h = right.clone().multiplyScalar(width / 2);
		const len = start.distanceTo(end);
		const p = [start.clone().sub(h), start.clone().add(h), end.clone().add(h), end.clone().sub(h)];
		const pos: number[] = [], uv: number[] = [];
		const uvs = [[0, 0], [1, 0], [1, len / 8], [0, len / 8]];
		for (const i of [0, 1, 2, 0, 2, 3]) {
			pos.push(p[i].x, p[i].y, p[i].z);
			uv.push(uvs[i][0], uvs[i][1]);
		}
		this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	}
}

// ---- excursion funnels ----

function funnelMaterial(color: THREE.Color) {
	return new THREE.ShaderMaterial({
		uniforms: {time: {value: 0}, color: {value: color}, reversed: {value: 0}},
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		blending: THREE.AdditiveBlending,
		vertexShader: `
			varying vec2 vUv;
			varying float vLen;
			void main() {
				vUv = uv;
				vLen = length((modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}`,
		fragmentShader: `
			uniform float time;
			uniform vec3 color;
			uniform float reversed;
			varying vec2 vUv;
			varying float vLen;
			void main() {
				// rings travelling along the funnel, a spiral around it
				float along = vUv.y * vLen / 40.0;
				float dir = reversed > 0.5 ? 1.0 : -1.0;
				float rings = 0.5 + 0.5 * sin((along + dir * time * 1.5) * 6.2831);
				float spiral = 0.5 + 0.5 * sin((vUv.x * 3.0 + along * 0.5 + dir * time) * 6.2831);
				float a = 0.08 + 0.12 * rings * spiral;
				gl_FragColor = vec4(color * a, 1.0);
			}`,
	});
}

export class Funnel {
	readonly mesh: THREE.Mesh;
	private blue = funnelMaterial(new THREE.Color(0.25, 0.55, 1.0));
	private orange = funnelMaterial(new THREE.Color(1.0, 0.5, 0.12));

	constructor() {
		this.mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24, 1, true), this.blue);
		this.mesh.renderOrder = 2;
	}

	set(start: THREE.Vector3, end: THREE.Vector3, radius: number, reversed: boolean, time: number) {
		const m = reversed ? this.orange : this.blue;
		this.mesh.material = m;
		m.uniforms.time.value = time;
		m.uniforms.reversed.value = reversed ? 1 : 0;
		placeBetween(this.mesh, start, end, radius);
	}
}

// ---- fizzlers ----

export const fizzlerMaterial = new THREE.ShaderMaterial({
	uniforms: {time: {value: 0}},
	transparent: true,
	depthWrite: false,
	side: THREE.DoubleSide,
	blending: THREE.AdditiveBlending,
	vertexShader: `
		varying vec3 vWorld;
		void main() {
			vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		}`,
	fragmentShader: `
		uniform float time;
		varying vec3 vWorld;
		void main() {
			// drifting vertical streaks, as the field's shimmer
			float streaks = 0.5 + 0.5 * sin(vWorld.x * 0.21 + vWorld.y * 0.21 + time * 1.3) * sin(vWorld.z * 0.05 - time * 2.1);
			float a = 0.06 + 0.1 * streaks;
			gl_FragColor = vec4(vec3(0.45, 0.7, 1.0) * a, 1.0);
		}`,
});

// ---- portal surfaces ----

// The view through a portal, rendered from the linked portal into a target
// the size of the screen, and drawn where the portal is by screen position.
// Without a view (no linked portal) it shows the portal's colour.
export function portalMaterial(color: THREE.Color): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		uniforms: {
			view: {value: null},
			hasView: {value: 0},
			resolution: {value: new THREE.Vector2(1, 1)},
			color: {value: color},
			time: {value: 0},
		},
		side: THREE.FrontSide,
		vertexShader: `
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}`,
		fragmentShader: `
			uniform sampler2D view;
			uniform float hasView;
			uniform vec2 resolution;
			uniform vec3 color;
			uniform float time;
			varying vec2 vUv;
			void main() {
				vec2 c = vUv * 2.0 - 1.0;
				float r = length(c);
				if (r > 1.0) discard;
				vec3 inside;
				if (hasView > 0.5) {
					inside = texture2D(view, gl_FragCoord.xy / resolution).rgb;
				} else {
					// closed portal: the colour, swirling
					float swirl = 0.5 + 0.5 * sin(atan(c.y, c.x) * 3.0 + r * 8.0 - time * 3.0);
					inside = color * (0.35 + 0.35 * swirl);
				}
				// the rim glows in the portal's colour
				float rim = smoothstep(0.82, 0.98, r);
				gl_FragColor = vec4(mix(inside, color * 1.6, rim), 1.0);
				#include <tonemapping_fragment>
				#include <colorspace_fragment>
			}`,
	});
}
