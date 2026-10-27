// The simple view: the map as the least that still shows a run. The world's
// brushes merged into one flat-shaded mesh (one draw call; see-through
// glass in a second, faint one), every prop and entity a box from its bounds
// (one instanced draw each for the static ones and the moving ones), players
// as cylinders in their team's colour. Plain greys by which way a surface
// faces, lit from above, dimmer with distance; drawn straight to the screen.
import * as THREE from 'three';

const VERTEX = `
	#include <common>
	#include <skinning_pars_vertex>
	#include <clipping_planes_pars_vertex>
	varying vec3 vWorld;
	varying vec3 vTint;
	void main() {
		#include <begin_vertex>
		#include <skinbase_vertex>
		#include <skinning_vertex>
		#include <project_vertex>
		vec4 world = vec4(transformed, 1.0);
		#ifdef USE_INSTANCING
		world = instanceMatrix * world;
		#endif
		vWorld = (modelMatrix * world).xyz;
		#ifdef USE_INSTANCING_COLOR
		vTint = instanceColor;
		#else
		vTint = vec3(1.0);
		#endif
		#include <clipping_planes_vertex>
	}`;

const FRAGMENT = `
	#include <clipping_planes_pars_fragment>
	uniform vec3 tint;
	uniform float opacity;
	varying vec3 vWorld;
	varying vec3 vTint;
	void main() {
		#include <clipping_planes_fragment>
		vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
		vec3 toEye = cameraPosition - vWorld;
		if (dot(n, toEye) < 0.0) n = -n;
		// floors, walls and ceilings in their own greys
		vec3 base = (n.z > 0.7 ? vec3(0.40, 0.41, 0.43) : n.z < -0.7 ? vec3(0.30) : vec3(0.58, 0.58, 0.57)) * tint * vTint;
		float light = 0.55 + 0.3 * max(dot(n, normalize(vec3(0.35, 0.25, 1.0))), 0.0) + 0.15 * abs(n.x);
		vec3 c = base * light * mix(1.0, 0.45, clamp(length(toEye) / 6000.0, 0.0, 1.0));
		gl_FragColor = vec4(pow(c, vec3(2.2)), opacity);
		#include <colorspace_fragment>
	}`;

function shaded(tint: number, opacity = 1): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		uniforms: {tint: {value: new THREE.Color(tint)}, opacity: {value: opacity}},
		vertexShader: VERTEX, fragmentShader: FRAGMENT,
		side: THREE.DoubleSide, clipping: true,
		transparent: opacity < 1, depthWrite: opacity >= 1,
	});
}

// a box: a unit cube, placed by a matrix that scales it to the bounds
const BOX = new THREE.BoxGeometry(1, 1, 1);
const PLAYER = new THREE.CylinderGeometry(16, 16, 72, 16).rotateX(Math.PI / 2).translate(0, 0, 36);

export interface SimpleBox {
	matrix: THREE.Matrix4;   // the unit box to its place: position, turn, size
	color: THREE.Color;
}

export interface SimplePlayer {
	position: THREE.Vector3;
	height: number;
	orange: boolean;  // P-body's team
}

export class SimpleScene {
	readonly scene = new THREE.Scene();
	private materials = {world: shaded(0xffffff), glass: shaded(0xbfd8ff, 0.25), props: shaded(0xffffff), boxes: shaded(0xffffff),
		blue: shaded(0x80b8ff), orange: shaded(0xffa060)};
	private world: THREE.Mesh[] = [];
	private props: THREE.InstancedMesh | null = null;
	private boxes: THREE.InstancedMesh | null = null;
	private players: THREE.Mesh[] = [];
	built = -1;  // the map it was built for

	// the world's brushes: their triangles merged, opaque and see-through apart
	setWorld(meshes: THREE.Mesh[], token: number) {
		for (const m of this.world) {
			m.geometry.dispose();
			this.scene.remove(m);
		}
		this.world = [];
		const solid: Float32Array[] = [], glass: Float32Array[] = [];
		for (const m of meshes) {
			const pos = m.geometry.getAttribute('position');
			if (!pos) continue;
			m.updateMatrixWorld();
			const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrixWorld);
			const out = [m.material].flat().some(x => x.transparent) ? glass : solid;
			out.push(g.getAttribute('position').array as Float32Array);
			g.dispose();
		}
		for (const [list, material] of [[solid, this.materials.world], [glass, this.materials.glass]] as const) {
			if (!list.length) continue;
			const all = new Float32Array(list.reduce((n, a) => n + a.length, 0));
			let at = 0;
			for (const a of list) {
				all.set(a, at);
				at += a.length;
			}
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(all, 3));
			g.computeBoundingSphere();
			const mesh = new THREE.Mesh(g, material);
			mesh.renderOrder = material === this.materials.glass ? 1 : 0;
			this.world.push(mesh);
			this.scene.add(mesh);
		}
		this.built = token;
	}

	// the static props: boxes that don't move
	setProps(list: THREE.Matrix4[]) {
		if (this.props) {
			this.scene.remove(this.props);
			this.props.dispose();
		}
		this.props = new THREE.InstancedMesh(BOX, this.materials.props, Math.max(1, list.length));
		list.forEach((m, i) => this.props!.setMatrixAt(i, m));
		this.props.count = list.length;
		this.props.frustumCulled = false;
		this.props.setColorAt(0, new THREE.Color(0xd8d2c8));
		for (let i = 1; i < list.length; i++) this.props.setColorAt(i, new THREE.Color(0xd8d2c8));
		this.scene.add(this.props);
	}

	// the moving things this frame
	setBoxes(list: SimpleBox[]) {
		if (!this.boxes || this.boxes.instanceMatrix.count < list.length) {
			if (this.boxes) {
				this.scene.remove(this.boxes);
				this.boxes.dispose();
			}
			this.boxes = new THREE.InstancedMesh(BOX, this.materials.boxes, Math.max(64, list.length * 2));
			this.boxes.frustumCulled = false;
			this.boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			this.scene.add(this.boxes);
		}
		list.forEach((b, i) => {
			this.boxes!.setMatrixAt(i, b.matrix);
			this.boxes!.setColorAt(i, b.color);
		});
		this.boxes.count = list.length;
		this.boxes.instanceMatrix.needsUpdate = true;
		if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
	}

	setPlayers(list: SimplePlayer[]) {
		while (this.players.length < list.length) {
			const m = new THREE.Mesh(PLAYER, this.materials.blue);
			m.frustumCulled = false;
			this.players.push(m);
			this.scene.add(m);
		}
		this.players.forEach((m, i) => {
			const p = list[i];
			m.visible = !!p;
			if (!p) return;
			m.material = p.orange ? this.materials.orange : this.materials.blue;
			m.position.copy(p.position);
			m.scale.set(1, 1, p.height / 72);
		});
	}

	dispose() {
		for (const m of this.world) m.geometry.dispose();
		this.props?.dispose();
		this.boxes?.dispose();
		for (const m of Object.values(this.materials)) m.dispose();
		this.scene.clear();
		this.world = [];
		this.players = [];
		this.props = this.boxes = null;
		this.built = -1;
	}
}
