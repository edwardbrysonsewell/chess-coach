/**
 * The feedback vocabulary, synthesised.
 *
 * Everything here is generated with WebAudio at runtime — no sample files, so
 * nothing to fetch and nothing to precache. The target is a dry wooden knock,
 * the sound of a piece on a board, not a UI plink. Each cue is built from two
 * layers:
 *
 *   - a short burst of band-passed noise for the attack, which is what makes a
 *     knock read as wood rather than as a beep;
 *   - two or three damped sine partials at inharmonic ratios for the body,
 *     because a struck wooden object does not ring at neat harmonics.
 *
 * On iOS, WebAudio output follows the ring/silent switch, which is the required
 * behaviour: flick the switch and the app goes quiet.
 *
 * The scheduling is a free function taking any BaseAudioContext, so the cues can
 * be rendered into an OfflineAudioContext and measured. "The move sound is
 * silent" is a bug that is invisible to every other kind of test.
 *
 * Haptics are deliberately absent. See PLAN.md — the mechanisms Safari offers
 * cannot fire on the bot's reply or on check, so sound and motion carry the
 * whole load.
 */

export type Cue =
  | 'lift'
  | 'place'
  | 'capture'
  | 'check'
  | 'illegal'
  | 'promotion'
  | 'checkmate'
  | 'draw'
  | 'danger'
  | 'takeback';

export const ALL_CUES: readonly Cue[] = [
  'lift',
  'place',
  'capture',
  'check',
  'illegal',
  'promotion',
  'checkmate',
  'draw',
  'danger',
  'takeback',
];

export interface SoundSettings {
  enabled: boolean;
  /** 0 to 1. Scales everything; 0.7 is a sensible default. */
  intensity: number;
}

interface Knock {
  freq: number;
  decay: number;
  noiseHz: number;
  noiseDecay: number;
  level: number;
}

const WOOD_LIFT: Knock = { freq: 300, decay: 0.09, noiseHz: 2400, noiseDecay: 0.02, level: 0.6 };
const WOOD_PLACE: Knock = { freq: 196, decay: 0.14, noiseHz: 1500, noiseDecay: 0.03, level: 1 };
const WOOD_HARD: Knock = { freq: 150, decay: 0.2, noiseHz: 1100, noiseDecay: 0.05, level: 1 };

/** Longest a cue can last, so an offline render knows how much to allocate. */
export const MAX_CUE_SECONDS = 1.2;

export function makeNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 0.25);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Slightly darkened noise: a one-pole low-pass over white noise reads as
  // wood, where raw white noise reads as static.
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = 0.65 * last + 0.35 * white;
    data[i] = last;
  }
  return buffer;
}

/**
 * Schedule one cue onto `destination`, starting at `at`. Pure scheduling: works
 * on a live AudioContext or an OfflineAudioContext.
 */
export function scheduleCue(
  ctx: BaseAudioContext,
  destination: AudioNode,
  cue: Cue,
  at: number,
  noise: AudioBuffer
): void {
  const burst = (centreHz: number, decay: number, start: number, gain: number): void => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = centreHz;
    band.Q.value = 1.4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, start);
    env.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    src.connect(band).connect(env).connect(destination);
    src.start(start);
    src.stop(start + decay + 0.02);
  };

  const tone = (
    freq: number,
    decay: number,
    start: number,
    gain: number,
    type: OscillatorType = 'sine',
    curve = 1
  ): void => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain, start + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, start + decay * curve);
    osc.connect(env).connect(destination);
    osc.start(start);
    osc.stop(start + decay * curve + 0.02);
  };

  const knock = (k: Knock, start: number): void => {
    burst(k.noiseHz, k.noiseDecay, start, 0.55 * k.level);
    tone(k.freq, k.decay, start, 0.5 * k.level, 'sine');
    tone(k.freq * 1.74, k.decay * 0.6, start, 0.2 * k.level, 'sine');
    tone(k.freq * 2.83, k.decay * 0.35, start, 0.11 * k.level, 'sine');
  };

  switch (cue) {
    case 'lift':
      knock(WOOD_LIFT, at);
      break;
    case 'place':
      knock(WOOD_PLACE, at);
      break;
    case 'capture':
      // Two beats: the captured piece coming off, then the capturer landing.
      knock({ ...WOOD_LIFT, level: 0.6, freq: 260 }, at);
      knock(WOOD_HARD, at + 0.075);
      break;
    case 'check':
      knock({ ...WOOD_PLACE, level: 0.55 }, at);
      tone(740, 0.1, at + 0.01, 0.3, 'triangle');
      tone(880, 0.13, at + 0.13, 0.32, 'triangle');
      break;
    case 'illegal':
      // A dead, damped thud. No buzzer, no beep.
      tone(96, 0.16, at, 0.42, 'sine', 0.5);
      burst(320, 0.06, at, 0.28);
      break;
    case 'promotion':
      knock({ ...WOOD_PLACE, freq: 196, level: 0.65 }, at);
      knock({ ...WOOD_PLACE, freq: 262, level: 0.75 }, at + 0.09);
      knock({ ...WOOD_PLACE, freq: 330, level: 0.9 }, at + 0.18);
      tone(523, 0.28, at + 0.2, 0.18, 'triangle');
      break;
    case 'checkmate':
      knock(WOOD_HARD, at);
      tone(147, 0.5, at + 0.04, 0.26, 'sine');
      tone(220, 0.45, at + 0.1, 0.2, 'triangle');
      tone(110, 0.7, at + 0.18, 0.22, 'sine');
      break;
    case 'draw':
      tone(330, 0.3, at, 0.2, 'sine');
      tone(311, 0.42, at + 0.16, 0.2, 'sine');
      break;
    case 'danger':
      burst(900, 0.035, at, 0.18);
      tone(415, 0.12, at, 0.16, 'triangle');
      tone(392, 0.18, at + 0.1, 0.16, 'triangle');
      break;
    case 'takeback':
      knock({ ...WOOD_PLACE, freq: 262, level: 0.55 }, at);
      knock({ ...WOOD_LIFT, freq: 196, level: 0.45 }, at + 0.07);
      break;
  }
}

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private settings: SoundSettings;

  constructor(settings: SoundSettings = { enabled: true, intensity: 0.7 }) {
    this.settings = settings;
    // iOS suspends or "interrupts" an AudioContext when the app is backgrounded,
    // a call arrives, or the screen locks, and it does not always come back on
    // its own. Without this, sound works until the first interruption and then
    // dies silently for the rest of the session.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.resume();
      });
    }
  }

  update(settings: SoundSettings): void {
    this.settings = settings;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Create and resume the audio context. Must be called from inside a user
   * gesture the first time, or iOS leaves it suspended.
   */
  async unlock(): Promise<void> {
    this.ensureContext();
    await this.resume();
  }

  /** Current state, for the UI to tell the user when sound is not armed. */
  state(): 'unarmed' | 'suspended' | 'running' | 'disabled' {
    if (!this.settings.enabled) return 'disabled';
    if (!this.ctx) return 'unarmed';
    return this.ctx.state === 'running' ? 'running' : 'suspended';
  }

  ready(): boolean {
    return this.ctx?.state === 'running';
  }

  play(cue: Cue): void {
    if (!this.settings.enabled) return;
    const ctx = this.ensureContext();
    const master = this.master;
    const noise = this.noise;
    if (!master || !noise) return;

    // Schedule regardless of state, and kick a resume alongside it. Previously
    // this bailed out whenever the context was not already running, which made
    // the very first move of every session silent — the tap that unlocks audio
    // is the same tap that plays the cue.
    if (ctx.state !== 'running') void this.resume();
    scheduleCue(ctx, master, cue, ctx.currentTime + 0.005, noise);
  }

  private async resume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running') return;
    try {
      await ctx.resume();
    } catch {
      // Not in a gesture yet; the next tap will get it.
    }
  }

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.level();
    master.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    this.noise = makeNoiseBuffer(ctx);
    return ctx;
  }

  private level(): number {
    return this.settings.enabled ? 0.9 * clamp01(this.settings.intensity) : 0;
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
