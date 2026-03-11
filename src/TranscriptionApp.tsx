import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Copy, Check, GripVertical, X, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const MotionDiv = motion.div as any;
const MotionSpan = motion.span as any;

// @ts-ignore
import WhisperWorker from './whisperWorker.ts?worker';
// @ts-ignore
import processorUrl from './audioProcessor.ts?url';

const SpectralVisualizer = ({ isListening, stream }: { isListening: boolean, stream: MediaStream | null }) => {
  const [freqData, setFreqData] = useState<number[]>(new Array(40).fill(0));
  const animRef = useRef<number | null>(null);

  useEffect(() => {
    if (isListening && stream) {
      let analyzer: AnalyserNode | null = null;
      let ctx: AudioContext | null = null;

      try {
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        analyzer = ctx.createAnalyser();
        analyzer.fftSize = 128;
        source.connect(analyzer);
      } catch (e) {
        console.error("Viz Context Error", e);
      }

      const update = () => {
        if (analyzer) {
          const data = new Uint8Array(analyzer.frequencyBinCount);
          analyzer.getByteFrequencyData(data);
          // Scale down the data purely for aesthetic cute wave
          setFreqData(Array.from(data.slice(0, 40)).map(v => v / 255));
        }
        animRef.current = requestAnimationFrame(update);
      };
      update();
      return () => {
        if (animRef.current) cancelAnimationFrame(animRef.current);
        if (ctx) ctx.close().catch(() => { });
      };
    } else {
      setFreqData(new Array(40).fill(0));
    }
  }, [isListening, stream]);

  return (
    <div className="viz-box">
      {freqData.map((val, i) => (
        <MotionDiv
          key={i}
          animate={{ height: Math.max(2, val * 16) }}
          className={`viz-bin ${val > 0.3 ? 'active-bin' : ''}`}
        />
      ))}
    </div>
  );
};

const TranscriptionApp = () => {
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState('Booting Engine...');
  const [isReady, setIsReady] = useState(false);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

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

  useEffect(() => {
    const fetchDevices = () => {
      navigator.mediaDevices.enumerateDevices().then(devs => {
        const audioInputs = devs.filter(d => d.kind === 'audioinput');
        setDevices(audioInputs);
        if (audioInputs.length > 0 && !selectedDeviceId) setSelectedDeviceId(audioInputs[0].deviceId);
      }).catch(console.error);
    };

    // The Ultimate Bypass for Chromium device enumeration sandbox:
    // Chromium will almost never return hardware labels or full lists until
    // an actual stream has been granted AND attached/consumed.
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      // Create a dummy audio element to consume the stream for 100ms
      const dummy = document.createElement('audio');
      dummy.muted = true;
      dummy.srcObject = stream;
      dummy.play().catch(() => { });

      setTimeout(() => {
        stream.getTracks().forEach(t => t.stop());
        dummy.remove();
        fetchDevices();
      }, 500);
    }).catch(console.error);

    setTimeout(fetchDevices, 1500);
    setTimeout(fetchDevices, 3000);
  }, []);

  const setListening = (val: boolean) => {
    setIsListening(val);
    isListeningRef.current = val;
  };

  useEffect(() => {
    try {
      workerRef.current = new WhisperWorker();
      workerRef.current!.onmessage = (e) => {
        const { status: s, message, text: t } = e.data;
        if (s === 'ready') {
          setIsReady(true);
          setStatus('Ready');
        } else if (s === 'loading') {
          setStatus('Loading Model...');
        } else if (s === 'complete') {
          const cleanText = t ? t.replace(/\[.*?\]/g, '').trim() : '';

          if (cleanText) {
            currentTextRef.current = cleanText;
          } else if (processingLengthRef.current > 16000) {
            currentTextRef.current = '';
          }

          const combined = fullTextRef.current + (fullTextRef.current && currentTextRef.current ? ' ' : '') + currentTextRef.current;
          setText(combined);

          if (processingLengthRef.current >= 16000 * 7) {
            fullTextRef.current += (fullTextRef.current && currentTextRef.current ? ' ' : '') + currentTextRef.current;
            currentTextRef.current = '';
            audioBufferRef.current = audioBufferRef.current.slice(processingLengthRef.current);
          }

          isProcessingRef.current = false;
        } else if (s === 'error') {
          isProcessingRef.current = false;
          setStatus('Error');
        }
      };
      workerRef.current!.onerror = () => setStatus('Worker Fault');
      workerRef.current!.postMessage({ cmd: 'init' });
    } catch (err: any) {
      setStatus('Crash');
    }

    return () => workerRef.current?.terminate();
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      streamRef.current = stream;
      setMediaStream(stream);

      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;

      await ctx.audioWorklet.addModule(processorUrl);

      const source = ctx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(ctx, 'voice-processor');

      audioBufferRef.current = [];

      workletNode.port.onmessage = (e) => {
        if (isListeningRef.current) {
          const newAudio = Array.from(e.data as Float32Array);
          audioBufferRef.current.push(...newAudio);

          if (audioBufferRef.current.length > 480000) {
            audioBufferRef.current = audioBufferRef.current.slice(-480000);
          }
        }
      };

      source.connect(workletNode);
      workletNode.connect(ctx.destination);

      setListening(true);
      setStatus('Recording...');

      transcribeIntervalRef.current = setInterval(() => {
        if (isListeningRef.current && workerRef.current && !isProcessingRef.current) {
          if (audioBufferRef.current.length > 12000) {
            isProcessingRef.current = true;
            processingLengthRef.current = audioBufferRef.current.length;
            const bufferToSend = new Float32Array(audioBufferRef.current.slice(0, processingLengthRef.current));
            workerRef.current.postMessage({ audio: bufferToSend });
          }
        }
      }, 800);

    } catch (err: any) {
      console.error(err);
      setStatus('Mic Denied/Error');
    }
  };

  const stopRecording = () => {
    setListening(false);
    setStatus('Ready');
    streamRef.current?.getTracks().forEach(t => t.stop());
    setMediaStream(null);
    if (audioCtxRef.current) audioCtxRef.current.close().catch(() => { });
    if (transcribeIntervalRef.current) clearInterval(transcribeIntervalRef.current);
  };

  return (
    <div className="cute-frame">
      <div className="cute-header drag-handle">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <GripVertical size={10} className="opacity-50" />
          <span style={{ opacity: 0.7 }}>VOICE AI</span>
        </div>
        <button className="close-btn" onClick={() => (window as any).close()}>
          <X size={10} />
        </button>
      </div>

      <div className="mid-row">
        <button
          onClick={isListeningRef.current ? stopRecording : startRecording}
          className={`cute-mic ${isListeningRef.current ? 'active' : ''}`}
          disabled={!isReady}
        >
          {isListeningRef.current ? <Mic size={14} /> : <MicOff size={14} />}
        </button>
        <div className="mic-settings">
          <select
            className="mic-select"
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
            disabled={isListeningRef.current}
          >
            {devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Unknown Mic'}</option>)}
          </select>
          <div className="viz-container">
            <SpectralVisualizer isListening={isListeningRef.current} stream={mediaStream} />
          </div>
        </div>
      </div>

      <div className="cute-text-box">
        <div style={{ flex: 1 }}>
          <span style={{ color: '#818cf8', marginRight: '4px', fontWeight: 'bold' }}>[{status}]</span>
          <span>{text || <span style={{ opacity: 0.3 }}>Waiting for speech...</span>}</span>
          {isListeningRef.current && (
            <MotionSpan animate={{ opacity: [0, 1] }} transition={{ repeat: Infinity }} className="cursor" />
          )}
        </div>
        <div className="actions">
          <button className="mini-btn" onClick={() => {
            if (!text) return;
            navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}>
            {copied ? <Check size={10} color="#4ade80" /> : <Copy size={10} />} {copied ? 'COPIED' : 'COPY'}
          </button>
          <button className="mini-btn" onClick={() => {
            setText(''); fullTextRef.current = ''; currentTextRef.current = ''; audioBufferRef.current = [];
          }}>
            <RotateCcw size={10} /> CLEAR
          </button>
        </div>
      </div>

      <style>{`
        body { margin: 0; font-family: 'Inter', sans-serif; background: transparent; color: white; user-select: none; overflow: hidden; }
        .cute-frame { height: 100vh; background: rgba(15, 15, 20, 0.85); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
        .drag-handle { -webkit-app-region: drag; }
        .close-btn { -webkit-app-region: no-drag; background: transparent; border: none; color: white; cursor: pointer; opacity: 0.5; transition: 0.2s; display: flex; align-items: center; justify-content: center; padding: 4px; }
        .close-btn:hover { opacity: 1; background: rgba(255,0,0,0.5); border-radius: 4px; }
        .cute-header { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; font-size: 9px; font-weight: 700; background: rgba(255,255,255,0.03); border-bottom: 1px solid rgba(255,255,255,0.05); }

        .mid-row { display: flex; gap: 10px; padding: 10px 12px; align-items: center; }
        .cute-mic { -webkit-app-region: no-drag; width: 36px; height: 36px; min-width: 36px; border-radius: 100%; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: #818cf8; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: 0.2s; position: relative; }
        .cute-mic:hover { background: rgba(255,255,255,0.1); }
        .cute-mic:disabled { opacity: 0.5; cursor: not-allowed; }
        .cute-mic.active { background: #818cf8; color: white; box-shadow: 0 0 15px rgba(129, 140, 248, 0.4); border: none; }

        .mic-settings { -webkit-app-region: no-drag; flex: 1; display: flex; flex-direction: column; gap: 6px; overflow: hidden; min-width: 0; }
        .mic-select { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: white; font-size: 9px; padding: 4px 6px; border-radius: 6px; outline: none; -webkit-appearance: none; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: 0.2s; }
        .mic-select:hover { background: rgba(255,255,255,0.1); }
        .mic-select:disabled { opacity: 0.5; cursor: not-allowed; }

        .viz-container { height: 14px; display: flex; align-items: center; overflow: hidden; border-radius: 4px; }
        .viz-box { display: flex; gap: 2px; align-items: center; width: 100%; height: 100%; }
        .viz-bin { width: 3px; border-radius: 2px; background: rgba(255,255,255,0.15); }
        .active-bin { background: #818cf8; box-shadow: 0 0 4px #818cf8; }

        .cute-text-box { padding: 0 12px 10px 12px; font-size: 11px; flex: 1; overflow-y: auto; color: rgba(255,255,255,0.9); display: flex; flex-direction: column; gap: 6px; line-height: 1.5; }
        .actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: auto; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.1); }
        .mini-btn { -webkit-app-region: no-drag; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.05); color: rgba(255,255,255,0.7); padding: 4px 8px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 4px; font-size: 8px; font-weight: 700; transition: 0.2s; letter-spacing: 0.5px; }
        .mini-btn:hover { background: rgba(255,255,255,0.1); color: white; }

        .cursor { display: inline-block; width: 4px; height: 12px; background: #6366f1; vertical-align: middle; margin-left: 4px; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
      `}</style>
    </div>
  );
};

export default TranscriptionApp;
