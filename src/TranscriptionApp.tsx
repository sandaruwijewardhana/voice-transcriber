import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Copy, Check, GripVertical, X, RotateCcw, Cpu, Zap, Activity, Bug, Terminal, Info } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const MotionDiv = motion.div as any;
const MotionSpan = motion.span as any;
const MotionButton = motion.button as any;

// @ts-ignore
import WhisperWorker from './whisperWorker.ts?worker';
// @ts-ignore
import processorUrl from './audioProcessor.ts?url';

// --- VISUALIZER ---
const SpectralVisualizer = ({ isListening, stream, synthetic }: { isListening: boolean, stream: MediaStream | null, synthetic?: boolean }) => {
  const [freqData, setFreqData] = useState<number[]>(new Array(32).fill(0));
  const animRef = useRef<number | null>(null);

  useEffect(() => {
    if (isListening && (stream || synthetic)) {
      let analyzer: AnalyserNode | null = null;
      let ctx: AudioContext | null = null;

      try {
        if (stream) {
          ctx = new AudioContext();
          const source = ctx.createMediaStreamSource(stream);
          analyzer = ctx.createAnalyser();
          analyzer.fftSize = 64;
          source.connect(analyzer);
        }
      } catch (e) {
        console.error("Viz Context Error", e);
      }

      const update = () => {
        if (analyzer) {
          const data = new Uint8Array(analyzer.frequencyBinCount);
          analyzer.getByteFrequencyData(data);
          setFreqData(Array.from(data.slice(0, 32)).map(v => v / 255));
        } else if (synthetic) {
          setFreqData(prev => prev.map(() => Math.random() * 0.4));
        }
        animRef.current = requestAnimationFrame(update);
      };
      update();
      return () => {
        if (animRef.current) cancelAnimationFrame(animRef.current);
        if (ctx) ctx.close();
      };
    }
    setFreqData(new Array(32).fill(0));
  }, [isListening, stream, synthetic]);

  return (
    <div className="viz-box">
      {freqData.map((val, i) => (
        <MotionDiv
          key={i}
          animate={{ height: Math.max(2, val * 45), opacity: val + 0.1 }}
          className="viz-bin"
          style={{ backgroundColor: val > 0.6 ? '#818cf8' : '#6366f1' }}
        />
      ))}
    </div>
  );
};

const TranscriptionApp = () => {
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState('Booting Neural Engine...');
  const [isReady, setIsReady] = useState(false);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const isListeningRef = useRef(false);
  const audioBufferRef = useRef<number[]>([]);
  const transcribeIntervalRef = useRef<any>(null);

  const isProcessingRef = useRef(false);
  const processingLengthRef = useRef(0);
  const fullTextRef = useRef('');
  const currentTextRef = useRef('');

  const setListening = (val: boolean) => {
    setIsListening(val);
    isListeningRef.current = val;
  };

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev.slice(-15), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  useEffect(() => {
    addLog("Activating Neural Worker...");
    try {
      workerRef.current = new WhisperWorker();
      workerRef.current!.onmessage = (e) => {
        const { status: s, message, text: t } = e.data;
        if (s === 'ready') {
          setIsReady(true);
          setStatus('Ready');
          addLog("Engine: ONLINE");
        } else if (s === 'loading') {
          setStatus(message);
          addLog(message);
        } else if (s === 'complete') {
          console.log(`App: Received complete status from worker. Text returned = "${t}"`);
          console.log(`App: processingLengthRef = ${processingLengthRef.current}, buffer size before slice = ${audioBufferRef.current.length}`);

          // Clean up weird whisper tags like [BLANK_AUDIO]
          const cleanText = t ? t.replace(/\[.*?\]/g, '').trim() : '';
          console.log(`App: cleanText = "${cleanText}"`);

          if (cleanText) {
            currentTextRef.current = cleanText;
          } else if (processingLengthRef.current > 16000) {
            // Only clear currentText if we processed a decent chunk and it's truly silent
            console.log(`App: Audio was deemed silent. Resetting currentTextRef.`);
            currentTextRef.current = '';
          }

          const combined = fullTextRef.current + (fullTextRef.current && currentTextRef.current ? ' ' : '') + currentTextRef.current;
          setText(combined);

          // If we've processed more than 7 seconds of audio in this chunk, 
          // let's commit it and start a fresh buffer so it doesn't grow infinitely
          if (processingLengthRef.current >= 16000 * 7) {
            console.log(`App: Buffer exceeded 7 seconds. Committing text to fullTextRef and resetting buffer.`);
            fullTextRef.current += (fullTextRef.current && currentTextRef.current ? ' ' : '') + currentTextRef.current;
            currentTextRef.current = ''; // Reset current text
            // Slice out the processed audio
            audioBufferRef.current = audioBufferRef.current.slice(processingLengthRef.current);
          }

          isProcessingRef.current = false;
        } else if (s === 'error') {
          isProcessingRef.current = false;
          setStatus('ENGINE ERROR');
          addLog(`CRITICAL: ${message}`);
        }
      };
      workerRef.current!.onerror = (err) => {
        addLog(`WORKER FAIL: ${err.message || 'Check Network'}`);
        setStatus('Fault');
      };
      workerRef.current!.postMessage({ cmd: 'init' });
    } catch (err: any) {
      addLog(`LAUNCH FAIL: ${err.message}`);
      setStatus('Error');
    }

    return () => workerRef.current?.terminate();
  }, [addLog]);

  const startRecording = async () => {
    addLog("Starting Audio...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;

      await ctx.audioWorklet.addModule(processorUrl);

      const source = ctx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(ctx, 'voice-processor');

      audioBufferRef.current = []; // Reset buffer

      workletNode.port.onmessage = (e) => {
        if (isListeningRef.current) {
          // Accumulate raw float32 audio data
          const newAudio = Array.from(e.data as Float32Array);
          audioBufferRef.current.push(...newAudio);

          // Prevent buffer from growing infinitely (keep last 30 seconds = 480,000 samples)
          if (audioBufferRef.current.length > 480000) {
            audioBufferRef.current = audioBufferRef.current.slice(-480000);
          }
        }
      };

      source.connect(workletNode);
      workletNode.connect(ctx.destination);

      setListening(true);
      setStatus('Recording...');
      addLog("Mic: ACTIVE");

      // Periodically send accumulated buffer to worker
      transcribeIntervalRef.current = setInterval(() => {
        if (isListeningRef.current && workerRef.current && !isProcessingRef.current) {
          // Wait until we have at least ~0.8s of audio to start
          if (audioBufferRef.current.length > 12000) {
            isProcessingRef.current = true;
            processingLengthRef.current = audioBufferRef.current.length;
            const bufferToSend = new Float32Array(audioBufferRef.current.slice(0, processingLengthRef.current));

            let maxVol = 0;
            for (let i = 0; i < bufferToSend.length; i++) {
              if (Math.abs(bufferToSend[i]) > maxVol) maxVol = Math.abs(bufferToSend[i]);
            }
            console.log(`App: Sending buffer to worker. Max volume: ${maxVol.toFixed(5)}`);

            workerRef.current.postMessage({ audio: bufferToSend });
          }
        }
      }, 800); // Check processing state every 800ms

    } catch (err: any) {
      console.error("startRecording FAILED:", err);
      addLog(`AUDIO FAIL: ${err.message}`);
      setStatus('Error');
    }
  };

  const runSyntheticTest = () => {
    addLog("Verifying Engine...");
    setListening(true);
    setStatus("Testing...");
    const buf = new Float32Array(32000).map(() => Math.random() * 0.05);
    workerRef.current?.postMessage({ audio: buf });
    setTimeout(() => { if (isListeningRef.current) stopRecording(); }, 1000);
  };

  const stopRecording = () => {
    setListening(false);
    setStatus('Ready');
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (audioCtxRef.current) audioCtxRef.current.close().catch(() => { });
    if (transcribeIntervalRef.current) clearInterval(transcribeIntervalRef.current);
    addLog("Mic: OFF");
  };

  return (
    <div className="pro-frame">
      <div className="pro-nav">
        <GripVertical size={14} className="drag-handle opacity-20" />
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-indigo-400" />
          <span className="nav-text">NEURAL v9</span>
          <span className="badge">FINAL</span>
        </div>
        <div className="flex-1" />
        <button onClick={() => setShowLogs(!showLogs)} className="nav-btn"><Terminal size={12} /></button>
        <button onClick={() => (window as any).close()} className="nav-close"><X size={14} /></button>
      </div>

      <div className="pro-grid">
        <div className="side-bar">
          <MotionButton
            disabled={!isReady}
            onClick={isListeningRef.current ? stopRecording : startRecording}
            className={`mic-btn ${isListeningRef.current ? 'active' : ''}`}
          >
            {isListeningRef.current ? <Mic size={24} /> : <MicOff size={24} />}
          </MotionButton>
          <SpectralVisualizer isListening={isListeningRef.current} stream={streamRef.current} synthetic={status === "Testing..."} />
          <div className="status-pill">
            <span className={`pill-dot ${isReady ? 'online' : 'booting'}`} />
            <span className="pill-text">{status}</span>
          </div>
        </div>

        <div className="main-feed">
          <div className="text-card">
            <AnimatePresence mode="wait">
              {showLogs ? (
                <MotionDiv
                  key="logs"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="log-viewer"
                >
                  <div className="flex items-center gap-2 mb-2 text-[10px] opacity-40 uppercase font-black"><Activity size={10} /> Diagnostics</div>
                  <div className="log-scroll">
                    {logs.map((l, i) => <div key={i} className="log-line">{l}</div>)}
                  </div>
                  <button onClick={runSyntheticTest} className="test-btn">Verify AI Engine</button>
                </MotionDiv>
              ) : (
                <div key="text" className="scroll-box">
                  {text || <span className="placeholder">AI ready. Speak now...</span>}
                  {isListeningRef.current && (
                    <MotionSpan animate={{ opacity: [0, 1] }} transition={{ repeat: Infinity }} className="cursor" />
                  )}
                </div>
              )}
            </AnimatePresence>
          </div>
          <div className="action-bar">
            <button className="util-btn grow" onClick={() => {
              if (!text) return;
              navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}>
              {copied ? <Check size={14} color="#4ade80" /> : <Copy size={14} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
            <button className="util-btn px-4" onClick={() => {
              setText('');
              fullTextRef.current = '';
              currentTextRef.current = '';
              audioBufferRef.current = [];
            }}>
              <RotateCcw size={14} />
              <span>Clear</span>
            </button>
          </div>
        </div>
      </div>

      <style>{`
                body { margin: 0; font-family: 'Inter', sans-serif; background: transparent; color: white; user-select: none; }
                .pro-frame { width: 478px; height: 278px; background: rgba(10, 10, 15, 0.98); backdrop-filter: blur(80px); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 50px 150px rgba(0,0,0,1); }
                .pro-nav { -webkit-app-region: drag; height: 44px; display: flex; align-items: center; padding: 0 18px; background: rgba(255,255,255,0.05); border-bottom: 1px solid rgba(255,255,255,0.1); }
                .nav-text { font-size: 10px; font-weight: 900; letter-spacing: 3px; color: rgba(255,255,255,0.5); }
                .badge { font-size: 9px; font-weight: 900; background: #6366f1; padding: 2px 8px; border-radius: 6px; margin-left: 12px; }
                .nav-btn, .nav-close { -webkit-app-region: no-drag; background: none; border: none; color: rgba(255,255,255,0.3); padding: 8px; cursor: pointer; }
                .pro-grid { flex: 1; padding: 24px; display: flex; gap: 24px; }
                .side-bar { width: 130px; display: flex; flex-direction: column; align-items: center; gap: 20px; border-right: 1px solid rgba(255,255,255,0.1); padding-right: 24px; }
                .main-feed { flex: 1; display: flex; flex-direction: column; gap: 20px; }
                .mic-btn { width: 64px; height: 64px; border-radius: 100%; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: #6366f1; cursor: pointer; }
                .mic-btn.active { background: #6366f1; color: white; box-shadow: 0 10px 30px rgba(99, 102, 241, 0.5); }
                .viz-box { display: flex; gap: 4px; height: 38px; align-items: flex-end; }
                .viz-bin { width: 3.5px; border-radius: 4px; }
                .status-pill { display: flex; align-items: center; gap: 10px; background: rgba(0,0,0,0.5); padding: 8px 16px; border-radius: 30px; border: 1px solid rgba(255,255,255,0.1); }
                .pill-dot { width: 8px; height: 8px; border-radius: 100%; }
                .pill-dot.online { background: #4ade80; box-shadow: 0 0 10px #4ade80; }
                .pill-dot.booting { background: #fbbf24; animation: pulse 1s infinite; }
                .pill-text { font-size: 10px; font-weight: 900; color: rgba(255,255,255,0.8); text-transform: uppercase; }
                .text-card { flex: 1; background: rgba(0,0,0,0.6); border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); padding: 20px; overflow: hidden; }
                .scroll-box { height: 100%; overflow-y: auto; font-size: 16px; line-height: 1.8; }
                .placeholder { opacity: 0.2; }
                .cursor { display: inline-block; width: 4px; height: 20px; background: #6366f1; }
                .log-viewer { font-family: 'JetBrains Mono', monospace; font-size: 10px; height: 100%; color: #818cf8; display: flex; flex-direction: column; }
                .log-scroll { flex: 1; overflow-y: auto; }
                .log-line { margin-bottom: 6px; border-left: 3px solid #6366f1; padding-left: 10px; }
                .test-btn { margin-top: 10px; background: #6366f1; color: white; border: none; padding: 10px; border-radius: 10px; font-size: 10px; font-weight: 900; cursor: pointer; }
                .action-bar { display: flex; gap: 12px; }
                .util-btn { height: 48px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; color: rgba(255,255,255,0.7); display: flex; align-items: center; justify-content: center; gap: 14px; font-size: 12px; font-weight: 800; cursor: pointer; }
                .grow { flex: 1; }
                .flex { display: flex; }
                .items-center { align-items: center; }
                .gap-2 { gap: 8px; }
                .flex-1 { flex: 1; }
                .opacity-20 { opacity: 0.2; }
                .uppercase { text-transform: uppercase; }
                .font-black { font-weight: 900; }
                .mb-2 { margin-bottom: 8px; }
                @keyframes pulse { 0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; } }
            `}</style>
    </div>
  );
};

export default TranscriptionApp;
