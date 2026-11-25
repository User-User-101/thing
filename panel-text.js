// Groq-powered panel sender + simulated OS with a separate POST-only keyboard.
//
// DISPLAY TRANSMITTER (the only transmitter that receives display output):
//   URL:    https://YOUR-TUNNEL-URL/out
//   Method: GET or POST (existing behavior)
//   Header: {"pass":"YOUR_PANEL_PASSWORD"}
//   This transmitter alone receives {"value":"........"} display frames.
//
// FOUR AUXILIARY KEYBOARD TRANSMITTERS (POST only; no display output is returned):
//   /keys/1  pins 1-8 = A B C D E F G H
//   /keys/2  pins 1-8 = I J K L M N O P
//   /keys/3  pins 1-8 = Q R S T U V W X
//   /keys/4  pin 1 = Y, pin 2 = Z, pin 3 = ENTER (pins 4-8 unused)
// Each key is an independent input pin. Send the current 8-pin state in a POST body,
// e.g. {"value":"10000000"}; also POST the released 0 state before pressing it again.
// The server reacts only to 0 -> 1 transitions.
// All four keyboard transmitters use the SAME pass header as the display transmitter,
// so every key controls that panel's currently open OS application. Their responses
// are HTTP 204 with no body: they never return display frames.
//
// There are also individual POST endpoints /key/a through /key/z and /key/enter.
// These accept {"pressed":true/false}, or an 8-bit value with any pin high on press. They are
// an optional one-key-per-transmitter alternative; the four pin banks are the efficient
// setup and require only four auxiliary transmitters. If you choose the individual
// one-key endpoints literally (one device/URL per letter plus Enter), that is 27 input
// transmitters plus the display transmitter = 28 total.
//
// RECOMMENDED TOTAL: 1 display transmitter + 4 keyboard banks = 5 transmitters.
// The server accepts the alphabet/Enter keys only while the default panel is in OS
// mode and powered on. Text is routed to the open terminal, text editor, or AI chat app.
//
// FN1 and FN2 now have app-specific actions; they are no longer used as a shared
// character picker. See the OS section and the web page for each app's key meanings.
//
// Setup:
//   npm install express
//   node panel-text-keyboard.js                 (Node 18+ required; uses fetch)
//   or: GROQ_API_KEY=gsk_... node panel-text-keyboard.js
//   cloudflared tunnel --url http://localhost:3000   (or ngrok http 3000)
//
// Existing AI text sender, Groq prompt, output encoding and display queue are retained.
// Output format: X S C5 C4 C3 C2 C1 C0; clear='10000000', idle='00000000'.

const express = require('express');

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
// this as its screen width. 16 = a grid of 16 characters per row (16 rows). If that is wrong: send "abcdefghijklmnop" from Manual tools,
// count the letters on the first row, and put that number here.
const CHARS_PER_ROW = 16;

// If your in-game panel has a code that moves the cursor to the next line,
// put it here (0-127) and padding is skipped. Leave null otherwise.
// The fast circuit uses 127 (all seven code pins high = new line): set NEWLINE_CODE = 127.
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

// Set true if a PRESSED button reads as 0 instead of 1 (active-low wiring). The pins
// are inverted after padding, so a press still shows up as a 0 -> 1 rising edge.
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

// ======================= TRANSMITTERS =======================
//
// One transmitter per distinct "pass" header value.

const transmitters = new Map(); // password -> transmitter
const TRANSMITTER_IDLE_MS = 12 * 60 * 60 * 1000; // drop transmitters untouched for 12 h

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
    lastKeyboardKey: '',
    lastRaw: '',                     // what the game sent, for diagnostics
    lastAction: '',

    // ---- mode: 'ai' (Groq text sender) or 'os' (simulated OS) ----
    mode: DEFAULT_MODE,
    os: makeOS(),

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

// Pull the 8-bit string out of the request. Accepts {"value":"00000000"} as a JSON
// body (whatever the Content-Type), a bare 8-bit body, or ?value=... in the URL.
function readInputBits(req) {
  let v;
  const raw = req.body;
  const pick = (obj) => {
    if (!obj || typeof obj !== 'object') return undefined;
    return obj.value ?? obj.bits ?? obj.input ?? obj.pins;
  };

  if (raw && typeof raw === 'object') {
    v = pick(raw);
  } else if (typeof raw === 'string' && raw.trim()) {
    const body = raw.trim();
    try {
      const parsed = JSON.parse(body);
      v = parsed && typeof parsed === 'object' ? pick(parsed) : parsed;
    } catch (e) {
      // Build Logic may POST form data (value=...) or a bare bit string.
      try {
        const params = new URLSearchParams(body);
        v = params.get('value') ?? params.get('bits') ?? params.get('input') ?? params.get('pins');
      } catch (_) {}
      if (v === undefined || v === null) {
        const named = body.match(/(?:value|bits|input|pins)\s*[:=]\s*[\"']?([01]{1,8})/i);
        if (named) v = named[1];
        else if (/^[01]{1,8}$/.test(body)) v = body;
        else {
          const embedded = body.match(/(?:^|[^0-9])([01]{6,8})(?:$|[^0-9])/);
          v = embedded ? embedded[1] : undefined;
        }
      }
    }
  }

  if (v === undefined || v === null) {
    v = req.query.value ?? req.query.bits ?? req.query.input ?? req.query.pins;
  }
  if (v === undefined || v === null) return null;

  let s;
  // If the transmitter sends a JSON number, interpret it as an 8-bit value.
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v <= 255) {
    s = v.toString(2).padStart(8, '0');
  } else {
    s = String(v).trim();
    if (!/^[01]{1,8}$/.test(s)) return null;
    // Text bit strings are left-to-right pin states (pin 1 is the first bit).
    s = s.padEnd(8, '0');
  }

  if (PINS_ACTIVE_LOW) s = s.replace(/[01]/g, (b) => (b === '0' ? '1' : '0'));
  return REVERSE_BITS ? s.split('').reverse().join('') : s;
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
    // interpret this as a falling-edge press. This re-arms every key so the same
    // physical button can be pressed again on the next POST.
    t.prevIn = '00000000';
    t.lastIn = '00000000';
  }

  if (t.held !== null) return res.json({ value: t.held });

  // A transmitter POST both delivers the button state and receives the next display
  // frame. Do not send the clear pulse in that same response: some transmitter setups
  // apply the response before their button-state update has settled. Return one idle
  // frame for the input poll, leaving the clear + redraw sequence at the front of the
  // queue for the NEXT poll. The web-page buttons already use a separate request and
  // therefore continue to receive the clear frame on their next normal poll.
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
function finalizeReply(text) {
  let t = cleanReply(text);
  if (t.length <= REPLY_HARD_CHARS) return t;
  let cut = t.slice(0, REPLY_HARD_CHARS);
  const space = cut.lastIndexOf(' ');
  if (space > 0) cut = cut.slice(0, space);
  return cut.trim();
}

function currentSystemPrompt(t) {
  const persona = t.customPrompt !== null ? t.customPrompt : DEFAULT_PERSONA;
  if (t.customPrompt === null || t.appendRules) return persona.trim() + ' ' + PANEL_RULES;
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

async function askGroq(t, message, hist = t.history) {
  const base = [
    { role: 'system', content: currentSystemPrompt(t) },
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
    const clean = finalizeReply(content);

    const cutByTokens = finishReason === 'length';
    const tooLong = clean.length > REPLY_HARD_CHARS || content.length > REPLY_HARD_CHARS;

    if (!cutByTokens && !tooLong && clean) {
      return clean; // complete and within bounds
    }

    if (attempts === RETRY_LIMIT) break;
    attempts++;

    messages = [
      ...base,
      { role: 'assistant', content: content || '(no visible text)' },
      { role: 'user', content: SHORTEN_PROMPT },
    ];

    if (cutByTokens) {
      messages.push({ role: 'user', content: 'Use very few words so the whole answer fits.' });
    }
  }

  const clean = finalizeReply(lastContent);
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

// Ask the AI for the OS "ai chat" app: puts the reply + hint on the panel.
async function runOsChat(t, message) {
  const myGen = ++t.chatGen;
  t.chatBusy = true;
  let reply;
  try {
    reply = await askGroq(t, message);
  } finally {
    if (myGen === t.chatGen) t.chatBusy = false;
  }
  if (myGen !== t.chatGen) return { interrupted: true };
  if (t.mode !== 'os' || t.os.app !== 'ai' || !t.os.power) return { interrupted: true };

  pushHistory(t, 'user', message);
  pushHistory(t, 'assistant', reply);
  t.lastUserMessage = message;
  t.os.ai.draft = '';

  const display = padToRow(cleanReply(reply)) + '(click select to exit)';
  osAiDraw(t, display);
  t.os.ai.shown = true;
  t.os.ai.text = display;   // remember the full multi-row text so a key press can redraw it
  return { reply };
}

// ======================= SIMULATED OS =======================
//
// The default /out transmitter handles the OS controls:
//   pin 1 POWER, pin 2 DOWN, pin 3 UP, pin 4 SELECT, pin 5 FN1, pin 6 FN2.
// The four separate /keys/N POST transmitters handle alphabet + ENTER input.
// Letters are routed into whichever of terminal, text edit, or AI chat is open.
// A keyboard bank reacts only to rising edges, so POST an all-zero state on release.
//
// FN1 / FN2 are app-specific:
//   menu:     FN1 previous app, FN2 next app
//   terminal: FN1 inserts a space, FN2 clears the command line
//   text edit:FN1 inserts a space, FN2 backspaces
//   AI chat:  FN1 inserts a space, FN2 backspaces
//   clock:    FN1 toggles time/date, FN2 toggles 12/24-hour format
//   dice:     FN1 rolls, FN2 selects the next die size
// ENTER is handled by the auxiliary keyboard: terminal runs, text edit saves,
// and AI chat sends the typed message to Groq.

// New transmitters start in this mode ('os' or 'ai'). Use PANEL_MODE=ai to start in AI mode.
const DEFAULT_MODE = String(process.env.PANEL_MODE || '').toLowerCase() === 'ai' ? 'ai' : 'os';

const OS_VERSION = '1.3';
const OS_PINS = ['power', 'down', 'up', 'select', 'fn1', 'fn2']; // main transmitter pins 1-6
const OS_DEBOUNCE_MS = 40;
const POWER_ON_FALLING_EDGE = false;

const APPS = [
  { id: 'ai', name: 'ai chat' },
  { id: 'term', name: 'terminal' },
  { id: 'edit', name: 'text edit' },
  { id: 'clok', name: 'clock' },
  { id: 'dice', name: 'dice' },
];

// The four 8-pin POST keyboard banks. Array position 0 is physical pin 1.
const KEY_BANKS = [
  { id: '1', keys: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
  { id: '2', keys: ['i', 'j', 'k', 'l', 'm', 'n', 'o', 'p'] },
  { id: '3', keys: ['q', 'r', 's', 't', 'u', 'v', 'w', 'x'] },
  { id: '4', keys: ['y', 'z', 'enter', null, null, null, null, null] },
];
const EDITOR_MAX = 120;
const TERM_MAX = EDITOR_MAX;
const AI_DRAFT_MAX = 300;
const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100];

function makeOS() {
  return {
    power: false,
    app: 'menu',
    cursor: 0,
    bootedAt: 0,
    screen: '',
    lastKey: '',
    debounce: {},
    term: { buf: '', out: null },
    editor: { text: '' },
    clock: { showDate: false, use24h: true },
    dice: { side: 1, result: null },
    ai: { shown: false, text: '', draft: '' },
  };
}

const pad2 = (v) => String(v).padStart(2, '0');
const rollDie = (os) => 1 + Math.floor(Math.random() * DICE_SIDES[os.dice.side]);

// Pad a line so a following line starts on a new row (the panel wraps by itself).
function padToRow(text) {
  const len = Array.from(text).length;
  if (len === 0) return text;
  const pad = (CHARS_PER_ROW - (len % CHARS_PER_ROW)) % CHARS_PER_ROW;
  return text + ' '.repeat(pad);
}

// The one line the current app wants on the screen.
function osLine(t) {
  const os = t.os;
  switch (os.app) {
    case 'menu':
      return '▶ ' + APPS[os.cursor].name + ' ' + (os.cursor + 1) + '/' + APPS.length;
    case 'term': {
      const tm = os.term;
      if (tm.out !== null) return tm.out;
      return '# ' + Array.from(tm.buf).slice(-(CHARS_PER_ROW - 2)).join('') + '_';
    }
    case 'edit': {
      const visibleText = Array.from(os.editor.text).slice(-(CHARS_PER_ROW - 6)).join('');
      return 'EDIT:' + visibleText + '_';
    }
    case 'clok': {
      const d = new Date();
      if (os.clock.showDate) {
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      }
      let hours = d.getHours();
      if (!os.clock.use24h) hours = (hours % 12) || 12;
      return pad2(hours) + ':' + pad2(d.getMinutes()) + (os.clock.use24h ? '' : (d.getHours() >= 12 ? ' PM' : ' AM'));
    }
    case 'dice':
      return 'd' + DICE_SIDES[os.dice.side] + (os.dice.result === null ? '' : ': ' + os.dice.result);
    case 'ai':
      if (os.ai.shown) return os.ai.text || os.screen;
      return 'AI:' + (os.ai.draft || '_');
    default:
      return 'err';
  }
}

// Clear the panel, then write one line. Replaces whatever was still being drawn.
function osDraw(t, line) {
  const text = Array.from(String(line)).slice(0, CHARS_PER_ROW);
  t.os.screen = text.join('');
  t.queue = [];
  t.queue.push(...clearFrames());
  if (text.length) t.queue.push(...buildFrames(t, text.map(encode)));
}

// Clear the panel, then write one multi-row block (used by the AI app).
function osAiDraw(t, text) {
  const chars = Array.from(String(text)).slice(0, CHARS_PER_ROW * 8);
  t.os.screen = chars.slice(0, CHARS_PER_ROW).join('');
  t.queue = [];
  t.queue.push(...clearFrames());
  if (chars.length) t.queue.push(...buildFrames(t, chars.map(encode)));
}

// I/O key: on = menu, off = blank screen (the OS forgets everything).
// Mutates t.os instead of replacing it, so the debounce map survives toggles.
function osPower(t, on) {
  const os = t.os;
  if (!!os.power === !!on) return;   // already in that state
  os.power = !!on;
  os.app = 'menu';
  os.cursor = 0;
  os.screen = '';
  os.lastKey = '';
  os.term = { buf: '', out: null };
  os.editor = { text: '' };
  os.clock = { showDate: false, use24h: true };
  os.dice = { side: 1, result: null };
  os.ai = { shown: false, text: '', draft: '' };
  if (on) {
    os.bootedAt = Date.now();
    osDraw(t, osLine(t));
    noteAction(t, 'OS on');
  } else {
    t.queue = [];
    t.queue.push(...clearFrames());
    noteAction(t, 'OS off');
  }
}

// ---- terminal ----

// Accept number words because the dedicated keyboard provides alphabet keys and space.
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

function parseTerminalNumber(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, raw)
    ? NUMBER_WORDS[raw]
    : NaN;
}

function runCommand(t) {
  const tm = t.os.term;
  const line = tm.buf.trim().toLowerCase();
  tm.buf = '';
  tm.out = null;
  if (!line) return;

  const [cmd, ...args] = line.split(/\s+/);
  const d = new Date();
  switch (cmd) {
    case 'help':
    case 'commands':
      // Kept short enough to fit on one 16-character panel row.
      tm.out = 'echo time date';
      break;
    case 'echo':
      tm.out = args.join(' ') || ' '; 
      break;
    case 'time':
      tm.out = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
      break;
    case 'date':
      tm.out = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      break;
    case 'ver':
    case 'version':
      tm.out = 'bldos v' + OS_VERSION;
      break;
    case 'about':
      tm.out = 'panel os';
      break;
    case 'hello':
      tm.out = 'hello!';
      break;
    case 'rand': {
      const maxArg = args.length ? parseTerminalNumber(args[0]) : 100;
      const max = Number.isFinite(maxArg) && maxArg > 0 ? Math.floor(maxArg) : 100;
      tm.out = String(Math.floor(Math.random() * max));
      break;
    }
    case 'add': case 'sub': case 'mul': case 'div': {
      const a = parseTerminalNumber(args[0]);
      const b = parseTerminalNumber(args[1]);
      if (args.length < 2 || !Number.isFinite(a) || !Number.isFinite(b)) {
        tm.out = 'use number words';
        break;
      }
      if (cmd === 'div' && b === 0) {
        tm.out = 'err: div by 0';
        break;
      }
      const result = cmd === 'add' ? a + b
        : cmd === 'sub' ? a - b
        : cmd === 'mul' ? a * b
        : a / b;
      tm.out = String(Math.round(result * 1000) / 1000);
      break;
    }
    case 'uptime': {
      const seconds = Math.max(0, Math.floor((Date.now() - t.os.bootedAt) / 1000));
      tm.out = seconds + ' sec';
      break;
    }
    case 'clear':
    case 'cls':
      tm.out = '';
      break;
    case 'exit':
      t.os.app = 'menu';
      break;
    case 'off':
      osPower(t, false);
      break;
    default:
      tm.out = 'err: ' + cmd;
  }
}

function termKey(t, key) {
  const tm = t.os.term;
  if (tm.out !== null) {
    tm.out = null;
    tm.buf = '';
  }
  if (key === 'fn1') {
    if (tm.buf.length < TERM_MAX) tm.buf += ' ';
  } else if (key === 'fn2') {
    tm.buf = '';
  } else if (key === 'select') {
    t.os.app = 'menu';
  } else if (key === 'down') {
    runCommand(t);
  }
}

// Dedicated alphabet keys type directly into the editor. FN1 adds a space, FN2 deletes.
function editorKey(t, key) {
  const ed = t.os.editor;
  if (key === 'fn1') {
    if (ed.text.length < EDITOR_MAX) ed.text += ' ';
  } else if (key === 'fn2') {
    ed.text = ed.text.slice(0, -1);
  } else if (key === 'select') {
    t.os.app = 'menu';
  } else if (key === 'down') {
    t.os.app = 'menu';
  }
}

function menuKey(t, key) {
  const os = t.os;
  if (key === 'down' || key === 'fn2') os.cursor = (os.cursor + 1) % APPS.length;
  else if (key === 'up' || key === 'fn1') os.cursor = (os.cursor - 1 + APPS.length) % APPS.length;
  else if (key === 'select') {
    os.app = APPS[os.cursor].id;
    if (os.app === 'term') os.term = { buf: '', out: null };
    if (os.app === 'dice') os.dice.result = rollDie(os);
    if (os.app === 'ai') {
      os.ai = { shown: false, text: '', draft: '' };
      clearHistory(t);
    }
  }
}

function appKey(t, key) {
  const os = t.os;
  if (key === 'select') {
    if (os.app === 'ai') abandonChat(t);
    os.app = 'menu';
    return;
  }

  switch (os.app) {
    case 'ai':
      if (os.ai.shown) {
        os.ai.shown = false;
        os.ai.text = '';
      }
      if (key === 'fn1' && os.ai.draft.length < AI_DRAFT_MAX) os.ai.draft += ' ';
      else if (key === 'fn2') os.ai.draft = os.ai.draft.slice(0, -1);
      break;
    case 'term':
      termKey(t, key);
      break;
    case 'edit':
      editorKey(t, key);
      break;
    case 'clok':
      if (key === 'fn1') os.clock.showDate = !os.clock.showDate;
      else if (key === 'fn2') os.clock.use24h = !os.clock.use24h;
      break;
    case 'dice':
      if (key === 'fn1') os.dice.result = rollDie(os);
      else if (key === 'fn2' || key === 'down') {
        os.dice.side = (os.dice.side + 1) % DICE_SIDES.length;
        os.dice.result = null;
      } else if (key === 'up') {
        os.dice.side = (os.dice.side - 1 + DICE_SIDES.length) % DICE_SIDES.length;
        os.dice.result = null;
      }
      break;
  }
}

// Redraw the current app, using the full panel for an AI answer.
function redrawOS(t) {
  if (t.os.app === 'ai' && t.os.ai.shown) osAiDraw(t, t.os.ai.text || osLine(t));
  else osDraw(t, osLine(t));
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

// A letter key is sent to whichever text-capable application is currently open.
function keyboardLetter(t, letter) {
  if (!t.os.power || t.mode !== 'os') {
    noteAction(t, 'keyboard ' + letter + ' ignored (OS off or not in OS mode)');
    return false;
  }
  const os = t.os;
  if (os.app === 'term') {
    if (os.term.out !== null) { os.term.out = null; os.term.buf = ''; }
    if (os.term.buf.length < TERM_MAX) os.term.buf += letter;
  } else if (os.app === 'edit') {
    if (os.editor.text.length < EDITOR_MAX) os.editor.text += letter;
  } else if (os.app === 'ai') {
    if (os.ai.shown) { os.ai.shown = false; os.ai.text = ''; os.ai.draft = ''; }
    if (os.ai.draft.length < AI_DRAFT_MAX) os.ai.draft += letter;
  } else {
    noteAction(t, 'keyboard ' + letter + ' ignored (open terminal, text edit, or ai chat)');
    return false;
  }
  os.lastKey = letter;
  redrawOS(t);
  noteAction(t, 'keyboard key ' + letter + ' (' + os.app + ')');
  t.lastKeyboardKey = letter;
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

  if (os.app === 'term') {
    runCommand(t);
    if (t.os.power) redrawOS(t); // 'off' must leave the clear frame intact
    noteAction(t, 'keyboard ENTER ran terminal command');
    return true;
  }
  if (os.app === 'edit') {
    // Finish/save the current text; it remains in memory until the OS is powered off.
    os.app = 'menu';
    redrawOS(t);
    noteAction(t, 'keyboard ENTER saved text editor and returned to menu');
    return true;
  }
  if (os.app === 'ai') {
    const message = os.ai.draft.trim();
    if (!message) { noteAction(t, 'AI ENTER ignored (empty message)'); return false; }
    if (!groqKey) { noteAction(t, 'AI ENTER ignored (no Groq key)'); return false; }
    if (t.chatBusy) { noteAction(t, 'AI ENTER ignored (still working)'); return false; }
    os.ai.draft = '';
    os.ai.shown = false;
    os.ai.text = '';
    osDraw(t, 'thinking...');
    runOsChat(t, message).catch((e) => {
      os.ai.draft = message;
      os.ai.shown = false;
      os.ai.text = '';
      redrawOS(t);
      noteAction(t, 'AI keyboard send failed: ' + e.message);
    });
    noteAction(t, 'keyboard ENTER sent AI message');
    return true;
  }
  noteAction(t, 'keyboard ENTER ignored (no text input in ' + os.app + ')');
  return false;
}

function dispatchKeyboardKey(t, key) {
  if (key === 'enter') return keyboardEnter(t);
  return keyboardLetter(t, key);
}

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
    res.status(403).json({ error: 'Send the same pass header as the display transmitter.' });
    return null;
  }
  if (password.length > MAX_PASSWORD_CHARS) {
    res.status(400).json({ error: 'Password too long (max ' + MAX_PASSWORD_CHARS + ' characters).' });
    return null;
  }
  return getTransmitter(password);
}

// KEYBOARD INPUT ROUTES
// Accept POST (recommended) and GET (compatibility) so a transmitter configured
// with either method does not fail with "Cannot GET/POST". These routes NEVER
// return panel display frames; only /out supplies the display stream.
function handleKeyboardEndpoint(req, res, routeName) {
  const t = inputPanel(req, res);
  if (!t) return;

  const name = String(routeName || '').toLowerCase();
  const bank = KEY_BANKS.find((item) => item.id === name);

  if (bank) {
    const bits = readInputBits(req);
    if (bits === null) {
      return res.status(400).json({
        error: 'Missing/invalid pin state. Send an 8-bit value, e.g. {"value":"10000000"}.'
      });
    }

    const prev = t.keyBankPrev.get(bank.id) || '00000000';
    const rising = [];
    for (let i = 0; i < 8; i++) {
      if (bits[i] === '1' && prev[i] === '0' && bank.keys[i]) rising.push(bank.keys[i]);
    }
    t.keyBankPrev.set(bank.id, bits);

    if (rising.length > 1) {
      noteAction(t, 'keyboard bank ' + bank.id + ' ignored simultaneous keys: ' + rising.join('+'));
    } else if (rising.length === 1) {
      dispatchKeyboardKey(t, rising[0]);
    }
    return res.status(204).end();
  }

  // Also support /keys/a, /keys/b, ... /keys/z, /keys/enter as aliases.
  if (/^(?:[a-z]|enter)$/.test(name)) {
    const pressed = readPressed(req);
    if (pressed === null) {
      return res.status(400).json({
        error: 'For a single-key endpoint send {"pressed":true} on press and {"pressed":false} on release.'
      });
    }
    const prev = t.directKeyPrev.get(name) || false;
    t.directKeyPrev.set(name, pressed);
    if (pressed && !prev) dispatchKeyboardKey(t, name);
    return res.status(204).end();
  }

  return res.status(404).json({
    error: 'Unknown keyboard endpoint. Use /keys/1 through /keys/4, or /key/a through /key/z and /key/enter.'
  });
}

// Four 8-pin banks: /keys/1 ... /keys/4 (POST preferred; GET also accepted).
// Alias paths /keyboard/1 ... /keyboard/4 are supported too.
app.all(['/keys/:name', '/keyboard/:name'], (req, res) => {
  handleKeyboardEndpoint(req, res, req.params.name);
});

// Individual input endpoints, with two naming styles:
// /key/a ... /key/z, /key/enter and /letter/a ... /letter/z, /letter/enter.
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

    let result;
    try {
      result = await runOsChat(t, message);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
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
  if (mode === 'os' && t.os.power) osDraw(t, osLine(t));
  else t.queue.push(...clearFrames());
  noteAction(t, 'mode: ' + mode);
  res.json({ ok: true, mode });
});

// Press an OS key from the page (same as the matching pin from the game).
app.post('/api/os/key', (req, res) => {
  const t = req.transmitter;
  const key = String(req.body.key || '');
  if (!OS_PINS.includes(key) && key !== 'enter') return res.status(400).json({ error: 'Unknown key.' });
  if (t.mode !== 'os') return res.status(409).json({ error: 'Switch this transmitter to OS mode first.' });
  if (key === 'enter') keyboardEnter(t);
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
  res.json({
    key: !!groqKey,
    mode: t.mode,
    os: { power: t.os.power, app: t.os.app, screen: t.os.screen, lastKey: t.os.lastKey, aiShown: t.os.ai.shown },
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
  pre.screen { background:#000; color:#7f7; font-family:monospace; font-size:1.5rem; line-height:1.3; letter-spacing:.2em; white-space:pre; padding:.6rem .8rem; border-radius:8px; margin:.4rem .2rem; min-height:3.6rem; }
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
  <small>Type the same password you put in your in-game HTTP Transmitter. A new password creates a new transmitter (a separate panel); typing an existing one goes back to it. Each password has its own queue, conversation, prompt and OS, so you can drive several panels from this server. Each browser tab remembers its own password, so open a second tab for a second panel.</small>
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
  <small>Get one at console.groq.com/keys. It is kept in the server's memory only (lost on restart), and is shared by every transmitter on this server. Needed by AI mode and by the OS "ai chat" app. The rest of the simulated OS does not need it.</small>
  <div class="st" id="keyst">not connected</div>
</section>

<section id="chatsec" class="locked">
  <h2>3. Message</h2>
  <input id="msg" type="text" placeholder="Say something..." autocomplete="off">
  <button id="sendbtn" class="needs-key" onclick="sendMsg()">Send</button>
  <button class="gray" onclick="clearMemory()">New conversation</button>
  <small><b>AI mode:</b> the panel shows your message first, then the reply.<br>
  <b>OS mode:</b> open the <b>ai chat</b> app on the panel first (menu → ai chat → select), then send from here.</small>
  <div class="st" id="reply"></div>
</section>

<section id="promptsec" class="locked">
  <h2>4. AI prompt (for this transmitter)</h2>
  <textarea id="prompt" placeholder="Describe how the AI should behave..."></textarea>
  <label class="wrap"><input id="rules" type="checkbox" checked>Add the panel rules (one short line, only characters the panel can draw)</label>
  <button onclick="savePrompt()">Save prompt</button>
  <button class="gray" onclick="resetPrompt()">Reset to default</button>
  <small>Example: You are a grumpy pirate. Answer in pirate slang. Saving starts a new conversation on this transmitter. Leave the box empty and save to go back to the default. Kept in memory only.</small>
  <div class="st" id="promptst"></div>
</section>

<section id="ossec" class="locked">
  <h2>5. Simulated OS (same password)</h2>
  <div class="st" id="osmode">mode: AI text sender</div>
  <button id="osmodebtn" onclick="toggleOsMode()">Switch to OS mode</button>
  <small>Default display transmitter: /out. Its pins are 1 on/off, 2 down, 3 up, 4 select, 5 FN1, 6 FN2. The four extra keyboard transmitters POST to /keys/1 through /keys/4 and never receive display output. All five use the same pass header.</small>
  <pre class="screen" id="osscreen">(AI mode)</pre>
  <div class="keys">
    <button onclick="osKey('power')">On/off (1)</button>
    <button onclick="osKey('down')">Down (2)</button>
    <button onclick="osKey('up')">Up (3)</button><br>
    <button onclick="osKey('select')">Select (4)</button>
    <button onclick="osKey('fn1')">FN1 (5)</button>
    <button onclick="osKey('fn2')">FN2 (6)</button>
    <button onclick="osKey('enter')">Keyboard Enter</button>
  </div>
  <div class="st" id="osst"></div>
  <div class="st" id="ospins"></div>
  <small>Keyboard pins (leftmost bit = pin 1): /keys/1 = A-H, /keys/2 = I-P, /keys/3 = Q-X, /keys/4 = Y, Z, ENTER on pins 1-3. Example POST body: {&quot;value&quot;:&quot;10000000&quot;}; POST all-zero bits on release. Use the same pass header as the default transmitter. Optional individual POST paths: /key/a ... /key/z and /key/enter, with {&quot;pressed&quot;:true/false} or an 8-bit pin value; those need 27 input transmitters if configured one device per key (28 total including display). Recommended bank setup is 5 total. Only /out returns panel frames. Menu: UP/FN1 previous app, DOWN/FN2 next app, SELECT opens. Terminal: keyboard letters type; FN1=space, FN2=clear line, ENTER runs command; DOWN also runs; SELECT exits. Commands: help, echo, time, date, ver, about, hello, rand, add, sub, mul, div, uptime, clear, exit, off. For math and rand limits, spell numbers (example: add five three). Text editor: keyboard letters type; FN1=space, FN2=backspace, ENTER saves and returns to menu; SELECT exits. AI chat: keyboard letters type; FN1=space, FN2=backspace, ENTER sends to Groq; SELECT exits. Clock: FN1 toggles time/date, FN2 toggles 12/24-hour format. Dice: FN1 rolls, FN2 cycles dice type; UP/DOWN also change dice type.</small>
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
      document.getElementById('st8').textContent = 'posted by game: ' + (s.input || '(nothing yet)')
        + ' | raw: ' + (s.raw ? JSON.stringify(s.raw) : '(no body)')
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
    individualKeys: 'POST (or GET) /key/a through /key/z and /key/enter'
  });
});

app.listen(PORT, () => {
  const dictionary = JSON.stringify({ [PASS_HEADER]: '<your-password>' });
  console.log('Panel page: http://localhost:' + PORT + '/');
  console.log('Default display transmitter: /out (GET or POST; the only endpoint that returns display frames).');
  console.log('Auxiliary keyboard transmitters: /keys/1 through /keys/4 (POST recommended; GET also accepted; no display output).');
  console.log('Individual-key aliases: /key/a ... /key/z and /key/enter (also /keys/a ... /keys/z and /keys/enter).');
  console.log('Hardware count: 1 display + 4 keyboard = 5 total.');
  console.log('  Set this header on your HTTP Transmitter:  ' + PASS_HEADER + ': <your-password>');
  console.log('  Headers dictionary:  ' + dictionary);
  console.log('  Use the SAME pass value on the display transmitter and all four keyboard transmitters.');
  console.log('  Different pass values still create separate panels.');
  console.log('  The page itself is open. Type the same password into it to control that panel.');
  console.log('  Simulated OS: switch a panel to OS mode in section 5 of the page.');
  console.log(groqKey ? 'Groq key loaded from GROQ_API_KEY (shared by all transmitters).' : 'No Groq key yet - set one on the page (AI mode + ai chat only; the rest of the OS does not need it).');
  console.log(INITIAL_PROMPT !== null ? 'New transmitters start with the PANEL_PROMPT prompt.' : 'New transmitters start with the default prompt (change it per panel on the page).');
});
