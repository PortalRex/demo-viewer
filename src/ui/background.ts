// Background work, done in small pieces so frames keep coming: a map
// settling in (shaders compiled, props merged and lit, bounds trees built,
// textures sent to the GPU). After each frame drawn, a few milliseconds of
// it; while no frames come (paused, or a hidden tab), bigger pieces on its
// own. A job does one small piece a call and says whether there's more; jobs
// take turns.
import {later} from '../core/later.ts';

export type Job = () => boolean;

const jobs: Job[] = [];
const firsts = new Set<Job>();  // jobs that go ahead of the rest
let lastFrame = 0;
let pumping = false;

// a job to run until it says it's done; `first`: ahead of the rest (work
// that makes frames cheaper once done, like merging the props, shouldn't
// wait its turn behind the rest)
export function background(job: Job, first = false) {
	if (first) {
		firsts.add(job);
		jobs.unshift(job);
	} else jobs.push(job);
	pump();
}

// after a frame is drawn: some of the work, within the frame's spare time
export function afterFrame(budget = 8) {
	lastFrame = performance.now();
	run(budget);
}

function run(budget: number) {
	const end = performance.now() + budget;
	while (jobs.length && performance.now() < end) {
		const job = jobs[0];
		let more = false;
		try {
			more = job();
		} catch (e) {
			console.warn('background job failed', e);
		}
		// (a job ahead of the rest keeps going until it's done)
		const i = jobs.indexOf(job);
		if (i >= 0) jobs.splice(i, 1);
		if (more) {
			if (i === 0 && firsts.has(job)) jobs.unshift(job);
			else jobs.push(job);
		} else firsts.delete(job);
	}
}

// (while frames come they run the work; otherwise this does, in bigger pieces)
function pump() {
	if (pumping || !jobs.length) return;
	pumping = true;
	later(() => {
		pumping = false;
		if (performance.now() - lastFrame > 100) run(16);
		pump();
	}, 30);
}
