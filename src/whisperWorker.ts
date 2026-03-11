import { pipeline, env } from '@xenova/transformers';

/**
 * GLOBAL STABILITY WRAPPER
 * Catches early initialization errors that cause "Worker Crash: undefined"
 */
try {
    // Electron-specific config for maximum compatibility
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // Force single-threading (prevents SharedArrayBuffer issues & CORB blocks)
    (env as any).wasm = (env as any).wasm || {};
    (env as any).wasm.numThreads = 1;
    (env as any).wasm.proxy = false;

    // Silence noisy ONNX warnings (Elite UX)
    if ((env as any).backends?.onnx) {
        (env as any).backends.onnx.logLevel = 'error';
    }

    let transcriber: any = null;

    async function init() {
        try {
            console.log("Worker: Initializing Neural Engine...");
            self.postMessage({ status: 'loading', message: 'Engine: Loading Model...' });

            transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
                progress_callback: (data: any) => {
                    if (data.status === 'progress') {
                        self.postMessage({
                            status: 'loading',
                            message: `Engine: Downloading ${data.progress.toFixed(0)}%`
                        });
                    }
                }
            });

            console.log("Worker: Neural Engine Ready");
            self.postMessage({ status: 'ready' });
        } catch (err: any) {
            console.error("Worker: Init Error", err);
            self.postMessage({ status: 'error', message: `Engine Load Failed: ${err.message}` });
        }
    }

    self.onmessage = async (e: any) => {
        const { audio, cmd } = e.data;

        if (cmd === 'init') {
            await init();
            return;
        }

        if (!transcriber) {
            console.error("Worker: Transcriber not ready");
            return;
        }

        if (!audio) return;

        try {
            console.log(`Worker: Starting transcription, audio array length: ${audio.length}`);
            const output = await transcriber(audio, {
                return_timestamps: true,
                chunk_length_s: 30,
            });

            console.log(`Worker: Transcriber output object:`, JSON.stringify(output));

            if (output.text && output.text.trim()) {
                self.postMessage({ status: 'complete', text: output.text });
            } else {
                console.log(`Worker: Output was empty or whitespace only.`);
                self.postMessage({ status: 'complete', text: '' });
            }
        } catch (err: any) {
            console.error("Worker: Transcription Error", err);
            self.postMessage({ status: 'complete', text: '' });
            // Don't crash on individual chunk errors
        }
    };

} catch (globalErr: any) {
    console.error("Worker Global Crash", globalErr);
    self.postMessage({
        status: 'error',
        message: `Worker Global Crash: ${globalErr?.message || 'Unknown Syntax or Import Error'}`
    });
}
