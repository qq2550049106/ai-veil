// 声音反馈：优先播放 sound.custom_path 指定的音频，失败则用 Web Audio 合成短音。
// AudioContext 懒创建；被浏览器自动播放策略拦截或没有音频设备时降级为静默，不抛异常。
// 每类音效按 sound.throttle_ms 节流，避免事件风暴时连续爆音。

const DEFAULT_THROTTLE_MS = 800;
const ATTACK_SEC = 0.005;
const FLOOR_GAIN = 0.0001;

let audioContext = null;
let audioContextFailed = false;
const lastPlay = new Map();

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.6;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function errorText(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  try {
    return String(error);
  } catch (nested) {
    return "未知错误";
  }
}

/** 是否具备 Web Audio 能力（不代表一定能发声，只代表 API 存在） */
export function isSupported() {
  return typeof window !== "undefined" && Boolean(window.AudioContext || window.webkitAudioContext);
}

/** 懒创建 AudioContext；创建失败后记住失败状态，不再反复尝试 */
function getContext() {
  if (audioContext) return audioContext;
  if (audioContextFailed) return null;
  if (!isSupported()) {
    audioContextFailed = true;
    console.warn("[AI-Veil] 当前环境不支持 Web Audio，声音反馈已禁用");
    return null;
  }
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioContext = new Ctor();
  } catch (error) {
    audioContext = null;
    audioContextFailed = true;
    console.warn("[AI-Veil] 音频上下文创建失败，声音反馈已禁用：", errorText(error));
  }
  return audioContext;
}

/** 首次用户手势时调用：把 suspended 的上下文唤醒 */
export function unlockAudio() {
  const context = getContext();
  if (!context) return false;
  try {
    if (context.state === "suspended") {
      const pending = context.resume();
      if (pending && typeof pending.catch === "function") {
        pending.catch((error) => console.warn("[AI-Veil] 音频上下文唤醒失败：", errorText(error)));
      }
    }
    return true;
  } catch (error) {
    console.warn("[AI-Veil] 音频上下文唤醒异常：", errorText(error));
    return false;
  }
}

/** 确保上下文处于 running；被策略拦住时返回 false */
async function ensureRunning(context) {
  try {
    if (context.state === "running") return true;
    if (context.state !== "suspended") {
      console.warn(`[AI-Veil] 音频上下文不可用（state=${String(context.state)}）`);
      return false;
    }
    const pending = context.resume();
    if (pending && typeof pending.then === "function") {
      await Promise.race([
        pending.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 300))
      ]);
    }
    if (context.state !== "running") {
      console.warn("音频上下文被拦截：需要用户手势后才能播放合成音");
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[AI-Veil] 音频上下文不可用：", errorText(error));
    return false;
  }
}

/**
 * 解析合成参数。
 * error 复用 alert 的波形与时长，但音高 ×1.5、音量 ×0.9。
 */
function synthParams(kind, synthConfig) {
  const synth = synthConfig || {};
  if (kind === "start") {
    return {
      wave: String(synth.start_wave || "sine"),
      freq: Math.max(20, num(synth.start_freq, 660)),
      dur: Math.min(3, Math.max(0.03, num(synth.start_dur, 0.12))),
      gain: 1
    };
  }
  if (kind === "end") {
    return {
      wave: String(synth.end_wave || "sine"),
      freq: Math.max(20, num(synth.end_freq, 440)),
      dur: Math.min(3, Math.max(0.03, num(synth.end_dur, 0.18))),
      gain: 1
    };
  }
  const base = {
    wave: String(synth.alert_wave || "square"),
    freq: Math.max(20, num(synth.alert_freq, 880)),
    dur: Math.min(3, Math.max(0.03, num(synth.alert_dur, 0.25))),
    gain: 1
  };
  if (kind === "error") {
    base.freq = Math.min(12000, base.freq * 1.5);
    base.gain = 0.9;
  }
  return base;
}

/** 用 Oscillator + Gain 播一个带指数包络的短音 */
async function playSynth(params, volume) {
  const context = getContext();
  if (!context) return false;
  const running = await ensureRunning(context);
  if (!running) return false;

  try {
    const peak = Math.min(1, Math.max(FLOOR_GAIN, clamp01(volume) * params.gain));
    const startAt = context.currentTime + 0.005;
    const endAt = startAt + params.dur;

    const oscillator = context.createOscillator();
    const gainNode = context.createGain();

    oscillator.type = params.wave;
    oscillator.frequency.setValueAtTime(params.freq, startAt);

    // 指数包络：0.005s 起音到峰值，再指数衰减到近乎静音，避免爆音
    gainNode.gain.setValueAtTime(FLOOR_GAIN, startAt);
    gainNode.gain.exponentialRampToValueAtTime(peak, startAt + ATTACK_SEC);
    gainNode.gain.exponentialRampToValueAtTime(FLOOR_GAIN, endAt);

    oscillator.connect(gainNode);
    gainNode.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(endAt + 0.02);

    oscillator.onended = () => {
      try {
        oscillator.disconnect();
        gainNode.disconnect();
      } catch (error) {
        // 节点已回收时忽略
      }
    };
    return true;
  } catch (error) {
    console.warn("[AI-Veil] 合成音播放失败：", errorText(error));
    return false;
  }
}

/** 播放自定义音频文件；任何失败都返回 false 交给合成音兜底 */
async function playCustom(path, sound, assets) {
  try {
    const loader = assets && typeof assets.imageUrl === "function" ? assets.imageUrl : null;
    if (!loader) return false;
    const url = await loader(path);
    if (!url) return false;
    const audio = new Audio(String(url));
    audio.volume = clamp01(num(sound.volume, 0.6));
    await audio.play();
    return true;
  } catch (error) {
    console.warn("[AI-Veil] 自定义音效播放失败，降级为合成音：", errorText(error));
    return false;
  }
}

/**
 * 播放一次反馈音。
 * @param {"start"|"end"|"alert"|"error"} kind
 * @param {object} soundConfig  Config.sound
 * @param {{svg?: Function, imageUrl?: Function}} assets
 * @returns {Promise<boolean>} 是否真的发出了声音
 */
export async function playFeedback(kind, soundConfig, assets) {
  try {
    const sound = soundConfig || {};
    // 总开关关闭：完全静默，连 AudioContext 都不创建
    if (sound.enabled === false) return false;

    const name = String(kind || "");
    if (["start", "end", "alert", "error"].indexOf(name) < 0) return false;

    // 节流：同一类音效在 throttle_ms 内只响一次（先占位，失败也不重试，避免刷屏）
    const throttle = Math.max(0, num(sound.throttle_ms, DEFAULT_THROTTLE_MS));
    const now = Date.now();
    const last = lastPlay.get(name) || 0;
    if (throttle > 0 && now - last < throttle) return false;
    lastPlay.set(name, now);

    const customPath = typeof sound.custom_path === "string" ? sound.custom_path.trim() : "";
    if (customPath) {
      const played = await playCustom(customPath, sound, assets);
      if (played) return true;
    }

    return await playSynth(synthParams(name, sound.synth), num(sound.volume, 0.6));
  } catch (error) {
    console.warn("[AI-Veil] 声音反馈异常：", errorText(error));
    return false;
  }
}
