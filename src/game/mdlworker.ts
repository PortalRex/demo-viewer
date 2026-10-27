// The worker side of the model parser pool (see mdlpool.ts): a model's three
// files in, the parsed model back, its arrays handed over rather than copied
import {parseModel} from './mdl.ts';

self.onmessage = (e: MessageEvent) => {
	const {id, mdl, vvd, vtx, color, skin, body} = e.data;
	let model = null;
	try {
		model = parseModel(mdl, vvd, vtx, color, skin, body);
	} catch {
		// (a file the parser can't take: the model just doesn't show)
	}
	const buffers = new Set<ArrayBuffer>();
	if (model) {
		buffers.add(model.bytes.buffer as ArrayBuffer);
		for (const g of model.groups) {
			for (const v of Object.values(g)) {
				if (ArrayBuffer.isView(v)) buffers.add(v.buffer as ArrayBuffer);
			}
		}
	}
	(self as unknown as Worker).postMessage({id, model}, [...buffers]);
};
