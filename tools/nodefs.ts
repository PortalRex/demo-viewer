// GameFS over the local install, for the probes
import {openSync, readSync, fstatSync, existsSync, closeSync} from 'node:fs';
import type {GameFS} from '../src/game/gamefs.ts';

export const ROOT = process.env.P2_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Portal 2';

export const nodeFS: GameFS = {
	label: 'node',
	async read(path, offset = 0, length) {
		const p = `${ROOT}/${path}`;
		if (!existsSync(p)) return null;
		const fd = openSync(p, 'r');
		const n = length ?? fstatSync(fd).size - offset;
		const buf = new Uint8Array(n);
		readSync(fd, buf, 0, n, offset);
		closeSync(fd);
		return buf;
	},
	async size(path) {
		const p = `${ROOT}/${path}`;
		if (!existsSync(p)) return null;
		const fd = openSync(p, 'r');
		const s = fstatSync(fd).size;
		closeSync(fd);
		return s;
	},
};
