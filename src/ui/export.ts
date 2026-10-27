// Recording the 3D view to an MP4 in the page: frames drawn one by one (not
// in real time: each waits for whatever it shows), encoded as H.264 with
// WebCodecs and put in an MP4 file
import {Muxer, ArrayBufferTarget} from 'mp4-muxer';

export interface VideoJob {
	width: number;
	height: number;
	fps: number;
	frames: number;
	// frame i drawn, onto the canvas given back
	frame(i: number): Promise<CanvasImageSource & (HTMLCanvasElement | OffscreenCanvas)>;
	progress(done: number): void;
	cancelled(): boolean;
}

export const canExportVideo = () => typeof VideoEncoder !== 'undefined';

// (the levels that fit the size: High profile, 4.0 for 1080p30, 4.2 for
// 1080p60, 5.1 for bigger)
async function pickCodec(width: number, height: number, fps: number, bitrate: number): Promise<VideoEncoderConfig | null> {
	const pixels = width * height * fps;
	const levels = pixels <= 1920 * 1080 * 30 ? ['28', '2a', '33'] : pixels <= 1920 * 1080 * 60 ? ['2a', '33'] : ['33', '34'];
	for (const profile of ['6400', '4d00', '4200']) {
		for (const level of levels) {
			const config: VideoEncoderConfig = {codec: `avc1.${profile}${level}`, width, height, bitrate, framerate: fps, avc: {format: 'avc'}};
			if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
		}
	}
	return null;
}

// the video, or null if cancelled
export async function recordMp4(job: VideoJob): Promise<Blob | null> {
	const {width, height, fps} = job;
	// (about 0.12 bits a pixel: sharp for a moving game view)
	const bitrate = Math.round(width * height * fps * 0.12);
	const config = await pickCodec(width, height, fps, bitrate);
	if (!config) throw new Error(`This browser can't encode ${width}×${height} H.264 video.`);
	const muxer = new Muxer({target: new ArrayBufferTarget(), video: {codec: 'avc', width, height, frameRate: fps}, fastStart: 'in-memory'});
	let failure: Error | null = null;
	const encoder = new VideoEncoder({
		output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
		error: e => (failure = e),
	});
	encoder.configure(config);
	try {
		for (let i = 0; i < job.frames; i++) {
			if (job.cancelled()) return null;
			if (failure) throw failure;
			const canvas = await job.frame(i);
			const frame = new VideoFrame(canvas, {timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps)});
			// (a keyframe every two seconds, so the video seeks well)
			encoder.encode(frame, {keyFrame: i % (fps * 2) === 0});
			frame.close();
			// (the encoder kept a few frames ahead at most)
			while (encoder.encodeQueueSize > 4) await new Promise(r => encoder.addEventListener('dequeue', r, {once: true}));
			job.progress(i + 1);
		}
		await encoder.flush();
		if (failure) throw failure;
		muxer.finalize();
		return new Blob([muxer.target.buffer], {type: 'video/mp4'});
	} finally {
		if (encoder.state !== 'closed') encoder.close();
	}
}
