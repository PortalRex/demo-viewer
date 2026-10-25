// Bloom, as the engine's LDR post-processing does it: the frame (exposed
// and gamma-encoded) is averaged down to a quarter-size buffer through a
// bright pass (Downsample_nohdr, $bloomtype 0: colour^2.2 x its luminance
// by r_bloomtint 0.3/0.59/0.11), blurred across and then down with the
// 25-pixel Gaussian ($kernel 4), and engine_post adds half of it, times the
// bloom scale, to the frame in gamma space.
import * as THREE from 'three';

const QUAD_VERTEX = `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = vec4(position.xy, 0.0, 1.0);
	}`;

// exposure, clamp and the sRGB curve: what's on screen before post
export const ENCODE = `
	vec3 encode(vec3 linear, float exposure) {
		vec3 c = clamp(linear * exposure, 0.0, 1.0);
		return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
	}`;

// BlurFilter KERNEL 4 (bilinear taps: weights and offsets in texels)
const WEIGHTS = [0.000534, 0.003733, 0.018004, 0.059928, 0.137740, 0.218677, 0.122765, 0.218677, 0.137740, 0.059928, 0.018004, 0.003733, 0.000534];
const OFFSETS = [-11.251852, -9.289172, -7.329586, -5.372686, -3.417910, -1.464557, 0, 1.464557, 3.417910, 5.372686, 7.329586, 9.289172, 11.251852];

export class Bloom {
	private small = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, {depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter}));
	private down = new THREE.ShaderMaterial({
		uniforms: {frame: {value: null}, texel: {value: new THREE.Vector2()}, exposure: {value: 1}},
		depthTest: false,
		depthWrite: false,
		vertexShader: QUAD_VERTEX,
		fragmentShader: `
			uniform sampler2D frame;
			uniform vec2 texel;
			uniform float exposure;
			varying vec2 vUv;
			${ENCODE}
			vec3 tap(vec2 o) {
				return encode(texture2D(frame, vUv + o * texel).rgb, exposure);
			}
			void main() {
				// four bilinear taps: the 4x4 pixels under this one
				vec3 c = (tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0))) * 0.25;
				float lum = dot(c, vec3(0.3, 0.59, 0.11));
				gl_FragColor = vec4(pow(c, vec3(2.2)) * lum, 1.0);
			}`,
	});
	private blur = new THREE.ShaderMaterial({
		uniforms: {source: {value: null}, step: {value: new THREE.Vector2()}},
		depthTest: false,
		depthWrite: false,
		vertexShader: QUAD_VERTEX,
		fragmentShader: `
			uniform sampler2D source;
			uniform vec2 step;
			varying vec2 vUv;
			const float W[13] = float[13](${WEIGHTS.map(w => w.toFixed(6)).join(', ')});
			const float O[13] = float[13](${OFFSETS.map(o => o.toFixed(6)).join(', ')});
			void main() {
				vec3 c = vec3(0.0);
				for (int j = 0; j < 13; j++) c += W[j] * texture2D(source, vUv + O[j] * step).rgb;
				gl_FragColor = vec4(c, 1.0);
			}`,
	});
	private quad = Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(2, 2)), {frustumCulled: false});
	private scene = new THREE.Scene().add(this.quad);
	private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

	// the blurred bright pass of `frame` (a quarter of its size)
	render(r: THREE.WebGLRenderer, frame: THREE.WebGLRenderTarget, exposure: number): THREE.Texture {
		const w = Math.max(1, frame.width >> 2), h = Math.max(1, frame.height >> 2);
		const [a, b] = this.small;
		if (a.width !== w || a.height !== h) for (const t of this.small) t.setSize(w, h);
		this.down.uniforms.frame.value = frame.texture;
		this.down.uniforms.texel.value.set(1 / frame.width, 1 / frame.height);
		this.down.uniforms.exposure.value = exposure;
		this.pass(r, this.down, a);
		this.blur.uniforms.source.value = a.texture;
		this.blur.uniforms.step.value.set(1 / w, 0);
		this.pass(r, this.blur, b);
		this.blur.uniforms.source.value = b.texture;
		this.blur.uniforms.step.value.set(0, 1 / h);
		this.pass(r, this.blur, a);
		return a.texture;
	}

	private pass(r: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget) {
		this.quad.material = material;
		r.setRenderTarget(target);
		r.render(this.scene, this.cam);
	}

	dispose() {
		for (const t of this.small) t.dispose();
		this.down.dispose();
		this.blur.dispose();
		this.quad.geometry.dispose();
	}
}
