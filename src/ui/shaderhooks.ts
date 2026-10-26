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
	// paint/splatnormal_default: its alpha breaks up the gel's edges; tiled
	// every 12.8 luxels (40 across the engine's 512-luxel paint map)
	paintSplat: {value: null as THREE.Texture | null},
	paintTiles: {value: new THREE.Vector2(1, 1)},
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

// mat_ambient_light_r/g/b (where the recording's console commands set it):
// light added to every model's lighting cube, static props' too (the
// engine's light cache), and the world's lightmaps, in lightmap units
export const modelAmbientUniforms = {
	modelAmbient: {value: new THREE.Vector3()},
};

const FOG_HEAD = `
uniform float sceneExposure;
uniform vec3 modelAmbient;
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

// the Water shader (its flowing, expensive version): a normal map flowing
// along the map's flow map in two layers that cross-fade, a sludge layer
// (with a base texture) flowing the same way over the fog colour, and the
// reflection blended in by fresnel. The time and the camera's right and
// forward along the surface (what bends the reflection) are shared
export const waterUniforms = {
	waterTime: {value: 0},
	waterRight: {value: new THREE.Vector3(1, 0, 0)},
	waterForward: {value: new THREE.Vector3(0, 1, 0)},
};

// a Water material's own (filled by View3D's material library)
export function waterMaterialUniforms() {
	return {
		waterNormal: {value: null as THREE.Texture | null},
		waterBase: {value: null as THREE.Texture | null},
		waterNoise: {value: null as THREE.Texture | null},
		waterReflect: {value: null as THREE.Texture | null},
		waterCube: {value: null as THREE.CubeTexture | null},
		waterCubeScale: {value: 1},
		waterReflectMatrix: {value: new THREE.Matrix4()},
		waterFlowA: {value: new THREE.Vector4()},  // 1 / flow map scale, 1 / normal map scale, bump strength, sludge parallax
		waterFlowB: {value: new THREE.Vector4()},  // flow interval, scroll distance, noise scale, reflection bend
		waterColor: {value: new THREE.Vector4()},  // sludge: 1 / scale, interval, scroll distance, cross-fade exponent
		waterReflectTint: {value: new THREE.Vector3()},
		waterFogColor: {value: new THREE.Vector3()},
	};
}

const WATER_HEAD = `
#ifdef WATER
uniform float waterTime;
uniform vec3 waterRight;
uniform vec3 waterForward;
uniform sampler2D waterNormal;
uniform sampler2D waterBase;
uniform sampler2D waterNoise;
uniform sampler2D waterReflect;
uniform samplerCube waterCube;
uniform float waterCubeScale;
uniform mat4 waterReflectMatrix;
uniform vec4 waterFlowA;
uniform vec4 waterFlowB;
uniform vec4 waterColor;
uniform vec3 waterReflectTint;
uniform vec3 waterFogColor;
#endif
`;

// (lit with a white albedo: what the lighting leaves is the light)
const WATER_ALBEDO = `
#ifdef WATER
	diffuseColor = vec4(1.0, 1.0, 1.0, opacity);
#endif
`;

const WATER_FRAGMENT = `
#if defined(WATER) && defined(USE_MAP)
	{
		vec3 light = outgoingLight;
		vec3 toCam = normalize(cameraPosition - vDitherWorld);
		vec2 wxy = vec2(vDitherWorld.x, -vDitherWorld.y);
		vec3 n = vec3(0.0, 0.0, 1.0);
		vec4 flowColor = vec4(0.0);
	#ifdef WATER_FLOW
		// (the material's map is the flow map)
		float noise = texture2D(waterNoise, wxy * waterFlowB.z).g;
		vec4 flow = texture2D(map, vMapUv * waterFlowA.x);
		vec2 dir = flow.rg * 2.0 - 1.0;
		float t = waterTime / (waterFlowB.x * 2.0) + noise;
		vec2 uv = wxy * waterFlowA.y;
		vec4 n1 = texture2D(waterNormal, uv + floor(t) * 0.311 + fract(t) * waterFlowB.y * dir);
		vec4 n2 = texture2D(waterNormal, uv + floor(t + 0.5) * 0.311 + 0.5 + fract(t + 0.5) * waterFlowB.y * dir);
		float w2 = abs(2.0 * fract(t) - 1.0);
		vec2 nxy = (mix(n1.xy, n2.xy, w2) * 2.0 - 1.0) * (dot(dir, dir) + 0.1) * waterFlowA.z;
		n = vec3(nxy, sqrt(clamp(1.0 - dot(nxy, nxy), 0.0, 1.0)));
	#ifdef WATER_BASE
		// the sludge: two copies of the colour texture flowing and
		// cross-fading, shifted by parallax, masked by the flow map's alpha
		vec2 cuv = wxy * waterColor.x + (toCam.xy - n.xy) * mix(n1.a, n2.a, w2) * waterFlowA.w;
		float ct = waterTime / (waterColor.y * 2.0) + noise;
		vec4 c1 = texture2D(waterBase, cuv + floor(ct) * 0.311 + (fract(ct) - 0.5) * waterColor.z * dir);
		vec4 c2 = texture2D(waterBase, cuv + floor(ct + 0.5) * 0.311 + 0.5 + (fract(ct + 0.5) - 0.5) * waterColor.z * dir);
		flowColor = (c1 * pow(abs(2.0 * fract(ct + 0.5) - 1.0), waterColor.w) + c2 * pow(abs(2.0 * fract(ct) - 1.0), waterColor.w)) * flow.a;
	#endif
	#else
		n = normalize(texture2D(map, vMapUv).xyz * 2.0 - 1.0);
	#endif
		float fresnel = 0.2 + 0.8 * pow(1.0 - clamp(dot(toCam, n), 0.0, 1.0), 5.0);
		vec3 reflection = vec3(0.0);
	#if defined(WATER_PLANAR)
		vec4 rp = waterReflectMatrix * vec4(vDitherWorld, 1.0);
		reflection = texture2D(waterReflect, rp.xy / rp.w + vec2(dot(waterRight, n), dot(waterForward, n)) * waterFlowB.w).rgb;
	#elif defined(WATER_CUBE)
		reflection = waterCubeScale * textureCube(waterCube, reflect(-toCam, n)).rgb;
	#endif
		reflection *= waterReflectTint;
		// (what's below the surface is taken as fogged over: they're deep)
		vec3 fog = waterFogColor;
		vec3 sludgeLight = vec3(1.0);
	#ifdef WATER_LMFOG
		fog *= light;
		sludgeLight = light;
	#endif
	#if defined(WATER_BASE) && defined(WATER_FLOW)
		vec3 under = mix(fog, flowColor.rgb * sludgeLight, clamp(flowColor.a * 2.0, 0.0, 1.0));
		outgoingLight = mix(under, reflection, clamp(fresnel * (1.0 - smoothstep(0.5, 0.7, flowColor.a)), 0.0, 1.0));
	#elif defined(WATER_REFRACT)
		outgoingLight = fog + fresnel * reflection;
	#else
		outgoingLight = mix(fog, reflection, fresnel);
	#endif
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
uniform sampler2D paintSplat;
uniform vec2 paintTiles;
uniform float paintOn;
float paintAlpha = 0.0;
vec3 paintColor = vec3(0.0);
vec3 paintLight = vec3(0.0);
`;

// Gel, as the engine's paint shader draws it over a surface: coverage
// (with the splat texture's alpha averaged in) sets how thick it is, thin
// gel is desaturated and darker, and it's lit by the flat light map
// (times 0.82, plus a little of its own colour) and blended over
const PAINT_FRAGMENT = `
	#ifdef USE_LIGHTMAP
	if (paintOn > 0.5) {
		vec4 gel = texture2D(paintMap, vLightMapUv);
		if (gel.a > 0.01) {
			paintAlpha = clamp((gel.a + texture2D(paintSplat, vLightMapUv * paintTiles).a) * 0.5, 0.0, 1.0);
			float thick = smoothstep(0.34, 0.63, paintAlpha);
			vec3 c = pow(gel.rgb, vec3(2.2));
			paintColor = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114)) * 0.5), c, thick);
		}
	}
	#endif
`;

// (in the light maps' units, a scale of 1.5 over the engine's)
const PAINT_FINAL = `
	if (paintAlpha > 0.0) outgoingLight = mix(outgoingLight, (paintLight * 0.82 + 0.06) * paintColor * vec3(0.8, 0.85, 1.0), paintAlpha);
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
uniform sampler2D flashCookie;
uniform sampler2DShadow flashDepth;
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
		// (the engine's 5x5 Gaussian of hardware-filtered compares, a texel
		// apart: DoShadowNvidiaPCF5x5Gaussian)
		shadow = 0.0;
		for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
			int ax = abs(x), ay = abs(y);
			float w = ax == 2 && ay == 2 ? 1.0 : ax + ay == 3 ? 4.0 : (ax == 2 || ay == 2) ? 7.0 : ax + ay == 2 ? 20.0 : ax + ay == 1 ? 33.0 : 55.0;
			shadow += w * texture(flashDepth, vec3(uv + vec2(float(x), float(y)) * flashTexel, z));
		}
		shadow /= 331.0;
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
uniform float phongExponent;
uniform float phongBoost;
uniform vec3 phongFresnel;
uniform vec3 phongTint;
uniform sampler2D phongMaskMap;
uniform sampler2D phongExpMap;
uniform sampler2D selfIllumMask;
varying vec3 vAmbN;
`;

const AMBIENT_FRAGMENT = `
	{
		vec3 n = normalize(vAmbN);
		vec3 n2 = n * n;
		vec3 amb = n2.x * (n.x >= 0.0 ? ambCube[0] : ambCube[1])
			+ n2.y * (n.y >= 0.0 ? ambCube[2] : ambCube[3])
			+ n2.z * (n.z >= 0.0 ? ambCube[4] : ambCube[5]) + modelAmbient;
		for (int i = 0; i < 2; i++) {
			vec3 l = ambLightPos[i] - vDitherWorld;
			amb += ambLightColor[i] * max(dot(n, normalize(l)), 0.0);
		}
		amb += flashLight(vDitherWorld, n);
		reflectedLight.directDiffuse = vec3(0.0);
		reflectedLight.directSpecular = vec3(0.0);
		reflectedLight.indirectDiffuse = diffuseColor.rgb * amb * ambScale;
	#ifdef PHONG
		{
			// VertexLitGeneric's: (N.H)^exponent x sqrt(N.L) per light, times
			// the mask, boost and the fresnel ranges (low/mid/high by (1-N.V)^2)
			vec3 eye = normalize(cameraPosition - vDitherWorld);
			float f = 1.0 - clamp(dot(n, eye), 0.0, 1.0);
			f *= f;
			float fresnel = f > 0.5 ? mix(phongFresnel.y, phongFresnel.z, 2.0 * f - 1.0) : mix(phongFresnel.x, phongFresnel.y, 2.0 * f);
			float exponent = phongExponent;
		#if defined(PHONG_EXPMAP) && defined(USE_MAP)
			exponent = 1.0 + 149.0 * texture2D(phongExpMap, vMapUv).r;
		#endif
			vec3 spec = vec3(0.0);
			for (int i = 0; i < 2; i++) {
				vec3 l = normalize(ambLightPos[i] - vDitherWorld);
				spec += pow(clamp(dot(n, normalize(eye + l)), 0.0, 1.0), exponent) * sqrt(clamp(dot(n, l), 0.0, 1.0)) * ambLightColor[i];
			}
		#if defined(PHONG_BASEMASK) && defined(USE_MAP)
			spec *= texture2D(map, vMapUv).a;
		#elif defined(PHONG_BUMPMASK) && defined(USE_MAP)
			spec *= texture2D(phongMaskMap, vMapUv).a;
		#endif
			reflectedLight.indirectDiffuse += spec * phongBoost * fresnel * phongTint * ambScale;
		}
	#endif
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
	// (three's copy leaves out a built-in material's defines: Refract, goo...)
	m.defines = {...shared.defines};
	m.userData = {ambientLit: true, modelEnv: shared.userData.modelEnv, selfIllum: shared.userData.selfIllum, phong: shared.userData.phong, refractLocal: shared.userData.refractLocal};
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
		lmColor += modelAmbient;
		reflectedLight.indirectDiffuse += lmColor * lightMapIntensity * RECIPROCAL_PI;
		surfaceLight = lmColor * lightMapIntensity * RECIPROCAL_PI;
		paintLight = lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;
		// (in the light maps' units: their scale, lightMapIntensity / pi)
		reflectedLight.indirectDiffuse += flashLight(vDitherWorld, normalize(vEnvN)) * lightMapIntensity * RECIPROCAL_PI;
`;

// the self-illuminated detail modes, added after the lighting
// (TextureCombinePostLighting): 5 adds the detail times the blend factor, 6
// fades a band of it in
const DETAIL_POST_FRAGMENT = `
#if defined(DETAIL_MODE) && defined(USE_MAP)
#if DETAIL_MODE == 5
	outgoingLight += detailBlend * detailTexel.rgb;
#elif DETAIL_MODE == 6
	outgoingLight += detailBlend > 0.5
		? min(vec3(1.0), max(vec3(0.0), detailTexel.rgb - (1.0 - detailBlend)) / detailBlend)
		: 4.0 * detailBlend * max(vec3(0.0), detailTexel.rgb - 0.5);
#endif
#endif
`;

// Reflections (LightmappedGeneric's $envmap): the cubemap along the view
// reflected off the surface, tinted, contrast and saturation adjusted,
// scaled by a mask, added on top of the lit colour
const ENV_FRAGMENT_HEAD = `
uniform samplerCube envCube;
uniform vec3 envTint;
uniform float envScale;
uniform float envContrast;
uniform vec3 envSaturation;
uniform sampler2D envMaskMap;
uniform float envLightScale;
varying vec3 vEnvN;
vec3 surfaceLight = vec3(1.0);
vec3 envAdded = vec3(0.0);
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
	#elif defined(ENVMASK_ALPHA) && defined(USE_MAP)
		mask = texture2D(envMaskMap, vMapUv).a;
	#endif
		vec3 spec = envScale * textureCube(envCube, reflect(eye, n)).rgb;
		// $envmaplightscale (darker where the surface's light is) and the mask
		// go in before the tint and contrast, as the engine's shaders do: the
		// contrast squares them too
		spec = mix(spec, spec * clamp(surfaceLight, 0.0, 1.0), envLightScale);
		spec *= mask * envTint;
		spec = mix(spec, spec * spec, envContrast);
		spec = mix(vec3(dot(spec, vec3(0.299, 0.587, 0.114))), spec, envSaturation);
	#ifdef REFRACT_ENV
		// (Refract's reflection: by a fresnel from 0.6 face on)
		spec *= 0.6 + 0.4 * (1.0 - clamp(dot(n, -eye), 0.0, 1.0));
	#endif
		outgoingLight += spec;
		envAdded = spec;
	}
#endif
`;

// Refract surfaces draw their (unlit) tint, multiplied onto what's behind;
// with a reflection, the reflection added and the tint as a grey level in
// alpha (blended as reflection + behind x alpha). $localrefract looks into
// the base texture instead: through the normal map, from a depth below the
// surface, darker where the normal tilts (the slats of light covers)
const REFRACT_FRAGMENT = `
#if defined(REFRACT_LOCAL) && defined(USE_MAP)
	{
		// (the tangent frame from screen-space derivatives: there are no
		// tangent attributes; the binormal runs along the texture's v)
		vec3 dp1 = dFdx(vDitherWorld), dp2 = dFdy(vDitherWorld);
		vec2 duv1 = dFdx(vMapUv), duv2 = dFdy(vMapUv);
		vec3 gn = normalize(cross(dp1, dp2));
		vec3 dp2perp = cross(dp2, gn), dp1perp = cross(gn, dp1);
		vec3 tw = dp2perp * duv1.x + dp1perp * duv2.x;
		vec3 bw = dp2perp * duv1.y + dp1perp * duv2.y;
		float frameScale = inversesqrt(max(max(dot(tw, tw), dot(bw, bw)), 1e-20));
		tw *= frameScale;
		bw *= frameScale;
		vec3 nTs = texture2D(refractNormal, vMapUv).xyz * 2.0 - 1.0;
		vec3 toEye = normalize(cameraPosition - vDitherWorld);
		vec3 rTs = normalize(vec3(dot(toEye, tw), dot(toEye, bw), dot(toEye, gn)));
		float rDotN = -rTs.z;
		vec2 ruv = rTs.xy / rDotN + nTs.xy + (1.0 - nTs.z) * rTs.xy / rDotN;
		ruv = ruv * vec2(refractLocalParams.x, 1.0) * refractLocalParams.y + vMapUv;
		vec3 seen = texture2D(map, clamp(ruv, 0.0, 1.0)).rgb;
		float seenA = texture2D(map, clamp(vMapUv + nTs.xy * 0.1, 0.0, 1.0)).a;
		seen = mix(seen, vec3(seenA), 0.025);
		diffuseColor.rgb = seen * pow(max(nTs.z, 0.0), 3.0) * diffuse;
	}
#endif
#if defined(REFRACT_TINT) && defined(REFRACT_ENV)
	diffuseColor.a = dot(diffuseColor.rgb, vec3(1.0 / 3.0));
	outgoingLight = envAdded;
#elif defined(REFRACT_TINT)
	outgoingLight = diffuseColor.rgb;
#endif
#ifdef REFRACT_UNSCALED
	outgoingLight /= sceneExposure;
#endif
`;
const REFRACT_LOCAL_HEAD = `
#ifdef REFRACT_LOCAL
uniform sampler2D refractNormal;
uniform vec2 refractLocalParams;  // the texture's height / width, the depth
#endif
`;

export interface EnvSettings {
	cube: THREE.CubeTexture;
	tint: [number, number, number];
	scale: number;
	contrast: number;
	saturation: [number, number, number];
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
	saturation: [number, number, number];
	lightScale: number;
	mask: 'none' | 'base' | 'texture' | 'alpha';  // (alpha: in the mask map's alpha, Refract's normal map)
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
	(u.envSaturation.value as THREE.Vector3).set(...env.saturation);
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
			envSaturation: {value: new THREE.Vector3(1, 1, 1)},
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
			envSaturation: {value: new THREE.Vector3(...env.saturation)},
			envMaskMap: {value: env.maskMap},
			envLightScale: {value: env.lightScale},
		};
		material.defines = {...material.defines, ENVMAP_CUBE: ''};
		if (env.mask === 'base') material.defines.ENVMASK_BASE = '';
		if (env.mask === 'texture' && env.maskMap) material.defines.ENVMASK_TEXTURE = '';
		if (env.mask === 'alpha' && env.maskMap) material.defines.ENVMASK_ALPHA = '';
	}
	if (lit) {
		material.userData.ambUniforms = {
			ambCube: {value: Array.from({length: 6}, () => new THREE.Vector3())},
			ambLightPos: {value: [new THREE.Vector3(), new THREE.Vector3()]},
			ambLightColor: {value: [new THREE.Vector3(), new THREE.Vector3()]},
			ambScale: {value: AMBIENT_SCALE},
		};
		// $selfillum: the unlit colour (times the tint) where the mask says
		// $phong: highlights from the two local lights
		const ph = material.userData.phong as {exponent: number; boost: number; fresnel: number[]; tint: number[]; baseMask: boolean; maskMap: THREE.Texture | null; expMap: THREE.Texture | null} | undefined;
		if (ph) {
			Object.assign(material.userData.ambUniforms, {
				phongExponent: {value: ph.exponent}, phongBoost: {value: ph.boost},
				phongFresnel: {value: new THREE.Vector3(...ph.fresnel)}, phongTint: {value: new THREE.Vector3(...ph.tint)},
				phongMaskMap: {value: ph.maskMap}, phongExpMap: {value: ph.expMap},
			});
			material.defines = {...material.defines, PHONG: ''};
			if (ph.baseMask) material.defines.PHONG_BASEMASK = '';
			else if (ph.maskMap) material.defines.PHONG_BUMPMASK = '';
			if (ph.expMap) material.defines.PHONG_EXPMAP = '';
		}
		const si = material.userData.selfIllum as {tint: [number, number, number]; mask: THREE.Texture | null} | undefined;
		if (si) {
			Object.assign(material.userData.ambUniforms, {selfIllumTint: {value: new THREE.Vector3(...si.tint)}, selfIllumMask: {value: si.mask}});
			material.defines = {...material.defines, SELFILLUM: ''};
			if (si.mask) material.defines.SELFILLUM_MASK = '';
		}
	}
	material.onBeforeCompile = shader => {
		Object.assign(shader.uniforms, ditherUniforms, fogUniforms, exposureUniforms, flashUniforms, modelAmbientUniforms);
		if (material.userData.waterUniforms) Object.assign(shader.uniforms, waterUniforms, material.userData.waterUniforms);
		const local = material.userData.refractLocal as {normal: THREE.IUniform; params: THREE.IUniform} | undefined;
		if (local) Object.assign(shader.uniforms, {refractNormal: local.normal, refractLocalParams: local.params});
		if (paint) {
			Object.assign(shader.uniforms, paintUniforms, bumpLightUniforms, material.userData.envUniforms);
			shader.uniforms.bumpNormal = {value: material.userData.bumpNormal ?? null};
			shader.fragmentShader = BUMP_FRAGMENT_HEAD + ENV_FRAGMENT_HEAD + DETAIL_HEAD + shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + DETAIL_FRAGMENT).replace(
				'reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;',
				BUMP_FRAGMENT,
			).replace('#include <envmap_fragment>', '#include <envmap_fragment>\n' + DETAIL_POST_FRAGMENT + ENV_FRAGMENT).replace('#include <opaque_fragment>', PAINT_FINAL + '#include <opaque_fragment>');
			shader.vertexShader = 'varying vec3 vEnvN;\n' + shader.vertexShader.replace(
				'#include <project_vertex>',
				'#include <project_vertex>\n\tvEnvN = normalize(mat3(modelMatrix) * normal);',
			);
		}
		// static props (their light baked into vertex colours) take the
		// projected spotlight and mat_ambient_light too: the albedo times their light, added
		if (material.userData.vertexLit) {
			shader.vertexShader = 'varying vec3 vFlashN;\n' + shader.vertexShader.replace(
				'#include <project_vertex>',
				'#include <project_vertex>\n\tvFlashN = normalize(mat3(modelMatrix) * normal);',
			);
			shader.fragmentShader = 'varying vec3 vFlashN;\n' + shader.fragmentShader.replace(
				'vec3 outgoingLight = reflectedLight.indirectDiffuse;',
				`vec3 outgoingLight = reflectedLight.indirectDiffuse;
	#ifdef USE_MAP
		outgoingLight += texture2D(map, vMapUv).rgb * diffuse * (flashLight(vDitherWorld, normalize(vFlashN)) + modelAmbient);
	#endif`,
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
		shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', REFRACT_FRAGMENT + WATER_FRAGMENT + '#include <opaque_fragment>');
		shader.fragmentShader = DITHER_FRAGMENT_HEAD + FOG_HEAD + FLASH_HEAD + 'uniform float fogMaxDensity;\n' + WATER_HEAD + REFRACT_LOCAL_HEAD + (paint ? PAINT_FRAGMENT_HEAD : '') + shader.fragmentShader
			.replace('#include <fog_fragment>', FOG_FRAGMENT)
			.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + DITHER_FRAGMENT)
			.replace('#include <map_fragment>', '#include <map_fragment>\n' + WATER_ALBEDO + (paint ? PAINT_FRAGMENT : '') + BACKFACE_FRAGMENT);
	};
	material.customProgramCacheKey = () => (paint ? 'world+paint+dither' : 'dither') + (lit ? '+amb' : '') + (material.userData.vertexLit ? '+vlit' : '') + (material.defines?.BACKFACE_SHADE !== undefined ? '+back' : '') + (material.defines?.BUMPLIGHT !== undefined ? '+bump' : '') + (material.defines?.SSBUMP !== undefined ? '+ss' : '') + (material.defines?.REFRACT_TINT !== undefined ? '+refract' : '') + (material.defines?.REFRACT_ENV !== undefined ? '+renv' : '') + (material.defines?.REFRACT_UNSCALED !== undefined ? '+unscaled' : '') + (material.defines?.REFRACT_LOCAL !== undefined ? '+local' : '') + (material.defines?.DETAIL_MODE !== undefined ? '+detail' + material.defines.DETAIL_MODE : '') + (material.defines?.SELFILLUM !== undefined ? '+si' : '') + (material.defines?.PHONG !== undefined ? '+phong' : '') + (material.defines?.PHONG_BASEMASK !== undefined ? '+phmask' : '') + (material.defines?.PHONG_BUMPMASK !== undefined ? '+phbump' : '') + (material.defines?.PHONG_EXPMAP !== undefined ? '+phexp' : '') + (material.defines?.SELFILLUM_MASK !== undefined ? '+simask' : '') + Object.keys(material.defines ?? {}).filter(k => k.startsWith('ENV') || k.startsWith('WATER')).sort().join('+');
}

export const hookWorldMaterial = (m: THREE.Material) => hook(m, true);
export const hookModelMaterial = (m: THREE.Material) => hook(m, false);
