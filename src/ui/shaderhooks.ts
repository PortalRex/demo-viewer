// Additions to three's built-in materials:
// - gel: world surfaces blend in the paint layer at their lightmap coordinates
// - screen-door dissolve: in orbit view, whatever stands between the camera
//   and the player is dropped pixel by pixel on an ordered-dither pattern
//   (no transparency sorting, no blending), more of it the closer it is to
//   the line of sight
import * as THREE from 'three';

export const paintUniforms = {
	paintMap: {value: null as THREE.Texture | null},
	paintOn: {value: 0},
};

// Source's range fog: by distance from the eye, linear from start to end
// and capped at the maximum density, then squared and blended in linear
// light (the frame is drawn linear and unexposed, as is the fog colour; the
// view's final pass exposes and encodes it)
export const fogUniforms = {
	fogMaxDensity: {value: 1},
};

// the frame's exposure, which the view's final pass applies: what must not
// be scaled by it (unlit Refract textures, SolidEnergy past 1) divides by it
export const exposureUniforms = {
	sceneExposure: {value: 1},
};

const FOG_HEAD = `
uniform float sceneExposure;
`;

const FOG_FRAGMENT = `
#ifdef USE_FOG
	{
		float dist = length(vDitherWorld - cameraPosition);
		float f = min(fogMaxDensity, clamp((dist - fogNear) / max(fogFar - fogNear, 1.0), 0.0, 1.0));
		gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, f * f);
	}
#endif
`;

// backs of one-sided world faces, when they're drawn (orbit and free
// camera): darker, so the outside of a room reads as a solid shell
const BACKFACE_FRAGMENT = `
#ifdef BACKFACE_SHADE
	if (!gl_FrontFacing) diffuseColor.rgb *= 0.55;
#endif
`;

// goo (Water shader with a colour texture): the colour texture at a
// 400-unit world scale, flowing: two copies drifting and cross-fading on a
// 6 second cycle, as the shader's colour flow does
export const gooUniforms = {
	gooTime: {value: 0},
};

const GOO_FRAGMENT = `
#if defined(GOO) && defined(USE_MAP)
	{
		vec2 guv = vDitherWorld.xy / 400.0;
		float phase = fract(gooTime / 6.0);
		vec2 drift = vec2(0.8, 0.6) * 0.105;
		vec4 g1 = texture2D(map, guv + drift * phase);
		vec4 g2 = texture2D(map, guv + drift * fract(phase + 0.5) + 0.37);
		float w = abs(1.0 - 2.0 * phase);
		diffuseColor = vec4(mix(g2.rgb, g1.rgb, w), 1.0);
	}
#endif
`;

export const ditherUniforms = {
	ditherOn: {value: 0},
	ditherTarget: {value: new THREE.Vector3()},
	ditherRadius: {value: 110},
};

const DITHER_FRAGMENT_HEAD = `
varying vec3 vDitherWorld;
varying float vDitherUp;
uniform float ditherOn;
uniform vec3 ditherTarget;
uniform float ditherRadius;
float ditherBayer4(vec2 p) {
	vec2 q = mod(floor(p), 4.0);
	int i = int(q.x + q.y * 4.0);
	// 4x4 Bayer matrix, as thresholds in (0, 1)
	float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
	return (m[i] + 0.5) / 16.0;
}
`;

const DITHER_FRAGMENT = `
	if (ditherOn > 0.5) {
		vec3 toTarget = ditherTarget - cameraPosition;
		float len = length(toTarget);
		vec3 dir = toTarget / max(len, 0.001);
		vec3 rel = vDitherWorld - cameraPosition;
		float along = dot(rel, dir);
		// only between the camera and (a little short of) the player, and
		// not floors (they never hide the player, and holes in them show
		// the void)
		if (along > 0.0 && along < len - 20.0 && vDitherUp < 0.7) {
			float across = length(rel - dir * along);
			float radius = ditherRadius * (0.35 + 0.65 * along / len);
			float fade = 1.0 - smoothstep(radius * 0.55, radius, across);
			if (fade * 0.9 > ditherBayer4(gl_FragCoord.xy)) discard;
		}
	}
`;

const PAINT_FRAGMENT_HEAD = `
uniform sampler2D paintMap;
uniform float paintOn;
`;

const PAINT_FRAGMENT = `
	#ifdef USE_LIGHTMAP
	if (paintOn > 0.5) {
		vec4 gel = texture2D(paintMap, vLightMapUv);
		// coverage builds up per splat; the gel reads as solid past about half
		float cover = smoothstep(0.28, 0.5, gel.a);
		diffuseColor.rgb = mix(diffuseColor.rgb, gel.rgb * gel.rgb, cover);
	}
	#endif
`;

// A projected spotlight (env_projectedtexture), as the engine's flashlight
// shading: the cookie texture projected from the light, times its colour,
// a linear falloff (100 / distance), the far plane's fade, N.L and a shadow
// map; added to the world's light maps and to models' lighting
export const flashUniforms = {
	flashOn: {value: 0},
	flashPos: {value: new THREE.Vector3()},
	flashMatrix: {value: new THREE.Matrix4()},
	flashColor: {value: new THREE.Vector3()},
	flashFar: {value: 2000},
	flashCookie: {value: null as THREE.Texture | null},
	flashDepth: {value: null as THREE.Texture | null},
	flashShadows: {value: 0},
	flashTexel: {value: 1 / 1024},
};

const FLASH_HEAD = `
uniform float flashOn, flashFar, flashShadows, flashTexel;
uniform vec3 flashPos, flashColor;
uniform mat4 flashMatrix;
uniform sampler2D flashCookie, flashDepth;
vec3 flashLight(vec3 p, vec3 n) {
	if (flashOn < 0.5) return vec3(0.0);
	vec4 lp = flashMatrix * vec4(p, 1.0);
	if (lp.w <= 0.0) return vec3(0.0);
	vec3 proj = lp.xyz / lp.w;
	vec2 uv = proj.xy * 0.5 + 0.5;
	if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 || proj.z > 1.0) return vec3(0.0);
	vec3 d = flashPos - p;
	float dist = length(d);
	float atten = clamp(100.0 / dist, 0.0, 1.0);
	float fade = clamp((dist - flashFar) / (-0.4 * flashFar), 0.0, 1.0);
	float ndl = clamp(dot(d / dist, n), 0.0, 1.0);
	if (ndl <= 0.0) return vec3(0.0);
	float shadow = 1.0;
	if (flashShadows > 0.5) {
		float z = proj.z * 0.5 + 0.5 - (0.0004 + 0.0016 * (1.0 - ndl));
		shadow = 0.0;
		for (int i = 0; i < 4; i++) {
			vec2 o = vec2(i == 1 || i == 3 ? 1.0 : -1.0, i >= 2 ? 1.0 : -1.0) * 0.75 * flashTexel;
			shadow += step(z, texture2D(flashDepth, uv + o).r);
		}
		shadow *= 0.25;
	}
	return texture2D(flashCookie, uv).rgb * flashColor * atten * fade * ndl * shadow;
}
`;

// Models that move are lit as the engine lights them: an ambient cube (six
// colours by normal direction) plus up to two local lights, per object (set
// just before each draw, as the materials are shared)
export interface ModelLighting {
	cube: number[];  // 6 x rgb: +x -x +y -y +z -z, linear lightmap units
	lights: {pos: number[]; color: number[]}[];
}

export const AMBIENT_SCALE = 1.5;  // the lightmap scale (see view3d)

const AMBIENT_FRAGMENT_HEAD = `
uniform vec3 ambCube[6];
uniform vec3 ambLightPos[2];
uniform vec3 ambLightColor[2];
uniform float ambScale;
uniform vec3 selfIllumTint;
uniform sampler2D selfIllumMask;
varying vec3 vAmbN;
`;

const AMBIENT_FRAGMENT = `
	{
		vec3 n = normalize(vAmbN);
		vec3 n2 = n * n;
		vec3 amb = n2.x * (n.x >= 0.0 ? ambCube[0] : ambCube[1])
			+ n2.y * (n.y >= 0.0 ? ambCube[2] : ambCube[3])
			+ n2.z * (n.z >= 0.0 ? ambCube[4] : ambCube[5]);
		for (int i = 0; i < 2; i++) {
			vec3 l = ambLightPos[i] - vDitherWorld;
			amb += ambLightColor[i] * max(dot(n, normalize(l)), 0.0);
		}
		amb += flashLight(vDitherWorld, n);
		reflectedLight.directDiffuse = vec3(0.0);
		reflectedLight.directSpecular = vec3(0.0);
		reflectedLight.indirectDiffuse = diffuseColor.rgb * amb * ambScale;
	#if defined(SELFILLUM) && defined(USE_MAP)
		{
		#ifdef SELFILLUM_MASK
			vec3 glow = texture2D(selfIllumMask, vMapUv).rgb;
		#else
			vec3 glow = vec3(texture2D(map, vMapUv).a);
		#endif
			reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, diffuseColor.rgb * selfIllumTint, glow);
		}
	#endif
	#ifdef ENVMAP_CUBE
		surfaceLight = amb * ambScale;
	#endif
	}
`;

const NEUTRAL: ModelLighting = {cube: new Array(18).fill(0.1), lights: []};

// a lit model material of its own for one mesh (three uploads a material's
// uniforms only when the material changes between draws, so objects can't
// share one); its texture and settings are copied from the shared one
export function ownLitMaterial(shared: THREE.Material): THREE.Material {
	const m = shared.clone();
	m.userData = {ambientLit: true, modelEnv: shared.userData.modelEnv, selfIllum: shared.userData.selfIllum};
	hook(m, false);
	return m;
}

// draws `mesh` with its object's lighting (userData.lighting on it or an ancestor)
export function useModelLighting(mesh: THREE.Object3D) {
	mesh.onBeforeRender = (_r, _s, _c, _g, material) => {
		const u = (material as THREE.Material).userData.ambUniforms as Record<string, {value: unknown}> | undefined;
		if (!u) return;
		let o: THREE.Object3D | null = mesh, lighting: ModelLighting | undefined;
		while (o && !(lighting = o.userData.lighting as ModelLighting | undefined)) o = o.parent;
		const l = lighting ?? NEUTRAL;
		const cube = u.ambCube.value as THREE.Vector3[];
		for (let i = 0; i < 6; i++) cube[i].set(l.cube[i * 3], l.cube[i * 3 + 1], l.cube[i * 3 + 2]);
		const pos = u.ambLightPos.value as THREE.Vector3[], col = u.ambLightColor.value as THREE.Vector3[];
		for (let i = 0; i < 2; i++) {
			const light = l.lights[i];
			pos[i].set(light?.pos[0] ?? 0, light?.pos[1] ?? 0, light?.pos[2] ?? 0);
			col[i].set(light?.color[0] ?? 0, light?.color[1] ?? 0, light?.color[2] ?? 0);
		}
		(material as THREE.Material & {uniformsNeedUpdate: boolean}).uniformsNeedUpdate = true;
	};
}

// Bump-mapped world surfaces: vrad stores the light arriving along three
// directions in the face's texture space as well as the flat light; the
// surface's normal map picks the mix per pixel (as LightmappedGeneric does)
export const bumpLightUniforms = {
	bumpLight0: {value: null as THREE.Texture | null},
	bumpLight1: {value: null as THREE.Texture | null},
	bumpLight2: {value: null as THREE.Texture | null},
};

const BUMP_FRAGMENT_HEAD = `
uniform sampler2D bumpLight0;
uniform sampler2D bumpLight1;
uniform sampler2D bumpLight2;
uniform sampler2D bumpNormal;
`;

// $detail (LightmappedGeneric's TextureCombine): a second texture at
// detailScale x the base's coordinates, combined by mode
export const DETAIL_HEAD = `
uniform sampler2D detailMap;
uniform float detailScale;
uniform float detailBlend;
vec4 detailTexel = vec4(1.0);
`;

const DETAIL_FRAGMENT = `
#if defined(DETAIL_MODE) && defined(USE_MAP)
	{
		detailTexel = texture2D(detailMap, vMapUv * detailScale);
		float baseA = texture2D(map, vMapUv).a;
	#if DETAIL_MODE == 0
		diffuseColor.rgb *= mix(vec3(1.0), 2.0 * detailTexel.rgb, detailBlend);
	#elif DETAIL_MODE == 1
		diffuseColor.rgb += detailBlend * detailTexel.rgb;
	#elif DETAIL_MODE == 7
		diffuseColor.rgb *= mix(vec3(1.0), vec3(2.0 * mix(detailTexel.r, detailTexel.a, baseA)), detailBlend);
	#elif DETAIL_MODE == 8
		diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * detailTexel.rgb, detailBlend);
	#endif
	}
#endif
`;

const BUMP_FRAGMENT = `
		vec3 lmColor = lightMapTexel.rgb;
	#if defined(BUMPLIGHT) && defined(USE_MAP)
		{
			vec3 b0 = texture2D(bumpLight0, vLightMapUv).rgb;
			vec3 b1 = texture2D(bumpLight1, vLightMapUv).rgb;
			vec3 b2 = texture2D(bumpLight2, vLightMapUv).rgb;
			vec3 bn = texture2D(bumpNormal, vMapUv).rgb;
		#ifdef SSBUMP
		#if defined(DETAIL_MODE) && DETAIL_MODE == 10
			// an ssbump detail texture modulates the bump
			bn *= 2.0 * detailTexel.rgb;
		#endif
			// self-shadowed: the texture holds each direction's weight directly
			lmColor = (bn.x * b0 + bn.y * b1 + bn.z * b2) * 0.57735;
		#else
			bn = normalize(bn * 2.0 - 1.0);
			vec3 dp = clamp(vec3(
				dot(bn, vec3(0.81649658, 0.0, 0.57735027)),
				dot(bn, vec3(-0.40824830, 0.70710678, 0.57735027)),
				dot(bn, vec3(-0.40824830, -0.70710678, 0.57735027))), 0.0, 1.0);
			dp *= dp;
			lmColor = (dp.x * b0 + dp.y * b1 + dp.z * b2) / max(dp.x + dp.y + dp.z, 1e-4);
		#endif
		}
	#endif
		reflectedLight.indirectDiffuse += lmColor * lightMapIntensity * RECIPROCAL_PI;
		surfaceLight = lmColor * lightMapIntensity * RECIPROCAL_PI;
		// (in the light maps' units: their scale, lightMapIntensity / pi)
		reflectedLight.indirectDiffuse += flashLight(vDitherWorld, normalize(vEnvN)) * lightMapIntensity * RECIPROCAL_PI;
`;

// Reflections (LightmappedGeneric's $envmap): the cubemap along the view
// reflected off the surface, tinted, contrast and saturation adjusted,
// scaled by a mask, added on top of the lit colour
const ENV_FRAGMENT_HEAD = `
uniform samplerCube envCube;
uniform vec3 envTint;
uniform float envScale;
uniform float envContrast;
uniform float envSaturation;
uniform sampler2D envMaskMap;
uniform float envLightScale;
varying vec3 vEnvN;
vec3 surfaceLight = vec3(1.0);
`;

const ENV_FRAGMENT = `
#ifdef ENVMAP_CUBE
	{
		vec3 eye = normalize(vDitherWorld - cameraPosition);
		vec3 n = normalize(vEnvN);
		if (!gl_FrontFacing) n = -n;
		float mask = 1.0;
	#if defined(ENVMASK_BASE) && defined(USE_MAP)
		mask = texture2D(map, vMapUv).a;
	#elif defined(ENVMASK_BUMP) && defined(USE_MAP)
		mask = texture2D(bumpNormal, vMapUv).a;
	#endif
	#if defined(DETAIL_MODE) && DETAIL_MODE == 7 && defined(USE_MAP)
		mask *= 2.0 * mix(detailTexel.g, detailTexel.b, texture2D(map, vMapUv).a);
	#endif
	#if defined(ENVMASK_TEXTURE) && defined(USE_MAP) && !defined(ENVMASK_BASE) && !defined(ENVMASK_BUMP)
		mask = texture2D(envMaskMap, vMapUv).r;
	#endif
		vec3 spec = envScale * textureCube(envCube, reflect(eye, n)).rgb;
		// $envmaplightscale (darker where the surface's light is) and the mask
		// go in before the tint and contrast, as the engine's shaders do: the
		// contrast squares them too
		spec = mix(spec, spec * clamp(surfaceLight, 0.0, 1.0), envLightScale);
		spec *= mask * envTint;
		spec = mix(spec, spec * spec, envContrast);
		spec = mix(vec3(dot(spec, vec3(0.299, 0.587, 0.114))), spec, envSaturation);
		outgoingLight += spec;
	}
#endif
`;

// Refract surfaces draw their (unlit) tint, multiplied onto what's behind
const REFRACT_FRAGMENT = `
#ifdef REFRACT_TINT
	outgoingLight = diffuseColor.rgb;
#endif
#ifdef REFRACT_UNSCALED
	outgoingLight /= sceneExposure;
#endif
`;

export interface EnvSettings {
	cube: THREE.CubeTexture;
	tint: [number, number, number];
	scale: number;
	contrast: number;
	saturation: number;
	maskMap: THREE.Texture | null;
	lightScale: number;
}

// gives a world material its $detail texture
export function setWorldDetail(material: THREE.Material, map: THREE.Texture, scale: number, blend: number, mode: number) {
	const u = material.userData.envUniforms as Record<string, {value: unknown}>;
	u.detailMap.value = map;
	u.detailScale.value = scale;
	u.detailBlend.value = blend;
	material.defines = {...material.defines, DETAIL_MODE: String(mode)};
	material.needsUpdate = true;
}

// gives a world material its reflection (once its cubemap has loaded)
// a model material's envmap settings (from its material file), kept on the
// shared material for the copies each object draws with
export interface ModelEnv {
	tint: [number, number, number];
	contrast: number;
	saturation: number;
	lightScale: number;
	mask: 'none' | 'base' | 'texture';
	maskMap: THREE.Texture | null;
}

// the cube an object's own lit materials reflect
export function setModelEnvCube(material: THREE.Material, cube: THREE.CubeTexture | null, scale: number) {
	const u = material.userData.envUniforms as Record<string, {value: unknown}> | undefined;
	if (!u) return;
	u.envCube.value = cube;
	u.envScale.value = scale;
}

export function setWorldEnv(material: THREE.Material, env: EnvSettings, mask: 'none' | 'base' | 'bump' | 'texture') {
	const u = material.userData.envUniforms as Record<string, {value: unknown}>;
	u.envCube.value = env.cube;
	(u.envTint.value as THREE.Vector3).set(...env.tint);
	u.envScale.value = env.scale;
	u.envContrast.value = env.contrast;
	u.envSaturation.value = env.saturation;
	u.envMaskMap.value = env.maskMap;
	u.envLightScale.value = env.lightScale;
	material.defines = {...material.defines, ENVMAP_CUBE: ''};
	for (const k of ['ENVMASK_BASE', 'ENVMASK_BUMP', 'ENVMASK_TEXTURE']) delete material.defines[k];
	if (mask === 'base') material.defines.ENVMASK_BASE = '';
	if (mask === 'bump') material.defines.ENVMASK_BUMP = '';
	if (mask === 'texture' && env.maskMap) material.defines.ENVMASK_TEXTURE = '';
	material.needsUpdate = true;
}

function hook(material: THREE.Material, paint: boolean) {
	const lit = !!material.userData.ambientLit;
	if (paint) {
		material.userData.envUniforms = {
			envCube: {value: null},
			envTint: {value: new THREE.Vector3(1, 1, 1)},
			envScale: {value: 1},
			envContrast: {value: 0},
			envSaturation: {value: 1},
			envMaskMap: {value: null},
			envLightScale: {value: 0},
			detailMap: {value: null},
			detailScale: {value: 4},
			detailBlend: {value: 1},
		};
	}
	// a model's $envmap: the cube is set per object (the map's nearest to it)
	const env = lit ? material.userData.modelEnv as ModelEnv | undefined : undefined;
	if (env) {
		material.userData.envUniforms = {
			envCube: {value: null},
			envTint: {value: new THREE.Vector3(...env.tint)},
			envScale: {value: 1},
			envContrast: {value: env.contrast},
			envSaturation: {value: env.saturation},
			envMaskMap: {value: env.maskMap},
			envLightScale: {value: env.lightScale},
		};
		material.defines = {...material.defines, ENVMAP_CUBE: ''};
		if (env.mask === 'base') material.defines.ENVMASK_BASE = '';
		if (env.mask === 'texture' && env.maskMap) material.defines.ENVMASK_TEXTURE = '';
	}
	if (lit) {
		material.userData.ambUniforms = {
			ambCube: {value: Array.from({length: 6}, () => new THREE.Vector3())},
			ambLightPos: {value: [new THREE.Vector3(), new THREE.Vector3()]},
			ambLightColor: {value: [new THREE.Vector3(), new THREE.Vector3()]},
			ambScale: {value: AMBIENT_SCALE},
		};
		// $selfillum: the unlit colour (times the tint) where the mask says
		const si = material.userData.selfIllum as {tint: [number, number, number]; mask: THREE.Texture | null} | undefined;
		if (si) {
			Object.assign(material.userData.ambUniforms, {selfIllumTint: {value: new THREE.Vector3(...si.tint)}, selfIllumMask: {value: si.mask}});
			material.defines = {...material.defines, SELFILLUM: ''};
			if (si.mask) material.defines.SELFILLUM_MASK = '';
		}
	}
	material.onBeforeCompile = shader => {
		Object.assign(shader.uniforms, ditherUniforms, fogUniforms, gooUniforms, exposureUniforms, flashUniforms);
		if (paint) {
			Object.assign(shader.uniforms, paintUniforms, bumpLightUniforms, material.userData.envUniforms);
			shader.uniforms.bumpNormal = {value: material.userData.bumpNormal ?? null};
			shader.fragmentShader = BUMP_FRAGMENT_HEAD + ENV_FRAGMENT_HEAD + DETAIL_HEAD + shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + DETAIL_FRAGMENT).replace(
				'reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;',
				BUMP_FRAGMENT,
			).replace('#include <envmap_fragment>', '#include <envmap_fragment>\n' + ENV_FRAGMENT);
			shader.vertexShader = 'varying vec3 vEnvN;\n' + shader.vertexShader.replace(
				'#include <project_vertex>',
				'#include <project_vertex>\n\tvEnvN = normalize(mat3(modelMatrix) * normal);',
			);
		}
		if (lit) {
			Object.assign(shader.uniforms, material.userData.ambUniforms);
			shader.vertexShader = 'varying vec3 vAmbN;\n' + shader.vertexShader.replace(
				'#include <defaultnormal_vertex>',
				'#include <defaultnormal_vertex>\n\tvAmbN = normalize(mat3(modelMatrix) * objectNormal);',
			);
			shader.fragmentShader = AMBIENT_FRAGMENT_HEAD + shader.fragmentShader.replace(
				'#include <lights_fragment_end>',
				'#include <lights_fragment_end>\n' + AMBIENT_FRAGMENT,
			);
			if (env) {
				Object.assign(shader.uniforms, material.userData.envUniforms);
				shader.vertexShader = 'varying vec3 vEnvN;\n' + shader.vertexShader.replace('vAmbN = normalize(mat3(modelMatrix) * objectNormal);', 'vAmbN = normalize(mat3(modelMatrix) * objectNormal);\n\tvEnvN = vAmbN;');
				shader.fragmentShader = ENV_FRAGMENT_HEAD + shader.fragmentShader.replace('#include <envmap_fragment>', '#include <envmap_fragment>\n' + ENV_FRAGMENT);
			}
		}
		shader.vertexShader = 'varying vec3 vDitherWorld;\nvarying float vDitherUp;\n' + shader.vertexShader.replace(
			'#include <project_vertex>',
			'#include <project_vertex>\n\tvDitherWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n\tvDitherUp = normalize(mat3(modelMatrix) * normal).z;',
		);
		shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', REFRACT_FRAGMENT + '#include <opaque_fragment>');
		shader.fragmentShader = DITHER_FRAGMENT_HEAD + FOG_HEAD + FLASH_HEAD + 'uniform float fogMaxDensity;\nuniform float gooTime;\n' + (paint ? PAINT_FRAGMENT_HEAD : '') + shader.fragmentShader
			.replace('#include <fog_fragment>', FOG_FRAGMENT)
			.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + DITHER_FRAGMENT)
			.replace('#include <map_fragment>', '#include <map_fragment>\n' + GOO_FRAGMENT + (paint ? PAINT_FRAGMENT : '') + BACKFACE_FRAGMENT);
	};
	material.customProgramCacheKey = () => (paint ? 'world+paint+dither' : 'dither') + (lit ? '+amb' : '') + (material.defines?.BACKFACE_SHADE !== undefined ? '+back' : '') + (material.defines?.GOO !== undefined ? '+goo' : '') + (material.defines?.BUMPLIGHT !== undefined ? '+bump' : '') + (material.defines?.SSBUMP !== undefined ? '+ss' : '') + (material.defines?.REFRACT_TINT !== undefined ? '+refract' : '') + (material.defines?.REFRACT_UNSCALED !== undefined ? '+unscaled' : '') + (material.defines?.DETAIL_MODE !== undefined ? '+detail' + material.defines.DETAIL_MODE : '') + (material.defines?.SELFILLUM !== undefined ? '+si' : '') + (material.defines?.SELFILLUM_MASK !== undefined ? '+simask' : '') + Object.keys(material.defines ?? {}).filter(k => k.startsWith('ENV')).sort().join('+');
}

export const hookWorldMaterial = (m: THREE.Material) => hook(m, true);
export const hookModelMaterial = (m: THREE.Material) => hook(m, false);
