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

// Source's fog: linear from start to end, up to a maximum density
export const fogUniforms = {
	fogMaxDensity: {value: 1},
};

const FOG_FRAGMENT = `
#ifdef USE_FOG
	float fogFactor = clamp((vFogDepth - fogNear) / max(fogFar - fogNear, 1.0), 0.0, 1.0) * fogMaxDensity;
	gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
#endif
`;

export const ditherUniforms = {
	ditherOn: {value: 0},
	ditherTarget: {value: new THREE.Vector3()},
	ditherRadius: {value: 110},
};

const DITHER_FRAGMENT_HEAD = `
varying vec3 vDitherWorld;
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
		// only between the camera and (a little short of) the player
		if (along > 0.0 && along < len - 20.0) {
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

function hook(material: THREE.Material, paint: boolean) {
	material.onBeforeCompile = shader => {
		Object.assign(shader.uniforms, ditherUniforms, fogUniforms);
		if (paint) Object.assign(shader.uniforms, paintUniforms);
		shader.vertexShader = 'varying vec3 vDitherWorld;\n' + shader.vertexShader.replace(
			'#include <project_vertex>',
			'#include <project_vertex>\n\tvDitherWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
		);
		shader.fragmentShader = DITHER_FRAGMENT_HEAD + 'uniform float fogMaxDensity;\n' + (paint ? PAINT_FRAGMENT_HEAD : '') + shader.fragmentShader
			.replace('#include <fog_fragment>', FOG_FRAGMENT)
			.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + DITHER_FRAGMENT)
			.replace('#include <map_fragment>', '#include <map_fragment>\n' + (paint ? PAINT_FRAGMENT : ''));
	};
	material.customProgramCacheKey = () => (paint ? 'world+paint+dither' : 'dither');
}

export const hookWorldMaterial = (m: THREE.Material) => hook(m, true);
export const hookModelMaterial = (m: THREE.Material) => hook(m, false);
