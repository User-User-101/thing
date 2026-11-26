// Groq-powered panel sender + simulated OS (v1.4) with a separate POST-only keyboard,
// a persistent simulated filesystem, a file manager and a much bigger terminal.
//
// DISPLAY TRANSMITTER (the only transmitter that receives display output):
//   URL:    https://YOUR-TUNNEL-URL/out
//   Method: GET or POST
//   Header: {"pass":"YOUR_PANEL_PASSWORD"}
//   This transmitter alone receives {"value":"........"} display frames.
//
// FOUR AUXILIARY KEYBOARD TRANSMITTERS (POST only; no display output is returned):
//   /keys/1  pins 1-8 = A B C D E F G H
//   /keys/2  pins 1-8 = I J K L M N O P
//   /keys/3  pins 1-8 = Q R S T U V W X
//   /keys/4  pins 1-8 = Y Z ENTER SPACE BACKSPACE . - /      (NEW: SPACE, BACKSPACE, dot, dash, slash)
// Each key is an independent input pin. Send the current 8-pin state in a POST body,
// e.g. {"value":"10000000"}; arrays and bare bit strings are also accepted.
// The server reacts only to 0 -> 1 transitions, so POST all zeros when the keys are released.
// All keyboard transmitters use the SAME pass header as the display transmitter.
//
// Individual POST endpoints also exist: /key/a ... /key/z, /key/enter, /key/space,
// /key/backspace, /key/dot, /key/dash, /key/slash with {"pressed":true/false}.
//
// RECOMMENDED TOTAL: 1 display transmitter + 4 keyboard banks = 5 transmitters.
//
// FILESYSTEM: every password has its own small filesystem, saved as JSON on the computer
// that runs this script (default: panel-data.json next to the script; change it with
// PANEL_DATA=/some/path.json). Passwords are stored only as a SHA-256 hash.
//
// Setup:
//   npm install express
//   node panel-text-keyboard.js                 (Node 18+ required; uses fetch)
//   or: GROQ_API_KEY=gsk_... node panel-text-keyboard.js
//   cloudflared tunnel --url http://localhost:3000   (or ngrok http 3000)
//
// Output format: X S C5 C4 C3 C2 C1 C0; clear='10000000', idle='00000000'.

const express = require('express');
const nodeFs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

const app = express();

// ======================= ACCESS CONTROL =======================

const PASS_HEADER = 'pass';
const MAX_PASSWORD_CHARS = 200;

// Never let Express, a tunnel or the game cache /out.
app.disable('etag');
app.use((req, res, next) => {
  if (req.path === '/out') res.set('Cache-Control', 'no-store');
  next();
});

// /out reads the body as raw text whatever the Content-Type is (see readInputBits).
app.use(['/out', '/keys', '/key', '/keyboard', '/letter'], express.text({ type: () => true }));
app.use(express.json());

function givenPassword(req) {
  const v = req.headers[PASS_HEADER];
  const raw = Array.isArray(v) ? String(v[0] || '') : (v === undefined || v === null ? '' : String(v));
  return raw.trim();
}

const PORT = 3000;

// ======================= SETTINGS =======================

// Which clock circuit you have in the game (see the preset table below).
//   'pulse-fast' / 'pulse-safe' (simple circuit): code-0 gap needed between every pair
//           of characters. 'pulse-fast' = 2 polls per character, 'pulse-safe' = 4.
//   'loop'  (the original free-running clock). Frames are sent once.
//   'change' / 'change-safe': gap only needed between identical letters.
const CIRCUIT = 'pulse-fast';
const PRESETS = {
  'pulse-fast': { CHAR_FRAMES: 1, GAP: 'always', GAP_FRAMES: 1, CLEAR_WAIT: 1 },
  'pulse-safe': { CHAR_FRAMES: 3, GAP: 'always', GAP_FRAMES: 3, CLEAR_WAIT: 1 },
  change: { CHAR_FRAMES: 1, GAP: 'repeats', GAP_FRAMES: 1, CLEAR_WAIT: 1 },
  'change-safe': { CHAR_FRAMES: 2, GAP: 'repeats', GAP_FRAMES: 2, CLEAR_WAIT: 1 },
  loop: { CHAR_FRAMES: 1, GAP: 'repeats', GAP_FRAMES: 1, CLEAR_WAIT: 1 },
  turbo: { CHAR_FRAMES: 1, GAP: 'never', GAP_FRAMES: 0, CLEAR_WAIT: 0 },
};
const { CHAR_FRAMES, GAP, GAP_FRAMES } = PRESETS[CIRCUIT];

// Every text send starts with a clear frame (first bit = 1, code bits 0000000)
const CLEAR_BEFORE_TEXT = true;

// Clear frame is held this many polls, then this many code-0 polls are sent
// so the reset can finish before the first letter. Raise if you still get junk.
const CLEAR_HOLD = 1;
const CLEAR_SETTLE = 1;

// ---- Show the user's message on the panel before the reply (AI mode) ----
const SHOW_INPUT = true;

// How many characters fit on ONE row of your panel before it wraps. The OS also uses
// this as its screen width. If that is wrong: send "abcdefghijklmnop" from Manual tools,
// count the letters on the first row, and put that number here.
const CHARS_PER_ROW = 16;

// If your in-game panel has a code that moves the cursor to the next line,
// put it here (0-127) and padding is skipped. Leave null otherwise.
// A row that is exactly full is not followed by a new-line code (the panel wraps by itself).
const NEWLINE_CODE = null;

const ECHO_MAX_CHARS = 16;
const ECHO_PREFIX = '(▶';
const ECHO_SUFFIX = ')';
const ECHO_GAP = null;

function separatorCodes(usedChars) {
  if (ECHO_GAP !== null) return Array(ECHO_GAP).fill(SPACE_CODE);
  return lineBreakCodes(usedChars);
}

// Codes that move the cursor to the start of the next row
function lineBreakCodes(usedChars) {
  if (NEWLINE_CODE !== null) {
    return usedChars > 0 && CHARS_PER_ROW && usedChars % CHARS_PER_ROW === 0 ? [] : [NEWLINE_CODE & 127];
  }
  if (!CHARS_PER_ROW || usedChars === 0) return [];
  const pad = (CHARS_PER_ROW - (usedChars % CHARS_PER_ROW)) % CHARS_PER_ROW;
  return Array(pad).fill(SPACE_CODE);
}

// Code sent for a space: 63 = 0111111, which is blank in the character table
const SPACE_CODE = 63;

// Flip if the game reads the 8-bit string in the opposite direction
const REVERSE_BITS = false;

// Set true if a PRESSED button reads as 0 instead of 1 (active-low wiring).
const PINS_ACTIVE_LOW = false;

// ---- AI-mode control pins, read from the value the transmitter POSTs to /out ----
const PIN_INTERRUPT = 0;
const PIN_REDO = 1;

// true = an interrupt also clears the panel; false = the half-drawn text stays.
const INTERRUPT_CLEARS_SCREEN = false;

// Per-character overrides, as full 7-bit codes (0-127).
const CUSTOM = { 'Î': 113 };

// ======================= GROQ SETTINGS =======================

let groqKey = String(process.env.GROQ_API_KEY || '').trim();

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

// Reasoning model: uses max_completion_tokens and reasoning_effort 'low'.
const GROQ_MODEL = 'openai/gpt-oss-20b';

const REPLY_SOFT_CHARS = 48;
const REPLY_HARD_CHARS = 120;
const COMPLETION_TOKENS = 2048;   // room for hidden reasoning + the visible reply
const MAX_INPUT_CHARS = 300;      // don't forward huge prompts

const MAX_HISTORY_TURNS = 10;

// ======================= PROMPT (CUSTOMIZABLE) =======================

const DEFAULT_PERSONA =
  'You write replies for a 16x16 LED matrix panel that can only show a single line. ' +
  'You are continuing a conversation, so use earlier turns when they help. ';

const PANEL_RULES =
  'Always finish your reply: write complete words and complete sentences, never stop mid-word or mid-sentence. ' +
  'Answer the latest user message in as few characters as possible: normally 1 to 5 words ' +
  '(under 25 characters). Only go a little longer (never more than 48 characters) when the ' +
  'answer truly cannot be shorter. If the answer would be too long, shorten the wording ' +
  'instead of cutting it off. ' +
  'Reply with plain text on one line: no emojis, no markdown, no quotes, no explanations. ' +
  'Use only letters, digits, spaces and the characters . , ! ? - = / : ; ( ) + _ \' and accented letters.';

const MAX_PROMPT_CHARS = 2000;

const INITIAL_PROMPT = String(process.env.PANEL_PROMPT || '').trim().slice(0, MAX_PROMPT_CHARS) || null;

const SHORTEN_PROMPT =
  'That answer was cut off or too long. Reply again with the complete answer in under 48 characters. ' +
  'Keep complete words and complete sentences; shorten the wording instead of cutting anything off.';

// The OS "ai chat" app has a bigger screen (several rows), so it may answer a bit longer.
const OS_PERSONA =
  'You write replies for a small text screen that is 16 characters wide and a few rows tall. ' +
  'You are continuing a conversation, so use earlier turns when they help. ';

const OS_RULES =
  'Always finish your reply: write complete words and complete sentences, never stop mid-word or mid-sentence. ' +
  'Answer the latest user message briefly: one or two short sentences, never more than 100 characters. ' +
  'Reply with plain text: no emojis, no markdown, no quotes, no lists, no explanations. ' +
  'Use only letters, digits, spaces and the characters . , ! ? - = / : ; ( ) + _ \' and accented letters.';

const OS_SHORTEN_PROMPT =
  'That answer was cut off or too long. Reply again with the complete answer in under 100 characters. ' +
  'Keep complete words and complete sentences; shorten the wording instead of cutting anything off.';

// ======================= TRANSMITTERS =======================
//
// One transmitter per distinct "pass" header value.

const transmitters = new Map(); // password -> transmitter
const TRANSMITTER_IDLE_MS = 12 * 60 * 60 * 1000; // drop transmitters untouched for 12 h
// (The saved filesystem is NOT dropped with the transmitter; it lives in the data file.)

function makeTransmitter(password) {
  return {
    password,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    lastPollAt: 0,

    // ---- output ----
    queue: [],
    last: { clear: 0, code: 0 },     // the last frame sent (shown on the page)
    held: null,                      // held 8-bit string for wiring tests
    sentLog: [],                     // characters put on the pins, newest last
    prevSent: { clear: 0, code: 0 },

    // ---- input (pins) ----
    prevIn: null,
    lastIn: null,
    keyBankPrev: new Map(),       // POST-only auxiliary keyboard banks
    directKeyPrev: new Map(),     // optional one-endpoint-per-key inputs
    keyBankLastFire: new Map(),   // repeat timing for keys in each keyboard bank
    directKeyLastFire: new Map(), // repeat timing for individual-key endpoints
    lastKeyboardKey: '',
    lastKeyboardRequest: null,
    lastRaw: '',                     // what the game sent, for diagnostics
    lastAction: '',

    // ---- mode: 'ai' (Groq text sender) or 'os' (simulated OS) ----
    mode: DEFAULT_MODE,
    os: makeOS(),
    fsKey: '',

    // ---- conversation ----
    history: [],
    lastUserMessage: '',

    // ---- AI ----
    chatBusy: false,
    chatGen: 0,
    customPrompt: INITIAL_PROMPT,
    appendRules: true,

    // ---- diagnostics ----
    pollLog: [],                     // timestamps of the last 10 s of /out requests
    pollClients: new Map(),          // ip / agent -> count
    pollTotal: 0,
    outRejected: 0,
    outLastOk: null,
  };
}

function getTransmitter(password) {
  let t = transmitters.get(password);
  if (!t) {
    t = makeTransmitter(password);
    transmitters.set(password, t);
  }
  t.lastUsedAt = Date.now();
  return t;
}

function pruneTransmitters() {
  const now = Date.now();
  for (const [pass, t] of transmitters) {
    const last = Math.max(t.lastUsedAt || 0, t.lastPollAt || 0);
    if (now - last > TRANSMITTER_IDLE_MS) transmitters.delete(pass);
  }
}
const pruneTimer = setInterval(pruneTransmitters, 60 * 60 * 1000);
if (pruneTimer.unref) pruneTimer.unref();

// Every /api call must carry the pass header.
app.use('/api', (req, res, next) => {
  const password = givenPassword(req);
  if (!password) {
    return res.status(403).json({
      error: 'Send a "' + PASS_HEADER + ': your-password" header.',
      needPassword: true,
    });
  }
  if (password.length > MAX_PASSWORD_CHARS) {
    return res.status(400).json({ error: 'Password too long (max ' + MAX_PASSWORD_CHARS + ' characters).' });
  }
  req.transmitter = getTransmitter(password);
  next();
});

// ======================= CHARACTER TABLE =======================
// Index = the 7-bit code (shift is the top bit). '' = blank or unassigned.

const CHARS = [
  // 0-31
  '', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '1', '2', '3', '4', '5',
  // 32-63
  '6', '7', '8', '9', '0', '-', '=', '.', ',', ';', '/', 'à', 'â', 'ç', 'è', 'é',
  'ê', 'î', 'ï', 'û', '|', '', '', '"', '🟧', '🟨', '🟩', '🟦', '🟪', '⬜', '▶', '',
  // 64-95 (shift on)
  '', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '!', '@', '#', '$', '%',
  // 96-127 (shift on)
  '?', '&', '*', '(', ')', '_', '+', '', "'", ':', '~', 'À', 'Â', 'Ç', 'È', 'É',
  'Ê', 'Ì', 'Ï', 'Û', '¦', '', '', '^', '', '', '█', '➡', '⬅', '⬆', '⬇', '',
];

const LOOKUP = new Map();
CHARS.forEach((ch, code) => {
  if (ch !== '' && !LOOKUP.has(ch)) LOOKUP.set(ch, code);
});

function encode(ch) {
  if (ch === ' ' || ch === '\t') return SPACE_CODE;
  if (CUSTOM[ch] !== undefined) return CUSTOM[ch] & 127;
  const code = LOOKUP.get(ch);
  return code !== undefined ? code : LOOKUP.get('?'); // unknown characters become '?'
}

function glyph(code) {
  if (code === 0) return '(nothing)';
  return CHARS[code] || '(blank)';
}

// ======================= OUTPUT HELPERS =======================

function bin8(n) {
  const s = (n & 255).toString(2).padStart(8, '0');
  return REVERSE_BITS ? s.split('').reverse().join('') : s;
}
const toValue = (f) => bin8((f.clear << 7) | (f.code & 127));

const blank = () => ({ clear: 0, code: 0 });
const times = (f, count) => Array.from({ length: count }, () => ({ ...f }));

function clearFrames() {
  return [...times({ clear: 1, code: 0 }, CLEAR_HOLD), ...times(blank(), CLEAR_SETTLE)];
}

// Each character is held for CHAR_FRAMES polls, with a code-0 gap where the preset asks
// for one. Reads t.queue / t.last so a gap is inserted correctly when frames are
// appended to an already non-empty queue.
function buildFrames(t, codes) {
  const out = [];
  let prev = t.queue.length ? t.queue[t.queue.length - 1].code : t.last.code;
  for (const code of codes) {
    const needGap = prev !== 0 && (GAP === 'always' || (GAP === 'repeats' && prev === code));
    if (needGap) out.push(...times(blank(), GAP_FRAMES));
    out.push(...times({ clear: 0, code }, CHAR_FRAMES));
    prev = code;
  }
  return out;
}

// ---- Poll diagnostics ----

function notePoll(t, req) {
  const now = Date.now();
  t.pollTotal++;
  t.pollLog.push(now);
  while (t.pollLog.length && now - t.pollLog[0] > 10000) t.pollLog.shift();
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '?').split(',')[0].trim();
  const who = ip + ' / ' + String(req.headers['user-agent'] || 'no-agent').slice(0, 40);
  t.pollClients.set(who, (t.pollClients.get(who) || 0) + 1);
  if (t.pollClients.size > 20) t.pollClients.delete(t.pollClients.keys().next().value);
}

function pollStats(t) {
  const now = Date.now();
  while (t.pollLog.length && now - t.pollLog[0] > 10000) t.pollLog.shift();
  let maxGap = 0;
  for (let i = 1; i < t.pollLog.length; i++) maxGap = Math.max(maxGap, t.pollLog[i] - t.pollLog[i - 1]);
  return {
    perSec: t.pollLog.filter((ts) => now - ts <= 1000).length,
    maxGapMs: maxGap,
    agoMs: t.pollLog.length ? now - t.pollLog[t.pollLog.length - 1] : null,
    total: t.pollTotal,
    clients: Array.from(t.pollClients.entries()).map(([k, v]) => v + 'x ' + k),
  };
}

// ---- Sent log: the characters the server actually put on the pins, newest last ----
function noteSent(t, frame) {
  if (frame.clear && !t.prevSent.clear) {
    t.sentLog.push('[CLR]');
  } else if (!frame.clear && frame.code !== 0 && frame.code !== t.prevSent.code) {
    t.sentLog.push(frame.code === SPACE_CODE ? '·' : (CHARS[frame.code] || '<' + frame.code + '>'));
  }
  while (t.sentLog.length > 80) t.sentLog.shift();
  t.prevSent = frame;
}

// ---- Input pins ----

// Read a keyboard pin snapshot from Build Logic's different possible POST formats.
// Accepted examples: {"value":"10000000"}, bare 10000000, value=10000000,
// [1,0,0,0,0,0,0,0], {"pin1":1,...}, and JSON numeric bitmasks 0..255.
function readInputBits(req) {
  let value;
  const raw = req.body;
  const pick = (obj) => {
    if (!obj || typeof obj !== 'object') return undefined;
    if (Array.isArray(obj)) return obj;
    const direct = obj.value ?? obj.bits ?? obj.input ?? obj.pins ?? obj.state ?? obj.outputs;
    if (direct !== undefined) return direct;
    const pinKeys = ['pin1','pin2','pin3','pin4','pin5','pin6','pin7','pin8'];
    if (pinKeys.some(k => obj[k] !== undefined)) return pinKeys.map(k => obj[k] ?? 0);
    const numericKeys = ['1','2','3','4','5','6','7','8'];
    if (numericKeys.some(k => obj[k] !== undefined)) return numericKeys.map(k => obj[k] ?? 0);
    return undefined;
  };

  if (raw && typeof raw === 'object') {
    value = pick(raw);
  } else if (typeof raw === 'string' && raw.trim()) {
    const body = raw.trim();
    try {
      const parsed = JSON.parse(body);
      value = (parsed && typeof parsed === 'object') ? pick(parsed) : parsed;
    } catch (_) {
      // Form body, comma/space-separated pins, or a literal bit string.
      try {
        const params = new URLSearchParams(body);
        value = params.get('value') ?? params.get('bits') ?? params.get('input') ?? params.get('pins') ?? params.get('state');
      } catch (_) {}
      if (value === undefined || value === null) {
        const named = body.match(/(?:value|bits|input|pins|state)\s*[:=]\s*[\"']?([01]{1,8})/i);
        if (named) value = named[1];
        else if (/^[01]{1,8}$/.test(body)) value = body;
        else if (/^[01](?:[\s,;]+[01]){1,7}$/.test(body)) value = body.split(/[\s,;]+/);
        else {
          const embedded = body.match(/(?:^|[^0-9])([01]{8})(?:$|[^0-9])/);
          if (embedded) value = embedded[1];
        }
      }
    }
  }

  if (value === undefined || value === null) {
    value = req.query.value ?? req.query.bits ?? req.query.input ?? req.query.pins ?? req.query.state;
  }
  if (value === undefined || value === null) return null;

  let bits;
  if (Array.isArray(value)) {
    if (value.length < 1 || value.length > 8) return null;
    const pinValues = value.map(v => {
      if (v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'on') return '1';
      if (v === false || v === 0 || v === '0' || v === null || v === undefined || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'off') return '0';
      return '?';
    });
    if (pinValues.includes('?')) return null;
    bits = pinValues.join('').padEnd(8, '0');
  } else if (typeof value === 'object' && value !== null) {
    return null;
  } else if (typeof value === 'boolean') {
    bits = (value ? '1' : '0') + '0000000';
  } else if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 255) {
    bits = value.toString(2).padStart(8, '0');
  } else {
    const str = String(value).trim();
    if (/^[01]{1,8}$/.test(str)) bits = str.padEnd(8, '0');
    else if (/^[01](?:[\s,;]+[01]){1,7}$/.test(str)) bits = str.split(/[\s,;]+/).join('').padEnd(8, '0');
    else if (/^(?:0|[1-9]\d{0,2})$/.test(str) && Number(str) <= 255) bits = Number(str).toString(2).padStart(8, '0');
    else return null;
  }

  if (PINS_ACTIVE_LOW) bits = bits.replace(/[01]/g, b => b === '0' ? '1' : '0');
  return REVERSE_BITS ? bits.split('').reverse().join('') : bits;
}

function noteAction(t, text) {
  t.lastAction = new Date().toLocaleTimeString() + ' ' + text;
}

// INTERRUPT: stop whatever is being drawn and forget any answer still being written.
function interruptResponse(t) {
  abandonChat(t);      // a Groq call still in flight is discarded when it returns
  t.queue = [];
  if (INTERRUPT_CLEARS_SCREEN) t.queue.push(...clearFrames());
  noteAction(t, 'INTERRUPT');
}

// REDO: ask the AI again about the last message and draw the new answer.
function redoResponse(t) {
  if (!groqKey) return noteAction(t, 'REDO ignored (no key)');
  if (!t.lastUserMessage) return noteAction(t, 'REDO ignored (nothing to redo)');
  if (t.chatBusy) return noteAction(t, 'REDO ignored (still working)');
  t.queue = []; // stop drawing the old answer right away
  noteAction(t, 'REDO');
  runChat(t, t.lastUserMessage, true).catch((e) => {
    noteAction(t, 'REDO failed: ' + e.message);
    console.error('Redo failed:', e.message);
  });
}

// AI and OS controls use rising edges. OS mode can optionally use the power pin's
// falling edge for a latching power switch; ordinary button releases are ignored.
function handleControlPins(t, bits) {
  t.lastIn = bits;
  let osActionHandled = false;
  if (t.mode === 'os') {
    osActionHandled = osPins(t, bits); // OS edge detection handles its own baseline
  } else if (t.prevIn !== null) {
    const rose = (i) => bits[i] === '1' && t.prevIn[i] === '0';
    if (rose(PIN_INTERRUPT)) interruptResponse(t);
    if (rose(PIN_REDO)) redoResponse(t);
  }
  // AI mode: the first POST only sets the baseline, so a pin that is already high at
  // start does nothing. (OS mode already handled the first POST inside osPins.)
  t.prevIn = bits;
  return osActionHandled;
}

// The game calls this. The pass header chooses the transmitter. Pins can come from a
// POST body or from ?value= on a GET; either way they are handled first.
function outHandler(req, res) {
  const password = givenPassword(req);
  if (!password) {
    return res.status(403).json({ error: 'Send a "' + PASS_HEADER + ': your-password" header.' });
  }
  if (password.length > MAX_PASSWORD_CHARS) {
    return res.status(400).json({ error: 'Password too long (max ' + MAX_PASSWORD_CHARS + ' characters).' });
  }
  const t = getTransmitter(password);
  t.outLastOk = Date.now();
  t.lastPollAt = Date.now();
  notePoll(t, req);

  // Remember what the game sent, for the diagnostics on the page.
  let rawSent = '';
  if (typeof req.body === 'string') rawSent = req.body;
  else if (req.body && typeof req.body === 'object') rawSent = JSON.stringify(req.body);
  if (!rawSent && req.query.value !== undefined) rawSent = '?value=' + String(req.query.value);
  t.lastRaw = rawSent;

  // Read the current transmitter input snapshot.
  const bits = readInputBits(req);
  let osButtonHandled = false;

  if (bits !== null) {
    osButtonHandled = handleControlPins(t, bits);
  } else {
    // A poll with no input payload is the transmitter's released/idle state.
    // Reset only the edge-detection baseline: do NOT call osKey and do NOT
    // interpret this as a falling-edge press.
    t.prevIn = '00000000';
    t.lastIn = '00000000';
  }

  if (t.held !== null) return res.json({ value: t.held });

  // A transmitter POST both delivers the button state and receives the next display
  // frame. Do not send the clear pulse in that same response: return one idle frame for
  // the input poll, leaving the clear + redraw sequence at the front of the queue for
  // the NEXT poll.
  if (osButtonHandled) {
    const frame = blank();
    t.last = frame;
    noteSent(t, frame);
    return res.json({ value: toValue(frame) });
  }

  const frame = t.queue.length ? t.queue.shift() : blank(); // empty: always 00000000
  t.last = frame;
  noteSent(t, frame);
  res.json({ value: toValue(frame) });
}

app.route('/out').get(outHandler).post(outHandler);

// ======================= GROQ HELPERS =======================

function requireKey(res) {
  if (groqKey) return true;
  res.status(409).json({ error: 'No Groq API key set yet. Paste your gsk_... key on the page first.' });
  return false;
}

// Only what the panel can safely draw (no # * | ~ ^ blocks or arrows)
const REPLY_ALLOWED = new Set(Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-=/:;()+_'\"àâçèéêîïûÀÂÇÈÉÊÌÎÏÛ"
));

const PUNCT_MAP = { '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...' };

function normalizeText(text) {
  let out = '';
  for (const ch of String(text)) out += PUNCT_MAP[ch] !== undefined ? PUNCT_MAP[ch] : ch;
  return out.replace(/\uFE0F/g, '').replace(/\s/g, ' ');
}

function cleanReply(text) {
  const out = [];
  for (let ch of Array.from(normalizeText(text))) {
    if (!REPLY_ALLOWED.has(ch)) {
      ch = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // ö -> o
      if (ch.length !== 1 || !REPLY_ALLOWED.has(ch)) continue;
    }
    out.push(ch);
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

// Last-resort length cap. Cuts at a word boundary so a word is never split.
function finalizeReply(text, hard = REPLY_HARD_CHARS) {
  let t = cleanReply(text);
  if (t.length <= hard) return t;
  let cut = t.slice(0, hard);
  const space = cut.lastIndexOf(' ');
  if (space > 0) cut = cut.slice(0, space);
  return cut.trim();
}

// Two chat styles: the one-line AI mode, and the roomier OS "ai chat" app.
const PANEL_CHAT = { persona: DEFAULT_PERSONA, rules: PANEL_RULES, hardChars: REPLY_HARD_CHARS, shorten: SHORTEN_PROMPT };
const OS_CHAT = { persona: OS_PERSONA, rules: OS_RULES, hardChars: 110, shorten: OS_SHORTEN_PROMPT };

function currentSystemPrompt(t, style = PANEL_CHAT) {
  const persona = t.customPrompt !== null ? t.customPrompt : style.persona;
  if (t.customPrompt === null || t.appendRules) return persona.trim() + ' ' + style.rules;
  return persona.trim();
}

async function groqCall(messages, maxTokens = COMPLETION_TOKENS) {
  const r = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + groqKey,
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.3,
      max_completion_tokens: maxTokens,
      reasoning_effort: 'low',
      stream: false,
      messages,
    }),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('Groq ' + r.status + (r.status === 401 ? ' (key rejected)' : '') + ': ' + body.slice(0, 200));
  }

  const data = await r.json();
  const choice = (data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  return {
    content: String(msg.content || '').replace(/\uFE0F/g, '').replace(/\s+/g, ' ').trim(),
    finishReason: choice.finish_reason || 'stop',
  };
}

async function askGroq(t, message, hist = t.history, style = PANEL_CHAT) {
  const base = [
    { role: 'system', content: currentSystemPrompt(t, style) },
    ...hist,
    { role: 'user', content: message },
  ];

  const RETRY_LIMIT = 2;
  let messages = base;
  let lastContent = '';
  let attempts = 0;

  while (attempts <= RETRY_LIMIT) {
    const { content, finishReason } = await groqCall(messages);
    lastContent = content;
    const clean = finalizeReply(content, style.hardChars);

    const cutByTokens = finishReason === 'length';
    const tooLong = clean.length > style.hardChars || content.length > style.hardChars;

    if (!cutByTokens && !tooLong && clean) {
      return clean; // complete and within bounds
    }

    if (attempts === RETRY_LIMIT) break;
    attempts++;

    messages = [
      ...base,
      { role: 'assistant', content: content || '(no visible text)' },
      { role: 'user', content: style.shorten },
    ];

    if (cutByTokens) {
      messages.push({ role: 'user', content: 'Use very few words so the whole answer fits.' });
    }
  }

  const clean = finalizeReply(lastContent, style.hardChars);
  if (!clean) throw new Error('Model returned no usable text. Try again.');
  return clean;
}

// ======================= CONVERSATION HELPERS =======================

function pushHistory(t, role, content) {
  t.history.push({ role, content });
  const cap = MAX_HISTORY_TURNS * 2;
  if (t.history.length > cap) t.history = t.history.slice(-cap);
}

function abandonChat(t) {
  t.chatGen++;
  t.chatBusy = false;
}

function clearHistory(t) {
  t.history = [];
  t.lastUserMessage = ''; // nothing left to redo
  abandonChat(t);         // an answer still being written must not bring it back
}

// Ask the AI and put the exchange on the panel. Used by the web page (/api/chat) and
// by the REDO pin. redo = true replaces the last exchange instead of adding a new one.
async function runChat(t, message, redo = false) {
  const myGen = ++t.chatGen;
  t.chatBusy = true;
  const base = redo ? t.history.slice(0, -2) : t.history; // redo: leave out the old answer
  let reply;
  try {
    reply = await askGroq(t, message, base);
  } finally {
    if (myGen === t.chatGen) t.chatBusy = false;
  }
  if (myGen !== t.chatGen) return { interrupted: true };

  if (redo) t.history = base.slice();
  pushHistory(t, 'user', message);
  pushHistory(t, 'assistant', reply);
  t.lastUserMessage = message;

  t.queue = []; // the new message replaces whatever was still being drawn
  if (CLEAR_BEFORE_TEXT) t.queue.push(...clearFrames());

  if (SHOW_INPUT) {
    const body = Array.from(cleanReply(message)).slice(0, ECHO_MAX_CHARS);
    const echo = [...Array.from(ECHO_PREFIX), ...body, ...Array.from(ECHO_SUFFIX)];
    const codes = [
      ...echo.map(encode),
      ...separatorCodes(echo.length),
      ...Array.from(reply).slice(0, 200).map(encode),
    ];
    t.queue.push(...buildFrames(t, codes));
  } else {
    t.queue.push(...buildFrames(t, Array.from(reply).slice(0, 200).map(encode)));
  }
  return { reply };
}

// ======================= FILESYSTEM (saved on the PC running this script) =======================
//
// One small filesystem per password. Nodes:
//   dir : { type:'dir',  children:{ name: node }, mtime }
//   file: { type:'file', content:'text', mtime }
// Everything is kept in memory and written to DATA_FILE a moment after each change.

const DATA_FILE = process.env.PANEL_DATA || nodePath.join(__dirname, 'panel-data.json');
const FS_MAX_FILE_CHARS = 4000;     // per file
const FS_MAX_TOTAL_CHARS = 200000;  // per panel
const FS_MAX_NODES = 300;           // files + folders per panel
const FS_MAX_DEPTH = 8;

const filesystems = new Map();      // sha256(password) -> root dir node
let saveTimer = null;

const isDirNode = (n) => !!n && n.type === 'dir' && !!n.children && typeof n.children === 'object';

function loadStore() {
  try {
    const data = JSON.parse(nodeFs.readFileSync(DATA_FILE, 'utf8'));
    const all = (data && data.filesystems) || {};
    for (const key of Object.keys(all)) if (isDirNode(all[key])) filesystems.set(key, all[key]);
    console.log('Filesystem: loaded ' + filesystems.size + ' saved panel(s) from ' + DATA_FILE);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('Filesystem: ' + DATA_FILE + ' will be created on the first change.');
    } else {
      console.error('Filesystem: could not read ' + DATA_FILE + ' (' + e.message + '). Keeping a copy as .bad');
      try { nodeFs.renameSync(DATA_FILE, DATA_FILE + '.bad'); } catch (_) {}
    }
  }
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = DATA_FILE + '.tmp';
    nodeFs.writeFileSync(tmp, JSON.stringify({ version: 1, filesystems: Object.fromEntries(filesystems) }));
    nodeFs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Filesystem: could not save ' + DATA_FILE + ': ' + e.message);
  }
}

function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 400);
}

process.on('exit', () => { if (saveTimer) saveNow(); });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

function newFsRoot() {
  const now = Date.now();
  return {
    type: 'dir', mtime: now,
    children: { 'readme.txt': { type: 'file', mtime: now, content: 'welcome to bldos. open the terminal and type help.' } },
  };
}

function fsRoot(t) {
  if (!t.fsKey) t.fsKey = crypto.createHash('sha256').update('panel-fs:' + t.password).digest('hex').slice(0, 32);
  let root = filesystems.get(t.fsKey);
  if (!root) {
    root = newFsRoot();
    filesystems.set(t.fsKey, root);
    scheduleSave();
  }
  return root;
}

const validName = (n) => /^[a-z0-9_][a-z0-9._-]{0,23}$/.test(String(n));

function childOf(dir, name) {
  return Object.prototype.hasOwnProperty.call(dir.children, name) ? dir.children[name] : null;
}

// Turn a path (absolute or relative to cwd) into a list of names. '.' and '..' are resolved.
function splitPath(cwd, p) {
  p = String(p || '');
  const segs = p.startsWith('/') ? [] : String(cwd).split('/').filter(Boolean);
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segs.pop();
    else segs.push(part);
  }
  return segs;
}
const pathStr = (segs) => '/' + segs.join('/');

function lookup(root, segs) {
  let n = root;
  for (const s of segs) {
    if (!n || n.type !== 'dir') return null;
    n = childOf(n, s);
  }
  return n || null;
}

function sortedNames(dir) {
  return Object.keys(dir.children).sort((a, b) =>
    ((dir.children[b].type === 'dir') - (dir.children[a].type === 'dir')) || a.localeCompare(b));
}

function fsStats(root) {
  let nodes = 0;
  let chars = 0;
  (function walk(dir) {
    for (const name of Object.keys(dir.children)) {
      const c = dir.children[name];
      nodes++;
      if (c.type === 'dir') walk(c); else chars += (c.content || '').length;
    }
  })(root);
  return { nodes, chars };
}

// Split an absolute path into parent dir + new/existing name. Returns { err } on failure.
function fsSplit(t, p) {
  const segs = splitPath('/', p);
  if (!segs.length) return { err: 'is root' };
  const name = segs[segs.length - 1];
  if (!validName(name)) return { err: 'bad name' };
  if (segs.length > FS_MAX_DEPTH) return { err: 'too deep' };
  const parent = lookup(fsRoot(t), segs.slice(0, -1));
  if (!parent) return { err: 'no such dir' };
  if (parent.type !== 'dir') return { err: 'not a dir' };
  return { segs, name, parent };
}

// All fs* functions return null on success or a short error string.
function fsWriteFile(t, p, content) {
  const s = fsSplit(t, p);
  if (s.err) return s.err;
  const ex = childOf(s.parent, s.name);
  if (ex && ex.type === 'dir') return 'is a dir';
  const text = String(content);
  if (text.length > FS_MAX_FILE_CHARS) return 'file too big';
  const st = fsStats(fsRoot(t));
  if (!ex && st.nodes >= FS_MAX_NODES) return 'fs full';
  if (st.chars - (ex ? ex.content.length : 0) + text.length > FS_MAX_TOTAL_CHARS) return 'fs full';
  if (ex) { ex.content = text; ex.mtime = Date.now(); }
  else s.parent.children[s.name] = { type: 'file', content: text, mtime: Date.now() };
  scheduleSave();
  return null;
}

function fsMkdir(t, p) {
  const s = fsSplit(t, p);
  if (s.err) return s.err;
  if (childOf(s.parent, s.name)) return 'exists';
  if (fsStats(fsRoot(t)).nodes >= FS_MAX_NODES) return 'fs full';
  s.parent.children[s.name] = { type: 'dir', children: {}, mtime: Date.now() };
  scheduleSave();
  return null;
}

function fsRemove(t, p, recursive) {
  const s = fsSplit(t, p);
  if (s.err) return s.err === 'bad name' ? 'no such file' : s.err;
  const ex = childOf(s.parent, s.name);
  if (!ex) return 'no such file';
  if (ex.type === 'dir' && !recursive && Object.keys(ex.children).length) return 'not empty (use -r)';
  delete s.parent.children[s.name];
  scheduleSave();
  return null;
}

function fsCopy(t, from, to) {
  const root = fsRoot(t);
  const fromSegs = splitPath('/', from);
  const src = lookup(root, fromSegs);
  if (!src) return 'no such file';
  if (src.type !== 'file') return 'is a dir';
  const toSegs = splitPath('/', to);
  const dest = lookup(root, toSegs);
  const target = dest && dest.type === 'dir' ? toSegs.concat(fromSegs.slice(-1)) : toSegs;
  return fsWriteFile(t, pathStr(target), src.content);
}

function fsMove(t, from, to) {
  const root = fsRoot(t);
  const fromSegs = splitPath('/', from);
  if (!fromSegs.length) return 'is root';
  const src = lookup(root, fromSegs);
  if (!src) return 'no such file';
  const toSegs0 = splitPath('/', to);
  const dest = lookup(root, toSegs0);
  const toSegs = dest && dest.type === 'dir' ? toSegs0.concat(fromSegs.slice(-1)) : toSegs0;
  if (toSegs.length >= fromSegs.length && fromSegs.every((s, i) => toSegs[i] === s)) return 'bad move';
  const a = fsSplit(t, pathStr(toSegs));
  if (a.err) return a.err;
  if (childOf(a.parent, a.name)) return 'exists';
  const b = fsSplit(t, pathStr(fromSegs));
  if (b.err) return b.err;
  a.parent.children[a.name] = src;
  delete b.parent.children[b.name];
  scheduleSave();
  return null;
}

// ======================= AI CHAT (OS app) =======================

// Ask the AI for the OS "ai chat" app. Draws "thinking...", then the reply (or an error
// message), and never throws. The typed draft is kept until an answer arrives.
async function runOsChat(t, message) {
  const myGen = ++t.chatGen;
  t.chatBusy = true;
  t.os.ai.shown = false;
  t.os.ai.text = '';
  t.os.ai.notice = 'thinking...';
  redrawOS(t);

  let reply = '';
  let error = '';
  try {
    reply = await askGroq(t, message, t.history, OS_CHAT);
  } catch (e) {
    error = e.message || 'unknown error';
  } finally {
    if (myGen === t.chatGen) t.chatBusy = false;
  }
  if (myGen !== t.chatGen) return { interrupted: true };
  const os = t.os;
  if (t.mode !== 'os' || !os.power || os.app !== 'ai') return { interrupted: true };

  if (error) {
    os.ai.notice = 'error: ' + cleanReply(error).slice(0, 70);
    redrawOS(t);
    noteAction(t, 'AI chat failed: ' + error);
    console.error('AI chat failed:', error);
    return { error };
  }
  pushHistory(t, 'user', message);
  pushHistory(t, 'assistant', reply);
  t.lastUserMessage = message;
  os.ai.notice = '';
  os.ai.draft = '';
  os.ai.text = reply;
  os.ai.shown = true;
  redrawOS(t);
  return { reply };
}

// ======================= SIMULATED OS =======================
//
// The /out transmitter handles the OS controls:
//   pin 1 POWER, pin 2 DOWN, pin 3 UP, pin 4 SELECT, pin 5 FN1, pin 6 FN2, optional pin 7 ENTER.
// The four /keys/N POST transmitters handle typing (letters, ENTER, SPACE, BACKSPACE, . - /).
// A keyboard bank reacts only to rising edges, so POST an all-zero state on release.
//
// Apps (menu: UP/FN1 previous, DOWN/FN2 next, SELECT opens):
//   ai chat   letters/SPACE type, ENTER sends, FN1 clears, FN2 = backspace, SELECT exits
//   terminal  letters/SPACE type, ENTER runs, UP/DOWN = history (or output pages),
//             FN1 clears the line, FN2 = backspace, SELECT exits
//   text edit letters/SPACE type, ENTER = new line, FN1 saves, FN2 = backspace,
//             UP/DOWN read the file page by page, SELECT saves and exits
//   files     UP/DOWN move, SELECT/ENTER opens, FN1 = back (or exit), FN2 = new file,
//             letters jump to the next name starting with that letter
//   clock     FN1 time/date, FN2 12/24-hour
//   dice      FN1 rolls, FN2 (or UP/DOWN) changes the die

// New transmitters start in this mode ('os' or 'ai'). Use PANEL_MODE=ai to start in AI mode.
const DEFAULT_MODE = String(process.env.PANEL_MODE || '').toLowerCase() === 'ai' ? 'ai' : 'os';

const OS_VERSION = '1.5';
const OS_PINS = ['power', 'down', 'up', 'select', 'fn1', 'fn2', 'enter']; // main transmitter pins 1-6; optional pin 7 = ENTER
const OS_DEBOUNCE_MS = 40;
const POWER_ON_FALLING_EDGE = false;

const APPS = [
  { id: 'ai', name: 'ai chat' },
  { id: 'term', name: 'terminal' },
  { id: 'edit', name: 'text edit' },
  { id: 'files', name: 'files' },
  { id: 'clok', name: 'clock' },
  { id: 'dice', name: 'dice' },
  { id: 'games', name: 'games' },
];

// The four 8-pin POST keyboard banks. Array position 0 is physical pin 1.
const KEY_BANKS = [
  { id: '1', keys: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
  { id: '2', keys: ['i', 'j', 'k', 'l', 'm', 'n', 'o', 'p'] },
  { id: '3', keys: ['q', 'r', 's', 't', 'u', 'v', 'w', 'x'] },
  { id: '4', keys: ['y', 'z', 'enter', 'space', 'backspace', 'dot', 'dash', 'slash'] },
];
const KEY_CHARS = { space: ' ', dot: '.', dash: '-', slash: '/' };
const WEB_KEYBOARD_KEYS = new Set(['enter', 'space', 'backspace']);
// Some transmitter setups keep POSTing the pressed state and do not send a zero on release.
// Enter gets a slow repeat fallback so it can be pressed again after opening an app.
const ENTER_REPEAT_MS = 700;

// How many rows are redrawn while typing (small = fast) and for outputs/pages/replies.
// The panel draws one character per poll, so keep INPUT_ROWS small.
const INPUT_ROWS = 2;
const OUTPUT_ROWS = 8;

const EDITOR_MAX = FS_MAX_FILE_CHARS;
const TERM_MAX = 120;
const AI_DRAFT_MAX = 300;
const HIST_MAX = 20;
const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100];

const newTerm = () => ({ buf: '', out: null, page: 0, cwd: '/', hist: [], histIdx: -1 });
const newEditor = () => ({ path: null, text: '', dirty: false, saveAs: null, scroll: null, returnTo: 'menu', notice: '' });
const newFiles = () => ({ cwd: '/', cursor: 0, newName: null, notice: '' });
const newGames = () => ({ screen: 'menu', cursor: 0, g: null });
const newAi = () => ({ shown: false, text: '', draft: '', notice: '' });

function makeOS() {
  return {
    power: false,
    app: 'menu',
    cursor: 0,
    bootedAt: 0,
    screen: '',
    lastKey: '',
    debounce: {},
    term: newTerm(),
    editor: newEditor(),
    files: newFiles(),
    clock: { showDate: false, use24h: true },
    dice: { side: 1, result: null },
    ai: newAi(),
    games: newGames(),
  };
}

const pad2 = (v) => String(v).padStart(2, '0');
const rollDie = (os) => 1 + Math.floor(Math.random() * DICE_SIDES[os.dice.side]);

// ---- screen layout: text -> rows of at most CHARS_PER_ROW characters ----

// Word wrap (used for AI replies and short notices).
function wrapWords(text) {
  const rows = [];
  let cur = '';
  for (let word of String(text).split(' ')) {
    while (word.length > CHARS_PER_ROW) {
      if (cur) { rows.push(cur); cur = ''; }
      rows.push(word.slice(0, CHARS_PER_ROW));
      word = word.slice(CHARS_PER_ROW);
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if ((cur + ' ' + word).length <= CHARS_PER_ROW) cur += ' ' + word;
    else { rows.push(cur); cur = word; }
  }
  if (cur) rows.push(cur);
  return rows.length ? rows : [''];
}

// Hard wrap, keeps spaces and respects '\n' (used for typing and terminal output).
function layoutRows(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const chars = Array.from(line);
    if (!chars.length) rows.push('');
    for (let i = 0; i < chars.length; i += CHARS_PER_ROW) rows.push(chars.slice(i, i + CHARS_PER_ROW).join(''));
  }
  return rows;
}

const tailRows = (text, limit) => layoutRows(text).slice(-limit);
const fit = (text) => String(text).slice(0, CHARS_PER_ROW);

// Split text into pages of OUTPUT_ROWS rows. headerFn(page, pages) adds a header row;
// without one, a "1/3 up/down" footer row is added when there is more than one page.
function pagedRows(text, page, headerFn) {
  const all = layoutRows(text);
  let per = OUTPUT_ROWS - (headerFn ? 1 : 0);
  let pages = Math.max(1, Math.ceil(all.length / per));
  const footer = !headerFn && pages > 1;
  if (footer) {
    per = OUTPUT_ROWS - 1;
    pages = Math.max(1, Math.ceil(all.length / per));
  }
  const p = Math.min(Math.max(page | 0, 0), pages - 1);
  const rows = all.slice(p * per, (p + 1) * per);
  if (headerFn) rows.unshift(headerFn(p + 1, pages));
  if (footer) rows.push((p + 1) + '/' + pages + ' up/down');
  return { rows, page: p, pages };
}

// Codes that move the cursor from the end of a row (len characters used) to the next row.
function rowBreak(len) {
  if (NEWLINE_CODE !== null) return len === CHARS_PER_ROW ? [] : [NEWLINE_CODE & 127];
  return Array(Math.max(0, CHARS_PER_ROW - len)).fill(SPACE_CODE);
}

function codesForRows(rows) {
  const codes = [];
  rows.forEach((row, i) => {
    const chars = Array.from(row);
    codes.push(...chars.map(encode));
    if (i < rows.length - 1) codes.push(...rowBreak(chars.length));
  });
  return codes;
}

// Clear the panel, then draw the rows. Replaces whatever was still being drawn.
function osShow(t, rows) {
  const shown = rows.slice(0, 16);
  t.os.screen = shown.join('\n');
  t.queue = [];
  t.queue.push(...clearFrames());
  t.queue.push(...buildFrames(t, codesForRows(shown)));
}

// ---- what each app shows ----

function fmEntries(t) {
  const fm = t.os.files;
  let dir = lookup(fsRoot(t), splitPath('/', fm.cwd));
  if (!dir || dir.type !== 'dir') { fm.cwd = '/'; dir = fsRoot(t); }
  const list = [];
  if (fm.cwd !== '/') list.push({ name: '..', type: 'dir', up: true });
  for (const name of sortedNames(dir)) list.push({ name, type: dir.children[name].type });
  return list;
}

function osRows(t) {
  const os = t.os;
  switch (os.app) {
    case 'menu':
      return layoutRows('▶ ' + APPS[os.cursor].name + ' ' + (os.cursor + 1) + '/' + APPS.length);

    case 'term': {
      const tm = os.term;
      if (tm.out !== null) {
        const v = pagedRows(tm.out, tm.page);
        tm.page = v.page;
        return v.rows;
      }
      const shortCwd = tm.cwd.length > 8 ? '..' + tm.cwd.slice(-6) : tm.cwd;
      return tailRows(shortCwd + '# ' + tm.buf + '_', INPUT_ROWS);
    }

    case 'edit': {
      const ed = os.editor;
      if (ed.saveAs !== null) return tailRows('save as: ' + ed.saveAs + '_', INPUT_ROWS);
      if (ed.notice) return wrapWords(ed.notice);
      const label = ed.path ? (ed.path.length > 8 ? '..' + ed.path.slice(-6) : ed.path) : '(new)';
      if (ed.scroll !== null) {
        const v = pagedRows(ed.text || '(empty)', ed.scroll, (p, n) => fit('rd ' + label + ' ' + p + '/' + n));
        ed.scroll = v.page;
        return v.rows;
      }
      return [fit('edit ' + label + (ed.dirty ? '*' : ''))].concat(tailRows(ed.text + '_', INPUT_ROWS));
    }

    case 'files': {
      const fm = os.files;
      if (fm.newName !== null) return tailRows('new file: ' + fm.newName + '_', INPUT_ROWS);
      if (fm.notice) return wrapWords(fm.notice);
      const list = fmEntries(t);
      if (!list.length) return ['(no files)'];
      fm.cursor = Math.min(Math.max(fm.cursor, 0), list.length - 1);
      const e = list[fm.cursor];
      return layoutRows('▶ ' + e.name + (e.type === 'dir' ? '/' : '') + ' ' + (fm.cursor + 1) + '/' + list.length);
    }

    case 'clok': {
      const d = new Date();
      if (os.clock.showDate) {
        return [d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())];
      }
      let hours = d.getHours();
      if (!os.clock.use24h) hours = (hours % 12) || 12;
      return [pad2(hours) + ':' + pad2(d.getMinutes()) + (os.clock.use24h ? '' : (d.getHours() >= 12 ? ' PM' : ' AM'))];
    }

    case 'dice':
      return ['d' + DICE_SIDES[os.dice.side] + (os.dice.result === null ? '' : ': ' + os.dice.result)];

    case 'games':
      return gamesRows(t);

    case 'ai': {
      const ai = os.ai;
      if (ai.notice) return wrapWords(ai.notice);
      if (ai.shown) return wrapWords(ai.text).slice(0, 16);
      return tailRows('AI:' + ai.draft + '_', INPUT_ROWS);
    }

    default:
      return ['err'];
  }
}

function redrawOS(t) {
  osShow(t, osRows(t));
}

// I/O key: on = menu, off = blank screen (typed text is forgotten, saved files are not).
// Mutates t.os instead of replacing it, so the debounce map survives toggles.
function osPower(t, on) {
  const os = t.os;
  if (!!os.power === !!on) return;   // already in that state
  abandonChat(t);
  os.power = !!on;
  os.app = 'menu';
  os.cursor = 0;
  os.screen = '';
  os.lastKey = '';
  os.term = newTerm();
  os.editor = newEditor();
  os.files = newFiles();
  os.clock = { showDate: false, use24h: true };
  os.dice = { side: 1, result: null };
  os.ai = newAi();
  if (on) {
    os.bootedAt = Date.now();
    redrawOS(t);
    noteAction(t, 'OS on');
  } else {
    t.queue = [];
    t.queue.push(...clearFrames());
    noteAction(t, 'OS off');
  }
}

// ---- terminal ----

// The keyboard has no digit keys, so numbers are typed as words.
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
};

function parseTerminalNumber(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, raw) ? NUMBER_WORDS[raw] : NaN;
}

const USAGE = {
  ls: 'ls [-l] [path]', cd: 'cd [path]', pwd: 'pwd', cat: 'cat file',
  mkdir: 'mkdir dir', touch: 'touch file', rm: 'rm [-r] path',
  cp: 'cp from to', mv: 'mv from to or rename',
  write: 'write file text', append: 'append file text (new line)',
  edit: 'edit [file]', wc: 'wc file', head: 'head file [n]', tail: 'tail file [n]',
  find: 'find text', grep: 'grep text file', tree: 'tree [path]', df: 'df (space used)',
  run: 'run file (one command per line)', history: 'history',
  echo: 'echo text', time: 'time', date: 'date', ver: 'ver', about: 'about', sys: 'sys',
  uptime: 'uptime', whoami: 'whoami', rand: 'rand [max]', roll: 'roll [sides]', flip: 'flip',
  add: 'add a b', sub: 'sub a b', mul: 'mul a b', div: 'div a b', mod: 'mod a b', pow: 'pow a b',
  upper: 'upper text', reverse: 'reverse text', len: 'len text',
  clear: 'clear', exit: 'exit to menu', off: 'power off',
};

// One row each (16 columns). "help cmd" shows the usage of one command.
const HELP_TEXT = [
  'ls cd pwd cat', 'mkdir touch rm', 'cp mv write', 'append edit wc',
  'head tail find', 'grep tree df', 'run history', 'echo time date',
  'ver about sys', 'uptime whoami', 'rand roll flip', 'add sub mul div',
  'mod pow upper', 'reverse len', 'clear exit off', 'help cmd = usage',
].join('\n');

const NO_SCRIPT = new Set(['run', 'edit', 'open', 'nano', 'exit', 'off', 'clear', 'cls']);

// Run every non-empty line of a script file. Returns the combined output.
function runScript(t, text) {
  const outs = [];
  for (const raw of String(text).split('\n').slice(0, 20)) {
    const line = raw.trim().toLowerCase();
    if (!line) continue;
    const c = line.split(/\s+/)[0];
    if (NO_SCRIPT.has(c)) { outs.push(c + ': not in script'); continue; }
    const o = execLine(t, line);
    if (o) outs.push(String(o));
  }
  return outs.join('\n') || 'ok';
}

// Execute one command line. Returns the output text, or null for "nothing to show".
function execLine(t, line) {
  const os = t.os;
  const tm = os.term;
  const root = fsRoot(t);
  const [cmd, ...args] = line.split(/\s+/);
  const d = new Date();
  const abs = (p) => pathStr(splitPath(tm.cwd, p));
  const usage = (name) => 'use: ' + USAGE[name];
  const done = (err) => (err ? cmd + ': ' + err : 'ok');
  const fileArg = (name) => {
    if (!name) return { err: usage(cmd) };
    const node = lookup(root, splitPath(tm.cwd, name));
    if (!node) return { err: cmd + ': no such file' };
    if (node.type !== 'file') return { err: cmd + ': is a dir' };
    return { node };
  };
  const countArg = (v) => {
    const n = v === undefined ? 4 : parseTerminalNumber(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
  };

  switch (cmd) {
    // ---- help & info ----
    case 'help': case 'commands': case '?':
      if (args[0]) return USAGE[args[0]] ? args[0] + ': ' + USAGE[args[0]] : 'no help for ' + args[0];
      return HELP_TEXT;
    case 'echo':
      return args.join(' ');
    case 'time':
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    case 'date':
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    case 'ver': case 'version':
      return 'bldos v' + OS_VERSION;
    case 'about':
      return 'panel os';
    case 'hello':
      return 'hello!';
    case 'whoami':
      return 'user';
    case 'uptime':
      return Math.max(0, Math.floor((Date.now() - os.bootedAt) / 1000)) + ' sec';
    case 'sys': case 'neofetch': {
      const st = fsStats(root);
      const up = Math.max(0, Math.floor((Date.now() - os.bootedAt) / 1000));
      return 'bldos v' + OS_VERSION + '\nup ' + up + ' sec\nfiles ' + st.nodes + '/' + FS_MAX_NODES + '\nchars ' + st.chars;
    }
    case 'history':
      return tm.hist.slice(-8).join('\n') || '(none)';
    case 'clear': case 'cls':
      return '';
    case 'exit':
      os.app = 'menu';
      return null;
    case 'off':
      osPower(t, false);
      return null;

    // ---- small utilities ----
    case 'rand': {
      const maxArg = args.length ? parseTerminalNumber(args[0]) : 100;
      const max = Number.isFinite(maxArg) && maxArg > 0 ? Math.floor(maxArg) : 100;
      return String(Math.floor(Math.random() * max));
    }
    case 'roll': {
      const n = args.length ? parseTerminalNumber(args[0]) : 6;
      const sides = Number.isFinite(n) && n >= 2 ? Math.floor(n) : 6;
      return String(1 + Math.floor(Math.random() * sides));
    }
    case 'flip':
      return Math.random() < 0.5 ? 'heads' : 'tails';
    case 'add': case 'sub': case 'mul': case 'div': case 'mod': case 'pow': {
      const a = parseTerminalNumber(args[0]);
      const b = parseTerminalNumber(args[1]);
      if (args.length < 2 || !Number.isFinite(a) || !Number.isFinite(b)) return 'use number words';
      if ((cmd === 'div' || cmd === 'mod') && b === 0) return 'err: div by 0';
      const r = cmd === 'add' ? a + b : cmd === 'sub' ? a - b : cmd === 'mul' ? a * b
        : cmd === 'div' ? a / b : cmd === 'mod' ? a % b : Math.pow(a, b);
      return Number.isFinite(r) ? String(Math.round(r * 1000) / 1000) : 'err: overflow';
    }
    case 'upper':
      return args.join(' ').toUpperCase();
    case 'reverse':
      return Array.from(args.join(' ')).reverse().join('');
    case 'len':
      return String(args.join(' ').length);

    // ---- filesystem ----
    case 'pwd':
      return tm.cwd;
    case 'cd': {
      const segs = splitPath(tm.cwd, args[0] || '/');
      const n = lookup(root, segs);
      if (!n) return 'cd: no such dir';
      if (n.type !== 'dir') return 'cd: not a dir';
      tm.cwd = pathStr(segs);
      return null;
    }
    case 'ls': case 'dir': {
      const long = args.includes('-l');
      const segs = splitPath(tm.cwd, args.find((a) => !a.startsWith('-')) || '.');
      const node = lookup(root, segs);
      if (!node) return 'ls: no such path';
      if (node.type === 'file') return segs[segs.length - 1] + (long ? ' ' + node.content.length : '');
      const names = sortedNames(node);
      if (!names.length) return '(empty)';
      return names.map((n) => {
        const c = node.children[n];
        return n + (c.type === 'dir' ? '/' : (long ? ' ' + c.content.length : ''));
      }).join('\n');
    }
    case 'tree': {
      const segs = splitPath(tm.cwd, args[0] || '.');
      const node = lookup(root, segs);
      if (!node) return 'tree: no such path';
      if (node.type === 'file') return segs[segs.length - 1];
      const lines = [];
      const walk = (dir, depth) => {
        for (const name of sortedNames(dir)) {
          if (lines.length >= 60) return;
          const c = dir.children[name];
          lines.push('  '.repeat(depth) + name + (c.type === 'dir' ? '/' : ''));
          if (c.type === 'dir') walk(c, depth + 1);
        }
      };
      walk(node, 0);
      return lines.length ? lines.join('\n') : '(empty)';
    }
    case 'cat': {
      const f = fileArg(args[0]);
      return f.err || f.node.content || '(empty)';
    }
    case 'head': case 'tail': {
      const f = fileArg(args[0]);
      if (f.err) return f.err;
      const n = countArg(args[1]);
      const lines = f.node.content.split('\n');
      return (cmd === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n') || '(empty)';
    }
    case 'wc': {
      const f = fileArg(args[0]);
      if (f.err) return f.err;
      const c = f.node.content;
      return (c ? c.split('\n').length : 0) + ' lines\n' + c.split(/\s+/).filter(Boolean).length + ' words\n' + c.length + ' chars';
    }
    case 'grep': {
      if (args.length < 2) return usage('grep');
      const f = fileArg(args[1]);
      if (f.err) return f.err;
      const hits = f.node.content.split('\n').filter((l) => l.includes(args[0]));
      return hits.length ? hits.join('\n') : '(none)';
    }
    case 'find': {
      if (!args[0]) return usage('find');
      const startSegs = splitPath(tm.cwd, '.');
      const start = lookup(root, startSegs);
      const hits = [];
      const walk = (dir, segs) => {
        for (const name of sortedNames(dir)) {
          if (hits.length >= 40) return;
          const p = segs.concat(name);
          if (name.includes(args[0])) hits.push(pathStr(p));
          if (dir.children[name].type === 'dir') walk(dir.children[name], p);
        }
      };
      if (start && start.type === 'dir') walk(start, startSegs);
      return hits.length ? hits.join('\n') : '(none)';
    }
    case 'df': {
      const st = fsStats(root);
      return 'files ' + st.nodes + '/' + FS_MAX_NODES + '\nchars ' + st.chars + '/' + FS_MAX_TOTAL_CHARS;
    }
    case 'mkdir': case 'touch': {
      if (!args.length) return usage(cmd);
      for (const a of args) {
        let err;
        if (cmd === 'mkdir') {
          err = fsMkdir(t, abs(a));
        } else {
          const ex = lookup(root, splitPath(tm.cwd, a));
          if (ex) { ex.mtime = Date.now(); scheduleSave(); err = null; }
          else err = fsWriteFile(t, abs(a), '');
        }
        if (err) return cmd + ': ' + err;
      }
      return 'ok';
    }
    case 'rm': {
      const recursive = args.includes('-r') || args.includes('-rf');
      const targets = args.filter((a) => !a.startsWith('-'));
      if (!targets.length) return usage('rm');
      for (const a of targets) {
        const err = fsRemove(t, abs(a), recursive);
        if (err) return 'rm: ' + err;
      }
      return 'ok';
    }
    case 'cp': case 'mv':
      if (args.length < 2) return usage(cmd);
      return done(cmd === 'cp' ? fsCopy(t, abs(args[0]), abs(args[1])) : fsMove(t, abs(args[0]), abs(args[1])));
    case 'write': case 'append': {
      if (args.length < (cmd === 'append' ? 2 : 1)) return usage(cmd);
      const text = args.slice(1).join(' ');
      const p = abs(args[0]);
      let content = text;
      if (cmd === 'append') {
        const ex = lookup(root, splitPath('/', p));
        if (ex && ex.type === 'file' && ex.content) content = ex.content + '\n' + text;
      }
      return done(fsWriteFile(t, p, content));
    }
    case 'edit': case 'open': case 'nano': {
      if (!args[0]) {
        os.editor = newEditor();
        os.editor.returnTo = 'term';
        os.app = 'edit';
        return null;
      }
      const err = openEditor(t, abs(args[0]), 'term');
      return err ? 'edit: ' + err : null;
    }
    case 'run': {
      const f = fileArg(args[0]);
      return f.err || runScript(t, f.node.content);
    }

    default:
      return 'err: ' + cmd;
  }
}

// ENTER in the terminal.
function runCommand(t) {
  const tm = t.os.term;
  const line = tm.buf.trim().toLowerCase();
  tm.buf = '';
  tm.out = null;
  tm.page = 0;
  tm.histIdx = -1;
  if (!line) return;
  tm.hist.push(line);
  if (tm.hist.length > HIST_MAX) tm.hist.shift();
  if (!lookup(fsRoot(t), splitPath('/', tm.cwd))) tm.cwd = '/';   // the folder was removed
  const out = execLine(t, line);
  tm.out = out === undefined || out === null ? null : String(out);
}

function termHistory(tm, key) {
  if (!tm.hist.length) return;
  if (key === 'up') {
    tm.histIdx = tm.histIdx < 0 ? tm.hist.length - 1 : Math.max(0, tm.histIdx - 1);
  } else {
    if (tm.histIdx < 0) return;
    tm.histIdx++;
    if (tm.histIdx >= tm.hist.length) { tm.histIdx = -1; tm.buf = ''; return; }
  }
  tm.buf = tm.hist[tm.histIdx];
}

function termKey(t, key) {
  const os = t.os;
  const tm = os.term;
  if (key === 'select') { os.app = 'menu'; return; }
  if (tm.out !== null) {
    if (key === 'up' || key === 'down') {                    // page through long output
      const pages = pagedRows(tm.out, 0).pages;
      tm.page = Math.min(Math.max(tm.page + (key === 'down' ? 1 : -1), 0), pages - 1);
      return;
    }
    tm.out = null;                                           // any other key leaves the output
    tm.buf = '';
    tm.page = 0;
  }
  // FN1 does nothing while typing (it used to clear the line), so a stray press loses nothing.
  if (key === 'fn2') tm.buf = tm.buf.slice(0, -1);
  else if (key === 'up' || key === 'down') termHistory(tm, key);
}

// ---- text editor ----

// Open a file (or a new file name) in the editor. Returns an error string or null.
function openEditor(t, p, returnTo) {
  const os = t.os;
  const segs = splitPath('/', p);
  const node = lookup(fsRoot(t), segs);
  if (node && node.type === 'dir') return 'is a dir';
  if (!node) {
    const s = fsSplit(t, pathStr(segs));
    if (s.err) return s.err;
  }
  os.editor = Object.assign(newEditor(), { path: pathStr(segs), text: node ? node.content : '', returnTo });
  os.app = 'edit';
  return null;
}

function leaveEditor(t) {
  const to = t.os.editor.returnTo;
  t.os.app = to === 'term' || to === 'files' ? to : 'menu';
}

function editorSave(t) {
  const ed = t.os.editor;
  if (!ed.path) { ed.saveAs = ''; return; }          // unnamed document: ask for a name
  const err = fsWriteFile(t, ed.path, ed.text);
  if (err) ed.notice = 'save failed: ' + err;
  else { ed.dirty = false; ed.notice = 'saved'; }
}

// ENTER while the "save as" name is being typed.
function editorConfirmName(t) {
  const ed = t.os.editor;
  const segs = splitPath('/', String(ed.saveAs).trim());
  const target = pathStr(segs);
  ed.saveAs = null;
  const err = fsWriteFile(t, target, ed.text);
  if (err) { ed.notice = 'save failed: ' + err; return; }
  ed.path = target;
  ed.dirty = false;
  ed.notice = 'saved ' + target;
}

function editorKey(t, key) {
  const ed = t.os.editor;
  if (ed.saveAs !== null) {                           // typing a file name
    if (key === 'select') ed.saveAs = null;
    else if (key === 'fn2') ed.saveAs = ed.saveAs.slice(0, -1);
    return;
  }
  ed.notice = '';
  if (key === 'fn1') {
    if (ed.path) editorSave(t);                      // unnamed: FN1 never opens the name prompt
    else ed.notice = 'unsaved: select=save';
  } else if (key === 'fn2') {
    ed.scroll = null;
    if (ed.text.length) { ed.text = ed.text.slice(0, -1); ed.dirty = true; }
  } else if (key === 'up') {
    ed.scroll = ed.scroll === null ? 0 : ed.scroll - 1;
  } else if (key === 'down') {
    ed.scroll = ed.scroll === null ? 0 : ed.scroll + 1;
  } else if (key === 'select') {
    if (ed.dirty && !(ed.path === null && !ed.text)) {
      if (!ed.path) { ed.saveAs = ''; return; }       // unnamed: ask for a name first
      const err = fsWriteFile(t, ed.path, ed.text);
      if (err) { ed.notice = 'save failed: ' + err; return; }
      ed.dirty = false;
    }
    leaveEditor(t);
  }
}

// ---- file manager ----

function fmGoUp(fm) {
  const segs = splitPath('/', fm.cwd);
  segs.pop();
  fm.cwd = pathStr(segs);
  fm.cursor = 0;
}

function fmOpen(t) {
  const fm = t.os.files;
  const list = fmEntries(t);
  const e = list[Math.min(fm.cursor, list.length - 1)];
  if (!e) return;
  if (e.up) return fmGoUp(fm);
  const target = pathStr(splitPath(fm.cwd, e.name));
  if (e.type === 'dir') { fm.cwd = target; fm.cursor = 0; return; }
  const err = openEditor(t, target, 'files');
  if (err) fm.notice = 'open failed: ' + err;
}

// ENTER while the new file name is being typed.
function fmCreate(t) {
  const fm = t.os.files;
  const name = fm.newName.trim().toLowerCase();
  fm.newName = null;
  const parts = name.split('/').filter(Boolean);
  if (!parts.length || !parts.every(validName)) { fm.notice = 'bad name'; return; }
  const err = openEditor(t, pathStr(splitPath(fm.cwd, name)), 'files');   // saved on first save
  if (err) fm.notice = 'open failed: ' + err;
}

function filesKey(t, key) {
  const os = t.os;
  const fm = os.files;
  if (fm.newName !== null) {                          // typing a new file name
    if (key === 'select') fm.newName = null;
    else if (key === 'fn2') fm.newName = fm.newName.slice(0, -1);
    return;
  }
  fm.notice = '';
  const list = fmEntries(t);
  if (key === 'down') fm.cursor = list.length ? (fm.cursor + 1) % list.length : 0;
  else if (key === 'up') fm.cursor = list.length ? (fm.cursor - 1 + list.length) % list.length : 0;
  else if (key === 'select') fmOpen(t);
  else if (key === 'fn1') {
    if (fm.cwd !== '/') fmGoUp(fm);
    else if (fm.exitArm && Date.now() - fm.exitArm < 2000) { fm.exitArm = 0; os.app = 'menu'; }
    else { fm.exitArm = Date.now(); fm.notice = 'fn1 again=exit'; }   // needs two presses to leave
  }
  else if (key === 'fn2') fm.newName = '';
}

// ---- ai chat ----

function aiKey(t, key) {
  const ai = t.os.ai;
  if (key === 'select') { abandonChat(t); ai.notice = ''; t.os.app = 'menu'; return; }
  if (t.chatBusy) return;
  if (ai.shown) { ai.shown = false; ai.text = ''; ai.draft = ''; }
  ai.notice = '';
  if (key === 'fn2') ai.draft = ai.draft.slice(0, -1);
}

// ---- games (all played with the keyboard letters) ----

const HANG_WORDS = ['panel', 'signal', 'switch', 'button', 'screen', 'letter', 'cursor', 'wiring',
  'circuit', 'battery', 'tunnel', 'server', 'pixel', 'binary', 'planet', 'rocket', 'castle',
  'dragon', 'forest', 'garden', 'island', 'jungle', 'magnet', 'marble', 'puzzle', 'shadow',
  'spider', 'thunder', 'turtle', 'window', 'yellow', 'zipper', 'anchor', 'bridge', 'candle'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const CARD_NAMES = ['', 'ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];
const TTT_KEYS = 'qweasdzxc';
const TTT_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const tttWinner = (b) => {
  for (const [a, c, d] of TTT_LINES) if (b[a] !== '.' && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.includes('.') ? null : 'draw';
};
function tttCpu(b) {
  const free = [];
  b.forEach((v, i) => { if (v === '.') free.push(i); });
  for (const who of ['O', 'X']) {                       // win first, then block
    for (const i of free) {
      const c = b.slice(); c[i] = who;
      if (tttWinner(c) === who) return i;
    }
  }
  if (free.includes(4)) return 4;
  return pick(free);
}

const GAME_LIST = [
  { id: 'hang', name: 'hangman',
    init: () => ({ word: pick(HANG_WORDS), guessed: '', lives: 6, over: false }),
    key(g, ch) {
      if (g.over) return Object.assign(g, this.init());
      if (!/^[a-z]$/.test(ch) || g.guessed.includes(ch)) return;
      g.guessed += ch;
      if (!g.word.includes(ch)) g.lives--;
      if (g.lives <= 0 || [...g.word].every((c) => g.guessed.includes(c))) g.over = true;
    },
    rows(g) {
      const won = [...g.word].every((c) => g.guessed.includes(c));
      if (g.over) return won ? [g.word, 'you win! any key'] : ['it was ' + g.word, 'you lose any key'];
      const mask = [...g.word].map((c) => (g.guessed.includes(c) ? c : '_')).join(' ');
      const wrong = [...g.guessed].filter((c) => !g.word.includes(c)).join('');
      return [fit(mask), fit('lives ' + g.lives + ' ' + wrong)];
    } },
  { id: 'rps', name: 'rock paper',
    init: () => ({ w: 0, l: 0, d: 0, last: '' }),
    key(g, ch) {
      const names = { r: 'rok', p: 'pap', s: 'sci' };
      if (!names[ch]) return;
      const cpu = pick(['r', 'p', 's']);
      const beats = { r: 's', p: 'r', s: 'p' };
      let res = 'tie';
      if (ch !== cpu) res = beats[ch] === cpu ? 'win' : 'lose';
      if (res === 'win') g.w++; else if (res === 'lose') g.l++; else g.d++;
      g.last = names[ch] + ' v ' + names[cpu] + ' ' + res;
    },
    rows(g) { return ['r p or s?', fit(g.last), fit('w' + g.w + ' l' + g.l + ' d' + g.d)]; } },
  { id: 'cards', name: 'high low',
    init: () => ({ cur: 1 + Math.floor(Math.random() * 13), streak: 0, best: 0, msg: '' }),
    key(g, ch) {
      if (ch !== 'h' && ch !== 'l') return;
      const next = 1 + Math.floor(Math.random() * 13);
      if (next === g.cur) g.msg = 'same card, push';
      else if ((ch === 'h') === (next > g.cur)) { g.streak++; g.best = Math.max(g.best, g.streak); g.msg = 'right!'; }
      else { g.streak = 0; g.msg = 'wrong!'; }
      g.cur = next;
    },
    rows(g) {
      const r = ['card: ' + CARD_NAMES[g.cur], 'h higher l lower', fit('run ' + g.streak + ' best ' + g.best)];
      if (g.msg) r.push(fit(g.msg));
      return r;
    } },
  { id: 'ttt', name: 'tic tac toe',
    init: () => ({ b: Array(9).fill('.'), msg: '', over: false }),
    key(g, ch) {
      if (g.over) return Object.assign(g, this.init());
      const i = TTT_KEYS.indexOf(ch);
      if (i < 0 || g.b[i] !== '.') return;
      g.b[i] = 'X';
      let w = tttWinner(g.b);
      if (!w) { g.b[tttCpu(g.b)] = 'O'; w = tttWinner(g.b); }
      if (w) { g.over = true; g.msg = w === 'X' ? 'you win! any key' : w === 'O' ? 'cpu wins any key' : 'draw! any key'; }
    },
    rows(g) {
      const b = g.b;
      return [b.slice(0, 3).join('|'), b.slice(3, 6).join('|'), b.slice(6).join('|'), g.msg || 'keys qwe/asd/zxc'];
    } },
];

function gamesRows(t) {
  const gm = t.os.games || (t.os.games = newGames());
  if (gm.screen === 'menu') {
    gm.cursor = Math.min(Math.max(gm.cursor, 0), GAME_LIST.length - 1);
    return layoutRows('▶ ' + GAME_LIST[gm.cursor].name + ' ' + (gm.cursor + 1) + '/' + GAME_LIST.length);
  }
  const def = GAME_LIST.find((x) => x.id === gm.screen);
  return def.rows(gm.g);
}

function gamesStart(gm, def) { gm.screen = def.id; gm.g = def.init(); }

// Game controls. Inside a game UP/DOWN/FN1/FN2 do nothing, so a stray press can never
// wreck a game; SELECT goes back.
function gamesKey(t, key) {
  const os = t.os;
  const gm = os.games || (os.games = newGames());
  if (key === 'select') {
    if (gm.screen === 'menu') os.app = 'menu';
    else { gm.screen = 'menu'; gm.g = null; }
    return;
  }
  if (gm.screen !== 'menu') return;
  if (key === 'down' || key === 'fn2') gm.cursor = (gm.cursor + 1) % GAME_LIST.length;
  else if (key === 'up' || key === 'fn1') gm.cursor = (gm.cursor - 1 + GAME_LIST.length) % GAME_LIST.length;
}

function gamesEnter(t) {
  const gm = t.os.games || (t.os.games = newGames());
  if (gm.screen === 'menu') gamesStart(gm, GAME_LIST[gm.cursor]);
  else gm.g = GAME_LIST.find((x) => x.id === gm.screen).init();   // ENTER restarts
}

function gameChar(t, ch) {
  const gm = t.os.games || (t.os.games = newGames());
  if (gm.screen === 'menu') {                         // a letter jumps to a game: h r c t
    for (let i = 1; i <= GAME_LIST.length; i++) {
      const idx = (gm.cursor + i) % GAME_LIST.length;
      if (GAME_LIST[idx].name.startsWith(ch)) { gm.cursor = idx; break; }
    }
    return;
  }
  GAME_LIST.find((x) => x.id === gm.screen).key(gm.g, ch);
}

// ---- menu and other apps ----

function menuKey(t, key) {
  const os = t.os;
  if (key === 'down' || key === 'fn2') os.cursor = (os.cursor + 1) % APPS.length;
  else if (key === 'up' || key === 'fn1') os.cursor = (os.cursor - 1 + APPS.length) % APPS.length;
  else if (key === 'select') {
    os.app = APPS[os.cursor].id;
    if (os.app === 'term') { os.term.buf = ''; os.term.out = null; os.term.page = 0; os.term.histIdx = -1; }
    if (os.app === 'edit') os.editor = newEditor();
    if (os.app === 'files') { os.files.newName = null; os.files.notice = ''; }
    if (os.app === 'dice') os.dice.result = rollDie(os);
    if (os.app === 'games') os.games = newGames();
    if (os.app === 'ai') {
      os.ai = newAi();
      clearHistory(t);
    }
  }
}

function appKey(t, key) {
  const os = t.os;
  switch (os.app) {
    case 'ai': aiKey(t, key); break;
    case 'term': termKey(t, key); break;
    case 'edit': editorKey(t, key); break;
    case 'files': filesKey(t, key); break;
    case 'games': gamesKey(t, key); break;
    case 'clok':
      if (key === 'select') os.app = 'menu';
      else if (key === 'fn1') os.clock.showDate = !os.clock.showDate;
      else if (key === 'fn2') os.clock.use24h = !os.clock.use24h;
      break;
    case 'dice':
      if (key === 'select') os.app = 'menu';
      else if (key === 'fn1') os.dice.result = rollDie(os);
      else if (key === 'fn2' || key === 'down') {
        os.dice.side = (os.dice.side + 1) % DICE_SIDES.length;
        os.dice.result = null;
      } else if (key === 'up') {
        os.dice.side = (os.dice.side - 1 + DICE_SIDES.length) % DICE_SIDES.length;
        os.dice.result = null;
      }
      break;
    default:
      os.app = 'menu';
  }
}

// One control press from the main transmitter or the web page.
function osKey(t, key) {
  const now = Date.now();
  const last = (t.os.debounce && t.os.debounce[key]) || 0;
  if (OS_DEBOUNCE_MS > 0 && last && now - last < OS_DEBOUNCE_MS) return false;
  if (!t.os.debounce) t.os.debounce = {};
  t.os.debounce[key] = now;

  if (key === 'power') {
    osPower(t, !t.os.power);
    noteAction(t, 'OS power ' + (t.os.power ? 'on' : 'off'));
    return true;
  }
  if (!t.os.power) { noteAction(t, 'OS ' + key + ' ignored (off)'); return false; }

  // Support ENTER on the main transmitter's optional pin 7 as well as /keys/4 pin 3.
  // Both inputs use the same app-aware handler so Enter behaves identically everywhere.
  if (key === 'enter') return keyboardEnter(t);

  t.os.lastKey = key;
  if (t.os.app === 'menu') menuKey(t, key);
  else appKey(t, key);

  if (!t.os.power) { noteAction(t, 'OS off (terminal)'); return true; }
  redrawOS(t);
  noteAction(t, 'OS ' + key + ' (' + t.os.app + ')');
  return true;
}

// Main transmitter pin input remains available for power/navigation/FN controls.
function osPins(t, bits) {
  const prev = t.prevIn || '00000000';
  const pressed = [];
  for (let i = 0; i < OS_PINS.length; i++) {
    const name = OS_PINS[i];
    const rose = bits[i] === '1' && prev[i] === '0';
    const powerFell = name === 'power' && POWER_ON_FALLING_EDGE && bits[i] === '0' && prev[i] === '1';
    if (rose || powerFell) pressed.push(name);
  }
  if (pressed.length > 1) {
    noteAction(t, 'OS ignored simultaneous buttons: ' + pressed.join(' + '));
    return false;
  }
  if (pressed.length === 1) return osKey(t, pressed[0]);
  return false;
}

// ---- keyboard (letters, space, . - /, backspace, enter) ----

// Put one character into whichever app is open. Returns false if the app takes no text.
function textInput(t, ch) {
  const os = t.os;
  if (os.app === 'term') {
    const tm = os.term;
    if (tm.out !== null) { tm.out = null; tm.buf = ''; tm.page = 0; }
    tm.histIdx = -1;
    if (tm.buf.length < TERM_MAX) tm.buf += ch;
    return true;
  }
  if (os.app === 'edit') {
    const ed = os.editor;
    if (ed.saveAs !== null) {
      if (/^[a-z0-9._\/ -]$/.test(ch) && ed.saveAs.length < 40) ed.saveAs += (ch === ' ' ? '-' : ch);
      return true;
    }
    ed.notice = '';
    ed.scroll = null;
    if (ed.text.length < EDITOR_MAX) { ed.text += ch; ed.dirty = true; }
    return true;
  }
  if (os.app === 'ai') {
    const ai = os.ai;
    if (t.chatBusy) return false;                     // wait for the answer
    if (ai.shown) { ai.shown = false; ai.text = ''; ai.draft = ''; }
    ai.notice = '';
    if (ai.draft.length < AI_DRAFT_MAX) ai.draft += ch;
    return true;
  }
  if (os.app === 'games') { gameChar(t, ch); return true; }
  if (os.app === 'menu') {                            // a letter jumps to the next app starting with it
    for (let i = 1; i <= APPS.length; i++) {
      const idx = (os.cursor + i) % APPS.length;
      if (APPS[idx].name.startsWith(ch)) { os.cursor = idx; break; }
    }
    return true;
  }
  if (os.app === 'clok' || os.app === 'dice') return true;   // letters are accepted, they just do nothing
  if (os.app === 'files') {
    const fm = os.files;
    if (fm.newName !== null) {
      if (/^[a-z0-9._\/ -]$/.test(ch) && fm.newName.length < 40) fm.newName += (ch === ' ' ? '-' : ch);
      return true;
    }
    fm.notice = '';
    const list = fmEntries(t);                        // jump to the next name starting with ch
    for (let i = 1; i <= list.length; i++) {
      const idx = (fm.cursor + i) % list.length;
      if (list[idx].name.startsWith(ch)) { fm.cursor = idx; break; }
    }
    return true;
  }
  return false;
}

function keyboardChar(t, ch) {
  const label = ch === ' ' ? 'space' : ch;
  if (!t.os.power || t.mode !== 'os') {
    noteAction(t, 'keyboard ' + label + ' ignored (OS off or not in OS mode)');
    return false;
  }
  if (!textInput(t, ch)) {
    noteAction(t, 'keyboard ' + label + ' ignored (' + (t.chatBusy ? 'ai is thinking' : 'open terminal, text edit, files or ai chat') + ')');
    return false;
  }
  t.os.lastKey = label;
  t.lastKeyboardKey = label;
  redrawOS(t);
  noteAction(t, 'keyboard key ' + label + ' (' + t.os.app + ')');
  return true;
}

function keyboardBackspace(t) {
  if (!t.os.power || t.mode !== 'os') {
    noteAction(t, 'keyboard BACKSPACE ignored (OS off or not in OS mode)');
    return false;
  }
  const os = t.os;
  const ok = ['term', 'edit', 'ai', 'files'].includes(os.app)
    && !(os.app === 'ai' && t.chatBusy)
    && !(os.app === 'files' && os.files.newName === null);
  if (!ok) { noteAction(t, 'keyboard BACKSPACE ignored (' + os.app + ')'); return false; }
  appKey(t, 'fn2');                                   // FN2 is backspace in every text app
  os.lastKey = 'backspace';
  t.lastKeyboardKey = 'BACKSPACE';
  redrawOS(t);
  noteAction(t, 'keyboard BACKSPACE (' + os.app + ')');
  return true;
}

// The dedicated Enter key has app-specific behavior.
function keyboardEnter(t) {
  if (!t.os.power || t.mode !== 'os') {
    noteAction(t, 'keyboard ENTER ignored (OS off or not in OS mode)');
    return false;
  }
  const os = t.os;
  os.lastKey = 'enter';
  t.lastKeyboardKey = 'ENTER';

  // ENTER is also the confirm key on the app menu. It was previously ignored there.
  if (os.app === 'menu') {
    menuKey(t, 'select');
    redrawOS(t);
    noteAction(t, 'keyboard ENTER opened ' + os.app);
    return true;
  }
  if (os.app === 'games') {
    gamesEnter(t);
    redrawOS(t);
    noteAction(t, 'keyboard ENTER (games)');
    return true;
  }
  if (os.app === 'clok' || os.app === 'dice') {
    appKey(t, 'select');
    redrawOS(t);
    noteAction(t, 'keyboard ENTER (' + os.app + ')');
    return true;
  }

  if (os.app === 'term') {
    runCommand(t);
    if (t.os.power) redrawOS(t); // 'off' must leave the clear frame intact
    noteAction(t, 'keyboard ENTER ran terminal command');
    return true;
  }

  if (os.app === 'edit') {
    const ed = os.editor;
    if (ed.saveAs !== null) {
      editorConfirmName(t);
    } else {
      ed.notice = '';
      ed.scroll = null;
      if (ed.text.length < EDITOR_MAX) { ed.text += '\n'; ed.dirty = true; }
    }
    redrawOS(t);
    noteAction(t, 'keyboard ENTER (text edit)');
    return true;
  }

  if (os.app === 'files') {
    if (os.files.newName !== null) fmCreate(t);
    else { os.files.notice = ''; fmOpen(t); }
    redrawOS(t);
    noteAction(t, 'keyboard ENTER (files)');
    return true;
  }

  if (os.app === 'ai') {
    const ai = os.ai;
    if (t.chatBusy) { noteAction(t, 'AI ENTER ignored (still working)'); return false; }
    const message = normalizeText(ai.draft).trim().slice(0, MAX_INPUT_CHARS);
    if (!message) { noteAction(t, 'AI ENTER ignored (empty message)'); return false; }
    if (!groqKey) {
      ai.notice = 'no groq key: save one on the web page';
      redrawOS(t);
      noteAction(t, 'AI ENTER ignored (no Groq key)');
      return false;
    }
    runOsChat(t, message).catch((e) => noteAction(t, 'AI chat crashed: ' + e.message));
    noteAction(t, 'keyboard ENTER sent AI message');
    return true;
  }

  noteAction(t, 'keyboard ENTER ignored (no text input in ' + os.app + ')');
  return false;
}

function normalizeKeyboardKey(key) {
  const value = String(key ?? '').trim().toLowerCase();
  if (value === 'return' || value === 'confirm' || value === 'submit') return 'enter';
  return value;
}

function dispatchKeyboardKey(t, key) {
  key = normalizeKeyboardKey(key);
  if (key === 'enter') return keyboardEnter(t);
  if (key === 'backspace') return keyboardBackspace(t);
  return keyboardChar(t, Object.prototype.hasOwnProperty.call(KEY_CHARS, key) ? KEY_CHARS[key] : key);
}

loadStore();

// Optional individual endpoints accept JSON booleans, 1/0, or true/false text.
function toPressedBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (/^[01]{1,8}$/.test(v)) return v.includes('1');
    if (['1', 'true', 'pressed', 'on'].includes(v)) return true;
    if (['0', 'false', 'released', 'off'].includes(v)) return false;
  }
  return null;
}

function readPressed(req) {
  let raw = req.body;
  if (typeof raw === 'string') {
    const body = raw.trim();
    try { raw = JSON.parse(body); } catch (_) {
      const form = new URLSearchParams(body);
      raw = form.has('pressed') ? form.get('pressed') : body;
    }
  }
  if (raw && typeof raw === 'object') {
    if (raw.pressed !== undefined) return toPressedBoolean(raw.pressed);
    if (raw.value !== undefined) return toPressedBoolean(raw.value);
  }
  if (req.query.pressed !== undefined) return toPressedBoolean(req.query.pressed);
  if (req.query.value !== undefined) return toPressedBoolean(req.query.value);
  return toPressedBoolean(raw);
}

function inputPanel(req, res) {
  const password = givenPassword(req);
  if (!password) {
    // Keep the HTTP Transmitter response contract valid even on an auth error.
    res.status(403).json({ value: '00000000', error: 'Send the same pass header as the display transmitter.' });
    return null;
  }
  if (password.length > MAX_PASSWORD_CHARS) {
    res.status(400).json({ value: '00000000', error: 'Password too long (max ' + MAX_PASSWORD_CHARS + ' characters).' });
    return null;
  }
  return getTransmitter(password);
}

// KEYBOARD INPUT ROUTES
// Accept POST (recommended) and GET (compatibility). They return the idle placeholder
// value=00000000; only /out supplies real display frames.
function handleKeyboardEndpoint(req, res, routeName) {
  const t = inputPanel(req, res);
  if (!t) return;

  const name = normalizeKeyboardKey(routeName);
  // Keep endpoint handling safe even if a transmitter object was created by older code.
  if (!(t.keyBankLastFire instanceof Map)) t.keyBankLastFire = new Map();
  if (!(t.directKeyLastFire instanceof Map)) t.directKeyLastFire = new Map();
  const bank = KEY_BANKS.find((item) => item.id === name);

  if (bank) {
    const bits = readInputBits(req);
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null);
    t.lastKeyboardRequest = {
      endpoint: '/keys/' + bank.id,
      method: req.method,
      contentType: req.headers['content-type'] || '(none)',
      rawBody: String(rawBody || '').slice(0, 300),
      query: req.originalUrl.includes('?') ? req.originalUrl.split('?').slice(1).join('?') : '',
      parsedBits: bits,
      receivedAt: new Date().toISOString(),
    };
    console.log('[keyboard ' + bank.id + '] ' + JSON.stringify(t.lastKeyboardRequest));

    if (bits === null) {
      noteAction(t, 'keyboard bank ' + bank.id + ' received unrecognized input format');
      return res.status(200).json({ value: '00000000' });
    }

    const prev = t.keyBankPrev.get(bank.id) || '00000000';
    const rising = [];
    for (let i = 0; i < 8; i++) {
      if (bits[i] === '1' && prev[i] === '0' && bank.keys[i]) rising.push(bank.keys[i]);
    }
    t.keyBankPrev.set(bank.id, bits);

    if (rising.length >= 1) {
      for (const k of rising) {                       // every new key is typed, in pin order
        dispatchKeyboardKey(t, k);
        t.keyBankLastFire.set(bank.id + ':' + k, Date.now());
      }
    } else {
      // Enter-only repeat fallback: handles transmitters that never POST the all-zero
      // release state. Normal zero->one presses still work immediately.
      const enterIndex = bank.keys.indexOf('enter');
      if (enterIndex >= 0 && bits[enterIndex] === '1' && prev[enterIndex] === '1') {
        const fireKey = bank.id + ':enter';
        const lastFire = t.keyBankLastFire.get(fireKey) || 0;
        if (Date.now() - lastFire >= ENTER_REPEAT_MS) {
          dispatchKeyboardKey(t, 'enter');
          t.keyBankLastFire.set(fireKey, Date.now());
        }
      }
    }
    return res.status(200).json({ value: '00000000' });
  }

  // Also support /keys/a ... /keys/z, /keys/enter, /keys/space, /keys/backspace, /keys/dot ...
  if (/^(?:[a-z]|enter|space|backspace|dot|dash|slash)$/.test(name)) {
    const pressed = readPressed(req);
    if (pressed === null) {
      return res.status(400).json({
        value: '00000000',
        error: 'For a single-key endpoint send {"pressed":true} on press and {"pressed":false} on release.'
      });
    }
    const prev = t.directKeyPrev.get(name) || false;
    t.directKeyPrev.set(name, pressed);
    if (pressed && !prev) {
      dispatchKeyboardKey(t, name);
      t.directKeyLastFire.set(name, Date.now());
    } else if (pressed && prev && name === 'enter') {
      const lastFire = t.directKeyLastFire.get(name) || 0;
      if (Date.now() - lastFire >= ENTER_REPEAT_MS) {
        dispatchKeyboardKey(t, name);
        t.directKeyLastFire.set(name, Date.now());
      }
    }
    return res.status(200).json({ value: '00000000' });
  }

  return res.status(404).json({
    value: '00000000',
    error: 'Unknown keyboard endpoint. Use /keys/1 through /keys/4, or /key/a through /key/z, /key/enter, /key/space, /key/backspace.'
  });
}

// Four 8-pin banks: /keys/1 ... /keys/4 (POST preferred; GET also accepted).
app.all(['/keys/:name', '/keyboard/:name'], (req, res) => {
  handleKeyboardEndpoint(req, res, req.params.name);
});

// Individual input endpoints: /key/a ... /key/z, /key/enter and /letter/a ... /letter/enter.
app.all(['/key/:key', '/letter/:key'], (req, res) => {
  handleKeyboardEndpoint(req, res, req.params.key);
});

// ======================= API FOR THE WEB PAGE =======================

const n = (v, max) => Math.max(0, Math.min(max, Number(v) | 0));

app.post('/api/key', async (req, res) => {
  const key = String(req.body.key || '').trim();

  if (!key) {
    groqKey = '';
    for (const t of transmitters.values()) clearHistory(t); // forgetting the key forgets every conversation
    return res.json({ ok: true, key: false, message: 'Key forgotten. Every AI panel is locked.' });
  }
  if (key.length < 20) {
    return res.status(400).json({ error: 'That does not look like a Groq key (too short).' });
  }

  try {
    const r = await fetch(GROQ_MODELS_URL, {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('Groq said ' + r.status);
  } catch (e) {
    return res.status(400).json({ error: 'Key check failed: ' + e.message });
  }

  groqKey = key;
  res.json({ ok: true, key: true, message: 'Key set — every panel on this server is unlocked.' });
});

app.get('/api/prompt', (req, res) => {
  const t = req.transmitter;
  res.json({
    custom: t.customPrompt !== null,
    prompt: t.customPrompt !== null ? t.customPrompt : DEFAULT_PERSONA.trim(),
    defaultPrompt: DEFAULT_PERSONA.trim(),
    appendRules: t.appendRules,
    rules: PANEL_RULES,
    maxChars: MAX_PROMPT_CHARS,
  });
});

app.post('/api/prompt', (req, res) => {
  const t = req.transmitter;
  const prompt = String(req.body.prompt || '').trim();
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: 'Prompt too long (max ' + MAX_PROMPT_CHARS + ' characters).' });
  }
  if (req.body.appendRules !== undefined) t.appendRules = !!req.body.appendRules;

  t.customPrompt = prompt ? prompt : null;
  if (t.customPrompt === null) t.appendRules = true;
  clearHistory(t);

  res.json({
    ok: true,
    custom: t.customPrompt !== null,
    appendRules: t.appendRules,
    message: t.customPrompt !== null
      ? 'Prompt saved for this transmitter. New conversation started.'
      : 'Back to the default prompt. New conversation started.',
  });
});

app.post('/api/chat', async (req, res) => {
  const t = req.transmitter;
  if (!requireKey(res)) return;

  if (t.mode === 'os') {
    // OS mode: only works while the "ai chat" app is open on the panel.
    if (!t.os.power) {
      return res.status(409).json({ error: 'The OS is off. Turn it on first (pin 1 / the On/off button).' });
    }
    if (t.os.app !== 'ai') {
      return res.status(409).json({ error: 'Open the "ai chat" app first: menu → ai chat → select.' });
    }
    if (t.chatBusy) return res.status(429).json({ error: 'Still working on the previous message.' });

    const message = normalizeText(req.body.message || '').trim().slice(0, MAX_INPUT_CHARS);
    if (!message) return res.status(400).json({ error: 'Type a message first.' });

    const result = await runOsChat(t, message);
    if (result.error) return res.status(502).json({ error: result.error });
    if (result.interrupted) {
      return res.json({ reply: '(interrupted)', interrupted: true, queued: t.queue.length, memory: t.history.length / 2 });
    }
    return res.json({ reply: result.reply, queued: t.queue.length, memory: t.history.length / 2 });
  }

  // AI mode.
  if (t.chatBusy) return res.status(429).json({ error: 'Still working on the previous message.' });

  const message = normalizeText(req.body.message || '').trim().slice(0, MAX_INPUT_CHARS);
  if (!message) return res.status(400).json({ error: 'Type a message first.' });

  let result;
  try {
    result = await runChat(t, message);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
  if (result.interrupted) {
    return res.json({
      reply: '(interrupted)',
      interrupted: true,
      queued: t.queue.length,
      memory: t.history.length / 2,
    });
  }

  res.json({ reply: result.reply, queued: t.queue.length, memory: t.history.length / 2 });
});

app.post('/api/interrupt', (req, res) => {
  interruptResponse(req.transmitter);
  res.json({ ok: true, queued: req.transmitter.queue.length });
});

app.post('/api/redo', (req, res) => {
  if (!requireKey(res)) return;
  redoResponse(req.transmitter);
  res.json({ ok: true, action: req.transmitter.lastAction });
});

app.post('/api/memory/clear', (req, res) => {
  clearHistory(req.transmitter);
  res.json({ ok: true, memory: 0 });
});

// ---- Simulated OS ----

// Switch this transmitter between the AI text sender and the simulated OS.
app.post('/api/os/mode', (req, res) => {
  const t = req.transmitter;
  const mode = req.body.mode === 'os' ? 'os' : 'ai';
  abandonChat(t);
  t.mode = mode;
  t.prevIn = null;   // fresh edge detection for the new mode
  t.queue = [];
  if (mode === 'os' && t.os.power) redrawOS(t);
  else t.queue.push(...clearFrames());
  noteAction(t, 'mode: ' + mode);
  res.json({ ok: true, mode });
});

// Press an OS key from the page (same as the matching pin from the game).
app.post('/api/os/key', (req, res) => {
  const t = req.transmitter;
  const key = normalizeKeyboardKey(req.body.key || '');
  if (!OS_PINS.includes(key) && !WEB_KEYBOARD_KEYS.has(key)) return res.status(400).json({ error: 'Unknown key.' });
  if (t.mode !== 'os') return res.status(409).json({ error: 'Switch this transmitter to OS mode first.' });
  if (WEB_KEYBOARD_KEYS.has(key)) dispatchKeyboardKey(t, key);
  else osKey(t, key);
  res.json({ ok: true, power: t.os.power, screen: t.os.screen });
});

app.post('/api/text', (req, res) => {
  const t = req.transmitter;
  if (!requireKey(res)) return;
  const text = String(req.body.text || '').replace(/\uFE0F/g, '').replace(/[\r\n]/g, ' ');
  if (CLEAR_BEFORE_TEXT) t.queue.push(...clearFrames());
  t.queue.push(...buildFrames(t, Array.from(text).slice(0, 200).map(encode)));
  res.json({ queued: t.queue.length });
});

app.post('/api/clear', (req, res) => {
  const t = req.transmitter;
  if (!requireKey(res)) return;
  t.lastUserMessage = ''; // REDO does nothing until a new message is sent
  abandonChat(t);
  // A clear command must replace pending output, not wait behind it.
  t.queue = clearFrames();
  t.held = null;
  res.json({ queued: t.queue.length });
});

app.post('/api/code', (req, res) => {
  const t = req.transmitter;
  if (!requireKey(res)) return;
  t.queue.push(...buildFrames(t, [n(req.body.code, 127)]));
  res.json({ queued: t.queue.length });
});

app.post('/api/sweep', (req, res) => {
  const t = req.transmitter;
  if (!requireKey(res)) return;
  const from = n(req.body.from, 127);
  const to = Math.max(from, n(req.body.to, 127));
  const codes = [];
  for (let c = from; c <= to; c++) codes.push(c);
  t.queue.push(...buildFrames(t, codes));
  res.json({ queued: t.queue.length });
});

app.post('/api/hold', (req, res) => {
  const t = req.transmitter;
  if (!requireKey(res)) return;
  const v = String(req.body.value || '');
  if (!/^[01]{8}$/.test(v)) return res.status(400).json({ error: 'need exactly 8 bits' });
  t.held = v;
  res.json({ held: t.held });
});

app.post('/api/release', (req, res) => {
  req.transmitter.held = null;
  res.json({ held: null });
});

app.post('/api/cancel', (req, res) => {
  const t = req.transmitter;
  abandonChat(t); // also drops an answer that is still being written
  t.queue = [];
  t.held = null;
  res.json({ queued: 0 });
});

app.get('/api/status', (req, res) => {
  const t = req.transmitter;
  const fsInfo = fsStats(fsRoot(t));
  res.json({
    key: !!groqKey,
    mode: t.mode,
    os: { power: t.os.power, app: t.os.app, screen: t.os.screen, lastKey: t.os.lastKey, aiShown: t.os.ai.shown },
    fs: { nodes: fsInfo.nodes, chars: fsInfo.chars, file: DATA_FILE },
    model: GROQ_MODEL,
    prompt: t.customPrompt !== null ? 'custom' : 'default',
    memory: t.history.length / 2,
    memoryMax: MAX_HISTORY_TURNS,
    polls: pollStats(t),
    sent: t.sentLog.join(''),
    queued: t.queue.length,
    code: t.last.code,
    clear: t.last.clear,
    value: t.held !== null ? t.held : toValue(t.last),
    input: t.lastIn,
    keyboard: t.lastKeyboardRequest,
    lastKeyboardKey: t.lastKeyboardKey,
    raw: t.lastRaw || '',
    action: t.lastAction,
    glyph: t.held !== null ? 'HELD (test)' : t.last.clear ? 'CLEAR SCREEN' : glyph(t.last.code),
    transmitter: {
      count: transmitters.size,
      lastPollAt: t.lastPollAt || null,
      lastPollAgoMs: t.lastPollAt ? Date.now() - t.lastPollAt : null,
      createdAt: t.createdAt,
      outRejected: t.outRejected,
      outLastOk: t.outLastOk,
    },
  });
});

// ======================= THE CONTROL PAGE =======================

const PAGE = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Panel Text</title>
<style>
  body { font-family: system-ui, sans-serif; background:#111; color:#eee; max-width:520px; margin:0 auto; padding:1.5rem; }
  section { background:#1c1c1c; border-radius:12px; padding:1rem; margin-bottom:1rem; }
  h1 { font-size:1.4rem; }
  h2 { margin:0 0 .75rem; font-size:1.05rem; }
  input, button, textarea { font-size:1rem; padding:.5rem .7rem; border-radius:8px; border:0; margin:.2rem; }
  input[type=text], input[type=password] { width:65%; }
  input[type=number] { width:4.5rem; }
  input[type=checkbox] { width:auto; margin:.2rem .4rem .2rem 0; vertical-align:middle; }
  textarea { width:calc(100% - .4rem); box-sizing:border-box; min-height:7rem; resize:vertical; font-family:inherit; background:#fff; color:#111; }
  textarea.dict { min-height:3.2rem; font-family:monospace; font-size:.95rem; }
  button { background:#2d6cdf; color:#fff; cursor:pointer; }
  button.gray { background:#444; }
  button:disabled { background:#2a2a2a; color:#666; cursor:not-allowed; }
  label { margin-right:.6rem; white-space:nowrap; }
  label.wrap { white-space:normal; display:block; margin:.3rem 0; }
  small { color:#999; display:inline-block; margin-top:.35rem; }
  .st { font-family:monospace; font-size:.9rem; color:#9aa; line-height:1.5; }
  .locked { border:1px solid #a33; }
  .ok { color:#6c6; }
  .bad { color:#e77; }
  code { background:#333; padding:0 .25rem; border-radius:4px; }
  details { background:#1c1c1c; border-radius:12px; padding:1rem; }
  summary { cursor:pointer; font-weight:600; }
  pre.screen { background:#000; color:#7f7; font-family:monospace; font-size:1.2rem; line-height:1.3; letter-spacing:.15em; white-space:pre; padding:.6rem .8rem; border-radius:8px; margin:.4rem .2rem; min-height:3.6rem; overflow-x:auto; }
  .keys button { min-width:5.2rem; }
</style>
<h1>Panel Text</h1>

<section id="passsec" class="locked">
  <h2>1. Connect to a transmitter</h2>
  <label class="wrap">Your password — the value of the <code>${PASS_HEADER}</code> header in the game
    <input id="pass" type="password" placeholder="your password" autocomplete="off">
  </label>
  <button id="connectbtn" onclick="connect()">Connect</button>
  <button class="gray" onclick="genPass()">Generate</button>
  <button class="gray" onclick="disconnect()">Disconnect</button>
  <small>Type the same password you put in your in-game HTTP Transmitter. A new password creates a new transmitter (a separate panel) with its own saved files; typing an existing one goes back to it. Each password has its own queue, conversation, prompt, OS and filesystem. Each browser tab remembers its own password, so open a second tab for a second panel.</small>
  <div class="st">Headers dictionary for the game's HTTP Transmitter:</div>
  <textarea id="dict" class="dict" readonly spellcheck="false" placeholder='{"pass":"your-password"}'></textarea>
  <button class="gray" onclick="copyDict()">Copy dictionary</button>
  <div class="st" id="passst">not connected</div>
</section>

<section id="keysec" class="locked">
  <h2>2. Groq API key (AI mode + ai chat)</h2>
  <input id="key" type="password" placeholder="gsk_..." autocomplete="off">
  <button onclick="saveKey()">Save key</button>
  <button class="gray" onclick="forgetKey()">Forget key</button>
  <small>Get one at console.groq.com/keys. It is kept in the server's memory only (lost on restart), and is shared by every transmitter on this server. Needed by AI mode and by the OS "ai chat" app. The rest of the simulated OS does not need it. You can also start the server with GROQ_API_KEY=gsk_... so the key is loaded automatically.</small>
  <div class="st" id="keyst">not connected</div>
</section>

<section id="chatsec" class="locked">
  <h2>3. Message</h2>
  <input id="msg" type="text" placeholder="Say something..." autocomplete="off">
  <button id="sendbtn" class="needs-key" onclick="sendMsg()">Send</button>
  <button class="gray" onclick="clearMemory()">New conversation</button>
  <small><b>AI mode:</b> the panel shows your message first, then the reply.<br>
  <b>OS mode:</b> open the <b>ai chat</b> app on the panel first (menu → ai chat → select), then send from here, or just type on the keyboard and press ENTER.</small>
  <div class="st" id="reply"></div>
</section>

<section id="promptsec" class="locked">
  <h2>4. AI prompt (for this transmitter)</h2>
  <textarea id="prompt" placeholder="Describe how the AI should behave..."></textarea>
  <label class="wrap"><input id="rules" type="checkbox" checked>Add the panel rules (short answers, only characters the panel can draw)</label>
  <button onclick="savePrompt()">Save prompt</button>
  <button class="gray" onclick="resetPrompt()">Reset to default</button>
  <small>Example: You are a grumpy pirate. Answer in pirate slang. Saving starts a new conversation on this transmitter. Leave the box empty and save to go back to the default. Kept in memory only.</small>
  <div class="st" id="promptst"></div>
</section>

<section id="ossec" class="locked">
  <h2>5. Simulated OS (same password)</h2>
  <div class="st" id="osmode">mode: AI text sender</div>
  <button id="osmodebtn" onclick="toggleOsMode()">Switch to OS mode</button>
  <small>Default display transmitter: /out. Its pins are 1 on/off, 2 down, 3 up, 4 select, 5 FN1, 6 FN2, and optional pin 7 ENTER. The four extra keyboard transmitters POST to /keys/1 through /keys/4 and never receive display output. All five use the same pass header.</small>
  <pre class="screen" id="osscreen">(AI mode)</pre>
  <div class="keys">
    <button onclick="osKey('power')">On/off (1)</button>
    <button onclick="osKey('down')">Down (2)</button>
    <button onclick="osKey('up')">Up (3)</button><br>
    <button onclick="osKey('select')">Select (4)</button>
    <button onclick="osKey('fn1')">FN1 (5)</button>
    <button onclick="osKey('fn2')">FN2 (6)</button><br>
    <button onclick="osKey('enter')">Keyboard Enter</button>
    <button onclick="osKey('space')">Keyboard Space</button>
    <button onclick="osKey('backspace')">Backspace</button>
  </div>
  <div class="st" id="osst"></div>
  <div class="st" id="ospins"></div>
  <div class="st" id="osfs"></div>
  <small>Keyboard pins (leftmost bit = pin 1): /keys/1 = A-H, /keys/2 = I-P, /keys/3 = Q-X, /keys/4 = Y, Z, ENTER, SPACE, BACKSPACE, dot, dash, slash on pins 1-8. Example POST body: {&quot;value&quot;:&quot;10000000&quot;}; POST all-zero bits on release. Use the same pass header as the default transmitter. Optional individual POST paths: /key/a ... /key/z, /key/enter (also /key/return), /key/space, /key/backspace, /key/dot, /key/dash, /key/slash with {&quot;pressed&quot;:true/false}. Only /out returns panel frames.<br><br>
  <b>Menu:</b> UP/FN1 previous app, DOWN/FN2 next app, SELECT or ENTER opens. ENTER works from /keys/4 pin 3 or optional main-transmitter pin 7.<br>
  <b>AI chat:</b> type with the keyboard (SPACE for spaces), ENTER sends to Groq, FN1 clears, FN2/BACKSPACE deletes, SELECT exits. Any key after an answer starts a new message; the conversation is remembered until you leave the app.<br>
  <b>Terminal:</b> type, ENTER runs. UP/DOWN browse command history, or flip pages when an answer is longer than the screen. FN1 clears the line, FN2/BACKSPACE deletes, SELECT exits. Type <code>help</code> for the list and <code>help ls</code> for a command's usage. Files: ls cd pwd cat mkdir touch rm cp mv write append edit wc head tail find grep tree df run. Others: echo time date ver about sys uptime whoami history rand roll flip add sub mul div mod pow upper reverse len clear exit off. Numbers are spelled as words (example: add five three).<br>
  <b>Text edit:</b> type, ENTER = new line, FN1 saves, FN2/BACKSPACE deletes, UP/DOWN read the file page by page, SELECT saves and exits. A new document asks for a file name when you save (use / for folders).<br>
  <b>Files:</b> UP/DOWN choose, SELECT or ENTER opens a folder or a file in the editor, <code>..</code> goes up, FN1 goes back (and exits at the top), FN2 makes a new file (type the name, ENTER). Pressing a letter jumps to the next name starting with it.<br>
  <b>Games:</b> hangman (type letters), rock paper (r/p/s), high low (h/l), tic tac toe (keys q w e / a s d / z x c). Letters jump to a game, ENTER starts or restarts, SELECT goes back. FN1/FN2 never disturb a running game.<br>
  <b>Typing safety:</b> FN1 no longer clears or exits while you type. Names accept every letter, space becomes -, and / makes folders. In Files, FN1 needs two presses at the top level to exit.<br>
  <b>Clock:</b> FN1 toggles time/date, FN2 toggles 12/24-hour format. <b>Dice:</b> FN1 rolls, FN2 cycles dice type; UP/DOWN also change dice type.<br>
  <b>Saved files:</b> stored on the computer running this script (see the path below), one filesystem per password.</small>
</section>

<details>
  <summary>Manual tools</summary>
  <section>
    <h2>Text</h2>
    <input id="text" type="text" value="Hello World">
    <button class="needs-key" onclick="sendText()">Send</button><br>
    <small>The screen is cleared once, at the start of each send.</small>
  </section>

  <section>
    <h2>Single code (0-127)</h2>
    <input id="code" type="number" min="0" max="127" value="65">
    <button class="needs-key" onclick="sendCode()">Send code</button>
    <button class="gray needs-key" onclick="post('/api/clear')">Clear screen</button>
  </section>

  <section>
    <h2>Sweep</h2>
    <label>from <input id="from" type="number" min="0" max="127" value="0"></label>
    <label>to <input id="to" type="number" min="0" max="127" value="127"></label>
    <button class="needs-key" onclick="sweep()">Start sweep</button><br>
    <small>Sends every code in order. Watch the status below to see which code is on the pins.</small>
  </section>

  <section>
    <h2>Hold exact value (wiring test)</h2>
    <input id="hold" type="text" value="10000000" maxlength="8">
    <button class="needs-key" onclick="hold()">Hold</button>
    <button class="gray" onclick="post('/api/release')">Release</button><br>
    <small>Sends exactly these 8 bits, left to right, until released. The first bit should be your clear pin.</small>
  </section>

  <section>
    <h2>Control pins (test, AI mode)</h2>
    <button class="gray" onclick="post('/api/interrupt')">Interrupt</button>
    <button class="gray needs-key" onclick="post('/api/redo')">Redo</button><br>
    <small>Same as pin 1 and pin 2 of the value the game POSTs to /out.</small>
  </section>

  <button class="gray" onclick="post('/api/cancel')">Cancel queue</button>
</details>

<div class="st" id="st1"></div>
<div class="st" id="st2"></div>
<div class="st" id="st3"></div>
<div class="st" id="st4"></div>
<div class="st" id="st5"></div>
<div class="st" id="st6"></div>
<div class="st" id="st7"></div>
<div class="st" id="st8"></div>
<div class="st" id="st9"></div>

<script>
  var H = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' };
  var PASS_HEADER = '${PASS_HEADER}';
  var pass = '';
  var passSet = false;
  var keySet = false;
  var sending = false;
  var osMode = 'ai';

  function num(id) { return parseInt(document.getElementById(id).value, 10) || 0; }

  function storedPass() { try { return sessionStorage.getItem('panelPass') || ''; } catch (e) { return ''; } }
  function setStoredPass(p) {
    try { if (p) sessionStorage.setItem('panelPass', p); else sessionStorage.removeItem('panelPass'); } catch (e) {}
  }

  function passHeaders() {
    var h = {};
    for (var k in H) h[k] = H[k];
    if (pass) h[PASS_HEADER] = pass;
    return h;
  }

  function renderDict() {
    var el = document.getElementById('dict');
    if (!pass) { el.value = ''; return; }
    var d = {};
    d[PASS_HEADER] = pass;
    el.value = JSON.stringify(d);
  }

  function applyGates() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.closest('#passsec')) continue; // Connect / Generate / Disconnect / Copy always usable
      var needKey = b.classList.contains('needs-key');
      b.disabled = !passSet || (needKey && !keySet);
    }
    document.getElementById('keysec').className = (passSet && keySet) ? '' : 'locked';
    document.getElementById('chatsec').className = passSet ? '' : 'locked';
    document.getElementById('promptsec').className = passSet ? '' : 'locked';
    document.getElementById('ossec').className = passSet ? '' : 'locked';
    document.getElementById('passsec').className = passSet ? '' : 'locked';
  }

  function applyKey(on) {
    keySet = !!on;
    var box = document.getElementById('keyst');
    box.textContent = !passSet ? 'not connected (enter a password first)'
      : (keySet ? 'Key set - the AI is unlocked.' : 'No key set - AI mode and ai chat are locked (the rest of the OS still works).');
    box.className = 'st ' + (keySet && passSet ? 'ok' : 'bad');
    applyGates();
  }

  function clearStatusLines() {
    for (var i = 1; i <= 9; i++) {
      var el = document.getElementById('st' + i);
      if (el) el.textContent = '';
    }
  }

  function connect() {
    var el = document.getElementById('pass');
    var box = document.getElementById('passst');
    var p = el.value.trim();
    if (!p) { box.textContent = 'type a password'; box.className = 'st bad'; return; }
    if (p.length > 200) { box.textContent = 'password too long (max 200)'; box.className = 'st bad'; return; }
    pass = p;
    passSet = true;
    setStoredPass(p);
    el.value = '';
    renderDict();
    box.textContent = 'connected - waiting for the game to poll with this password...';
    box.className = 'st';
    applyGates();
    refresh();
    loadPrompt();
  }

  function disconnect() {
    pass = '';
    passSet = false;
    keySet = false;
    setStoredPass('');
    document.getElementById('dict').value = '';
    document.getElementById('pass').value = '';
    document.getElementById('reply').textContent = '';
    document.getElementById('prompt').value = '';
    document.getElementById('promptst').textContent = '';
    document.getElementById('osscreen').textContent = '(AI mode)';
    document.getElementById('osst').textContent = '';
    document.getElementById('osfs').textContent = '';
    clearStatusLines();
    var box = document.getElementById('passst');
    box.textContent = 'not connected';
    box.className = 'st';
    document.getElementById('keyst').textContent = 'not connected (enter a password first)';
    document.getElementById('keyst').className = 'st bad';
    applyGates();
  }

  function genPass() {
    var chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var s = '';
    for (var i = 0; i < 20; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    document.getElementById('pass').value = s;
    var box = document.getElementById('passst');
    box.textContent = 'generated - click Connect, then paste the dictionary into the game';
    box.className = 'st';
  }

  function copyDict() {
    var el = document.getElementById('dict');
    if (!el.value) return;
    el.select();
    el.setSelectionRange(0, el.value.length);
    try { navigator.clipboard.writeText(el.value); } catch (e) {}
    try { document.execCommand('copy'); } catch (e) {}
    var box = document.getElementById('passst');
    box.textContent = 'dictionary copied';
    box.className = 'st ok';
  }

  async function post(path, body) {
    var r = await fetch(path, { method: 'POST', headers: passHeaders(), body: JSON.stringify(body || {}) });
    var j = {};
    try { j = await r.json(); } catch (e) {}
    refresh();
    return j;
  }

  async function saveKey() {
    var el = document.getElementById('key');
    var k = el.value.trim();
    var box = document.getElementById('keyst');
    box.textContent = 'checking with Groq...';
    box.className = 'st';
    try {
      var r = await fetch('/api/key', { method: 'POST', headers: passHeaders(), body: JSON.stringify({ key: k }) });
      var j = await r.json();
      if (!r.ok) { box.textContent = j.error || 'key rejected'; box.className = 'st bad'; return; }
      el.value = '';
      box.textContent = j.message || 'key saved';
      box.className = 'st ok';
      refresh();
    } catch (e) {
      box.textContent = 'error: ' + e.message;
      box.className = 'st bad';
    }
  }

  async function forgetKey() {
    await post('/api/key', { key: '' });
    document.getElementById('reply').textContent = '';
  }

  async function clearMemory() {
    await post('/api/memory/clear');
    document.getElementById('reply').textContent = 'new conversation';
  }

  // ---- Simulated OS ----
  async function toggleOsMode() {
    await post('/api/os/mode', { mode: osMode === 'os' ? 'ai' : 'os' });
  }

  async function osKey(k) {
    var box = document.getElementById('osst');
    try {
      var r = await fetch('/api/os/key', { method: 'POST', headers: passHeaders(), body: JSON.stringify({ key: k }) });
      var j = {};
      try { j = await r.json(); } catch (e) {}
      box.textContent = r.ok ? 'pressed ' + k : (j.error || 'error ' + r.status);
      box.className = 'st ' + (r.ok ? 'ok' : 'bad');
    } catch (e) {
      box.textContent = 'error: ' + e.message;
      box.className = 'st bad';
    }
    refresh();
  }

  // ---- AI prompt ----
  async function loadPrompt() {
    if (!passSet) return;
    try {
      var r = await fetch('/api/prompt', { headers: passHeaders() });
      if (!r.ok) return;
      var p = await r.json();
      document.getElementById('prompt').value = p.prompt;
      document.getElementById('rules').checked = p.appendRules;
      var box = document.getElementById('promptst');
      box.textContent = p.custom ? 'Using the custom prompt for this transmitter.' : 'Using the default prompt.';
      box.className = 'st';
    } catch (e) {}
  }

  async function savePrompt() {
    var box = document.getElementById('promptst');
    box.textContent = 'saving...';
    box.className = 'st';
    try {
      var r = await fetch('/api/prompt', {
        method: 'POST',
        headers: passHeaders(),
        body: JSON.stringify({
          prompt: document.getElementById('prompt').value,
          appendRules: document.getElementById('rules').checked
        })
      });
      var j = await r.json();
      if (!r.ok) { box.textContent = j.error || 'could not save'; box.className = 'st bad'; return; }
      box.textContent = j.message;
      box.className = 'st ok';
      document.getElementById('reply').textContent = 'new conversation';
      refresh();
    } catch (e) {
      box.textContent = 'error: ' + e.message;
      box.className = 'st bad';
    }
  }

  async function resetPrompt() {
    document.getElementById('prompt').value = '';
    await savePrompt();
    loadPrompt();
  }

  async function sendMsg() {
    var box = document.getElementById('msg');
    var out = document.getElementById('reply');
    var msg = box.value.trim();
    if (!msg || !keySet || !passSet || sending) return;
    sending = true;
    var btn = document.getElementById('sendbtn');
    btn.disabled = true;
    out.textContent = 'thinking...';
    try {
      var r = await fetch('/api/chat', { method: 'POST', headers: passHeaders(), body: JSON.stringify({ message: msg }) });
      var j = await r.json();
      if (!r.ok) out.textContent = 'error: ' + (j.error || r.status);
      else { out.textContent = 'reply: ' + j.reply; box.value = ''; }
    } catch (e) {
      out.textContent = 'error: ' + e.message;
    }
    sending = false;
    applyGates();
    refresh();
  }

  function sendText() { post('/api/text', { text: document.getElementById('text').value }); }
  function sendCode() { post('/api/code', { code: num('code') }); }
  function sweep() { post('/api/sweep', { from: num('from'), to: num('to') }); }
  function hold() { post('/api/hold', { value: document.getElementById('hold').value }); }

  async function refresh() {
    if (!passSet) return;
    try {
      var r = await fetch('/api/status', { headers: passHeaders() });
      if (!r.ok) return;
      var s = await r.json();
      applyKey(s.key);

      osMode = s.mode;
      document.getElementById('osmode').textContent = s.mode === 'os'
        ? 'mode: simulated OS (pins 1-6 are keys) | I/O: ' + (s.os.power ? 'on, app: ' + s.os.app : 'off')
        : 'mode: AI text sender (pins 1-2 are interrupt / redo)';
      document.getElementById('osmodebtn').textContent = s.mode === 'os' ? 'Switch back to AI mode' : 'Switch to OS mode';
      var names = ['I/O', 'down', 'up', 'select', 'fn1', 'fn2'];
      var pinTxt = [];
      for (var q = 0; q < names.length; q++) pinTxt.push(names[q] + '=' + (s.input ? s.input.charAt(q) : '?'));
      document.getElementById('ospins').textContent = 'pins from game: ' + pinTxt.join(' ') + ' (a key only fires when its pin goes 0 to 1)';
      document.getElementById('osfs').textContent = 'saved files: ' + s.fs.nodes + ' item(s), ' + s.fs.chars + ' characters in ' + s.fs.file;
      var scr = document.getElementById('osscreen');
      if (s.mode !== 'os') scr.textContent = '(AI mode)';
      else if (!s.os.power) scr.textContent = '(power off)';
      else scr.textContent = s.os.screen || ' ';

      var box = document.getElementById('passst');
      var tr = s.transmitter;
      if (tr.lastPollAgoMs === null) {
        box.textContent = 'connected - the game has not polled with this password yet';
        box.className = 'st bad';
      } else {
        var sec = Math.round(tr.lastPollAgoMs / 1000);
        box.textContent = 'connected - game last polled ' + (sec < 1 ? 'just now' : sec + ' s ago');
        box.className = 'st ok';
      }
      document.getElementById('st1').textContent = 'model: ' + s.model + ' | prompt: ' + s.prompt + ' | queued frames: ' + s.queued;
      document.getElementById('st2').textContent = 'memory: ' + s.memory + ' / ' + s.memoryMax + ' turns (this transmitter)';
      document.getElementById('st3').textContent = 'on the pins: code ' + s.code + ' = ' + s.glyph + ' (clear bit ' + s.clear + ')';
      document.getElementById('st4').textContent = 'value: ' + s.value;
      var p = s.polls;
      document.getElementById('st5').textContent = 'polls/sec: ' + p.perSec + ' | longest gap (10 s): ' + p.maxGapMs + ' ms | last poll: ' + (p.agoMs === null ? 'none yet' : p.agoMs + ' ms ago') + ' | total: ' + p.total;
      document.getElementById('st6').textContent = 'display pollers of /out for this password: ' + (p.clients.length ? p.clients.join('  ||  ') : 'none');
      document.getElementById('st7').textContent = 'sent to panel (newest last): ' + (s.sent || '(nothing yet)');
      document.getElementById('st8').textContent = 'display input: ' + (s.input || '(nothing yet)')
        + ' | raw: ' + (s.raw ? JSON.stringify(s.raw) : '(no body)')
        + ' | keyboard: ' + (s.keyboard ? s.keyboard.endpoint + ' ' + s.keyboard.method + ' body=' + s.keyboard.rawBody + ' parsed=' + s.keyboard.parsedBits : '(no keyboard request yet)')
        + ' | last action: ' + (s.action || 'none');
      document.getElementById('st9').textContent = 'transmitters on this server: ' + tr.count + ' | this one created ' + new Date(tr.createdAt).toLocaleString();
    } catch (e) {}
  }

  document.getElementById('msg').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendMsg();
  });
  document.getElementById('pass').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') connect();
  });

  pass = storedPass();
  passSet = !!pass;
  applyGates();
  if (passSet) {
    renderDict();
    loadPrompt();
    refresh();
  }
  setInterval(refresh, 500);
</script>`;

app.get('/', (_req, res) => res.send(PAGE));

// Explain unknown paths instead of Express's generic HTML "Cannot POST" page.
app.use((req, res) => {
  console.warn('[404] ' + req.method + ' ' + req.originalUrl + ' from ' + req.ip);
  res.status(404).json({
    error: 'Endpoint not found: ' + req.method + ' ' + req.path,
    displayEndpoint: 'GET or POST /out',
    keyboardBanks: 'POST (or GET) /keys/1 through /keys/4',
    individualKeys: 'POST (or GET) /key/a through /key/z, /key/enter, /key/space, /key/backspace'
  });
});

app.listen(PORT, () => {
  const dictionary = JSON.stringify({ [PASS_HEADER]: '<your-password>' });
  console.log('Panel page: http://localhost:' + PORT + '/');
  console.log('Default display transmitter: /out (GET or POST; the only endpoint that returns display frames).');
  console.log('Auxiliary keyboard transmitters: /keys/1 through /keys/4 (POST recommended; GET also accepted; no display output).');
  console.log('Individual-key aliases: /key/a ... /key/z, /key/enter, /key/space, /key/backspace, /key/dot, /key/dash, /key/slash.');
  console.log('Hardware count: 1 display + 4 keyboard = 5 total.');
  console.log('  Set this header on your HTTP Transmitter:  ' + PASS_HEADER + ': <your-password>');
  console.log('  Headers dictionary:  ' + dictionary);
  console.log('  Use the SAME pass value on the display transmitter and all four keyboard transmitters.');
  console.log('  Different pass values still create separate panels (each with its own saved files).');
  console.log('  The page itself is open. Type the same password into it to control that panel.');
  console.log('  Simulated OS: switch a panel to OS mode in section 5 of the page.');
  console.log('  Saved files live in: ' + DATA_FILE);
  console.log(groqKey ? 'Groq key loaded from GROQ_API_KEY (shared by all transmitters).' : 'No Groq key yet - set one on the page (AI mode + ai chat only; the rest of the OS does not need it).');
  console.log(INITIAL_PROMPT !== null ? 'New transmitters start with the PANEL_PROMPT prompt.' : 'New transmitters start with the default prompt (change it per panel on the page).');
});
