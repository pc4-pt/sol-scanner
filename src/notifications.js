// ─── notifications.js ─────────────────────────────────────────────────────────
// Browser push notifications + sound alerts + optional Telegram integration.
// All channels are independent and configured separately in settings.

// ── Browser push permission ─────────────────────────────────────────────────
// Must be requested in response to a user gesture (click) — can't be silent.
export async function requestBrowserPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied")  return "denied";
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch (err) {
    console.warn("[notifications] permission request failed:", err.message);
    return "denied";
  }
}

export function browserPermissionStatus() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

// ── Browser push ────────────────────────────────────────────────────────────
export function sendBrowserNotification({ title, body, tag, icon }) {
  if (!("Notification" in window)) return false;
  if (Notification.permission !== "granted") return false;
  try {
    const n = new Notification(title, {
      body,
      tag,                       // tag dedupes — same tag replaces previous
      icon: icon || "/favicon.ico",
      silent: false,             // browser sound also plays if available
      requireInteraction: false, // auto-dismiss
    });
    // Auto-dismiss after 8s for transient notifications
    setTimeout(() => { try { n.close(); } catch {} }, 8000);
    // Click focuses the tab
    n.onclick = () => {
      try { window.focus(); n.close(); } catch {}
    };
    return true;
  } catch (err) {
    console.warn("[notifications] browser notify failed:", err.message);
    return false;
  }
}

// ── Sound alerts (WebAudio, no external assets) ─────────────────────────────
let audioContext = null;
function getAudio() {
  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return null; }
  }
  return audioContext;
}

// Play a short two-note chime. Different "kind" values play different tones
// so you can distinguish events by ear without looking at the screen.
const TONES = {
  queue:   [{ freq: 880, dur: 0.12 }, { freq: 1320, dur: 0.18 }],     // up-chirp
  fill:    [{ freq: 660, dur: 0.10 }, { freq: 880,  dur: 0.10 }, { freq: 1100, dur: 0.20 }], // triumphant
  exit:    [{ freq: 700, dur: 0.12 }, { freq: 500,  dur: 0.20 }],     // down-chirp
  error:   [{ freq: 220, dur: 0.10 }, { freq: 220,  dur: 0.10 }, { freq: 220, dur: 0.15 }], // alarm
};

export function playSound(kind) {
  const ctx = getAudio();
  if (!ctx) return;
  // Resume if suspended (browser autoplay rules)
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  const notes = TONES[kind] || TONES.queue;
  let t = ctx.currentTime;
  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = note.freq;
    osc.type = "sine";
    // Quick attack, gentle decay — avoids click artefacts
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + note.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + note.dur);
    t += note.dur;
  }
}

// ── Telegram integration ────────────────────────────────────────────────────
// Uses Telegram's public Bot API. The user creates their own bot via @BotFather,
// pastes the token + their chat ID into settings, and we POST to the API.
// No secrets on our backend — token + chat ID stay in the user's localStorage.
export async function sendTelegram({ botToken, chatId, message }) {
  if (!botToken || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        chat_id:    chatId,
        text:       message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch (err) {
    console.warn("[notifications] telegram send failed:", err.message);
    return false;
  }
}

// ── Helper to look up a user's Telegram chat ID ─────────────────────────────
// User sends /start (or any message) to their bot, then we call getUpdates to
// find the chat ID. Used by the settings UI's "Get my chat ID" button.
export async function fetchTelegramChatId(botToken) {
  if (!botToken) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result) || !data.result.length) return null;
    // Get the most recent message's chat ID
    const latest = data.result[data.result.length - 1];
    return latest?.message?.chat?.id || latest?.channel_post?.chat?.id || null;
  } catch (err) {
    console.warn("[notifications] telegram chat ID lookup failed:", err.message);
    return null;
  }
}

// ── Top-level dispatch ──────────────────────────────────────────────────────
// One call routes to all enabled channels based on settings.
// kind = "queue" | "fill" | "exit" | "error"
export async function fireNotification({ kind, title, body, settings }) {
  if (!settings) return;

  // Per-event opt-in
  const eventEnabled = {
    queue: settings.notifyOnQueue,
    fill:  settings.notifyOnFill,
    exit:  settings.notifyOnExit,
    error: settings.notifyOnError,
  }[kind];
  if (!eventEnabled) return;

  // Browser push
  if (settings.notifyBrowser) {
    sendBrowserNotification({ title, body, tag: kind });
  }

  // Sound
  if (settings.notifySound) {
    playSound(kind);
  }

  // Telegram
  if (settings.notifyTelegram && settings.telegramBotToken && settings.telegramChatId) {
    const tgMessage = `*${title}*\n${body}`;
    sendTelegram({
      botToken: settings.telegramBotToken,
      chatId:   settings.telegramChatId,
      message:  tgMessage,
    });
  }
}
