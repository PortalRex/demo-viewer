import {isSarp, readSarp} from './sarp.ts';
import {isDem, readDem} from './dem.ts';
import type {Run} from './model.ts';

export async function loadRun(bytes: Uint8Array, fileName: string): Promise<Run> {
	if (isSarp(bytes)) return readSarp(bytes, fileName);
	if (isDem(bytes)) return readDem(bytes, fileName);
	throw new Error('Not a SAR proof (.sarp) or Source demo (.dem).');
}
