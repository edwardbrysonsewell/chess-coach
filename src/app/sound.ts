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
 * Haptics are deliberately absent. See PLAN.md - the mechanisms Safari offers
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

export interface SoundSettings {
  enabled: boolean;
  /** 0 to 1. Scales everything; 0.7 is a sensible default. */
  intensity: number;
}

interface Knock {
  /** Body frequency in Hz. */
  freq: number;
  /** Body decay in seconds. */
  decay: number;
  /** Noise-burst centre frequency in Hz. */
  noiseHz: number;
  /** Noise burst length in seconds. */
  noiseDecay: number;
  /** Relative level, 0 to 1. */
  level: number;
}

const WOOD_LIFT: Knock = { freq: 300, decay: 0.09, noiseHz: 2400, noiseDecay: 0.02, level: 0.5 };
const WOOD_PLACE: Knock = { freq: 196, decay: 0.14, noiseHz: 1500, noiseDecay: 0.03, level: 0.9 };
const WOOD_HARD: Knock = { freq: 150, decay: 0.2, noiseHz: 1100, noiseDecay: 0.045, level: 1 };

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private settings: SoundSettings;

  constructor(settings: SoundSettings = { enabled: true, intensity: 0.7 }) {
    this.settings = settings;
  }

  update(settings: SoundSettings): void {
    this.settings = settings;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Create the audio context. Must be called from inside a user gesture, or iOS
   * leaves it suspended; calling it again later is harmless.
   */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  /** True once audio can actually be heard. */
  ready(): boolean {
    return this.ctx?.state === 'running';
  }

  play(cue: Cue): void {
    if (!this.settings.enabled) return;
    const ctx = this.ensureContext();
    if (ctx.state !== 'running') return; // not unlocked yet; stay silent rather than queue
    const t = ctx.currentTime;

    switch (cue) {
      case 'lift':
        this.knock(WOOD_LIFT, t);
        break;
      case 'place':
        this.knock(WOOD_PLACE, t);
        break;
      case 'capture':
        // Two beats: the captured piece coming off, then the capturer landing.
        this.knock({ ...WOOD_LIFT, level: 0.55, freq: 260 }, t);
        this.knock(WOOD_HARD, t + 0.075);
        break;
      case 'check':
        // Two tense pulses a minor third apart, over a dry knock.
        this.knock({ ...WOOD_PLACE, level: 0.5 }, t);
        this.tone(740, 0.1, t + 0.01, 0.28, 'triangle');
        this.tone(880, 0.13, t + 0.13, 0.3, 'triangle');
        break;
      case 'illegal':
        // A dead, damped thud. No buzzer, no beep.
        this.tone(96, 0.16, t, 0.4, 'sine', 0.5);
        this.burst(320, 0.06, t, 0.25);
        break;
      case 'promotion':
        // Three rising knocks: something has become more than it was.
        this.knock({ ...WOOD_PLACE, freq: 196, level: 0.6 }, t);
        this.knock({ ...WOOD_PLACE, freq: 262, level: 0.7 }, t + 0.09);
        this.knock({ ...WOOD_PLACE, freq: 330, level: 0.85 }, t + 0.18);
        this.tone(523, 0.28, t + 0.2, 0.16, 'triangle');
        break;
      case 'checkmate':
        // A composed close: firm knock, then a settling low fifth.
        this.knock(WOOD_HARD, t);
        this.tone(147, 0.5, t + 0.04, 0.24, 'sine');
        this.tone(220, 0.45, t + 0.1, 0.18, 'triangle');
        this.tone(110, 0.7, t + 0.18, 0.2, 'sine');
        break;
      case 'draw':
        // Two level tones, going nowhere in particular.
        this.tone(330, 0.3, t, 0.18, 'sine');
        this.tone(311, 0.42, t + 0.16, 0.18, 'sine');
        break;
      case 'danger':
        // A soft double tick with a rub in it, so it reads as "wait".
        this.burst(900, 0.035, t, 0.16);
        this.tone(415, 0.12, t, 0.14, 'triangle');
        this.tone(392, 0.18, t + 0.1, 0.14, 'triangle');
        break;
      case 'takeback':
        // The place knock, reversed in feel: quieter, falling.
        this.knock({ ...WOOD_PLACE, freq: 262, level: 0.5 }, t);
        this.knock({ ...WOOD_LIFT, freq: 196, level: 0.4 }, t + 0.07);
        break;
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

  /** A wooden knock: noise attack plus inharmonic damped body. */
  private knock(k: Knock, at: number): void {
    this.burst(k.noiseHz, k.noiseDecay, at, 0.5 * k.level);
    // Inharmonic ratios: a struck block, not a tuned string.
    this.tone(k.freq, k.decay, at, 0.45 * k.level, 'sine');
    this.tone(k.freq * 1.74, k.decay * 0.6, at, 0.18 * k.level, 'sine');
    this.tone(k.freq * 2.83, k.decay * 0.35, at, 0.1 * k.level, 'sine');
  }

  /** Band-passed noise burst — the click of contact. */
  private burst(centreHz: number, decay: number, at: number, gain: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;

    const src = ctx.createBufferSource();
    src.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = centreHz;
    band.Q.value = 1.4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + decay);

    src.connect(band).connect(env).connect(master);
    src.start(at);
    src.stop(at + decay + 0.02);
  }

  /** A damped partial. `curve` below 1 makes the decay snappier. */
  private tone(
    freq: number,
    decay: number,
    at: number,
    gain: number,
    type: OscillatorType = 'sine',
    curve = 1
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + decay * curve);

    osc.connect(env).connect(master);
    osc.start(at);
    osc.stop(at + decay * curve + 0.02);
  }
}

function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
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

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
