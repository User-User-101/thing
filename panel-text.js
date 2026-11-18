// Groq-powered text sender for Build Logic's 16x16 RGB panel
//
// You type a message on the web page; the server asks a Groq-hosted model for a
// SHORT reply, turns each character into its 7-bit code (shift + 6 character pins)
// and feeds it to ONE HTTP Transmitter, one frame per poll. The panel shows YOUR
// message first, then the reply underneath it. Everything else (cursor, clock,
// reset, colors) you build in-game.
//
// The conversation is remembered server-side (the last MAX_HISTORY_TURNS exchanges),
// so follow-up messages can refer back to earlier ones. Memory lives in this process
// only, like the key, so it is forgotten when the server restarts.
//
// You can set your own AI prompt (system prompt) on the web page, under
// "3. AI prompt". It is also kept in memory only. To start with a custom prompt,
// use PANEL_PROMPT="You are a pirate..." node panel-text.js
//
// Setup:
//   npm install express
//   node panel-text.js                          (Node 18+ is required: it uses fetch)
//   or: GROQ_API_KEY=gsk_... node panel-text.js (skip typing the key on the page)
//   (second terminal) cloudflared tunnel --url http://localhost:3000   (or ngrok http 3000)
//
// Web page (your browser):  https://YOUR-TUNNEL-URL/
// Transmitter Url:          https://YOUR-TUNNEL-URL/out
//
// HTTP Transmitter in POST mode: the transmitter POSTs its own pin state to /out as
//   {"value":"00000000"}
// and the server answers with the next panel frame, also as {"value":"........"}.
// The FIRST characters of what you POST are control pins (first pin = leftmost):
//   pin 1 = INTERRUPT: stop the response that is being drawn (or still being thought up)
//   pin 2 = REDO:      ask the AI again for the last message and draw the new answer
// Both act once on the rising edge (0 -> 1), so holding a pin high does not repeat.
// The other 6 pins are ignored. GET /out still works the old way (no controls).
//
// The page and its API ask for a password (HTTP Basic Auth; any username, the
// password is what counts). The password is "hi10h"; override it by starting with
// PANEL_PASSWORD=... . /out stays open for the game's HTTP Transmitter; add
// OUT_TOKEN=secret to require /out?token=secret as well.
//
// The Groq API key is REQUIRED. Nothing is sent to the panel until a key is set
// and verified against api.groq.com.
//
// Output is an 8-bit string, leftmost bit first:
//   X S C5 C4 C3 C2 C1 C0
//   X      = clear screen. 1 only in the clear frame, 0 everywhere else.
//   S      = shift pin
//   C5..C0 = the 6 character pins
// Example: 'A' = 01000001, 'a' = 00000001, clear screen = 10000000, idle = 00000000.

const express = require('express');
const crypto = require('crypto');

const app = express();

// ======================= ACCESS CONTROL =======================

// The page and every API call require this password (HTTP Basic Auth).
// The username is ignored; only the password is checked.
const PASSWORD = String(process.env.PANEL_PASSWORD || 'hi10h').trim();

// Optional: also require ?token=... on /out, so the tunnel URL alone is not enough.
const OUT_TOKEN = String(process.env.OUT_TOKEN || '').trim();

if (!PASSWORD) {
  console.error('Refusing to start without a password.');
  console.error('Start it like this instead:');
  console.error('  PANEL_PASSWORD=something-secret node panel-text.js');
  process.exit(1);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// /out is exempt: the in-game transmitter polls it and cannot send a password.
app.use((req, res, next) => {
  if (req.path === '/out') return next();
  const header = String(req.headers.authorization || '');
  const ask = () => {
    res.set('WWW-Authenticate', 'Basic realm="Panel Text", charset="UTF-8"');
    return res.status(401).send('Password required.');
  };
  if (!header.startsWith('Basic ')) return ask();
  let pass = '';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    pass = i >= 0 ? decoded.slice(i + 1) : '';
  } catch (e) { /* fall through */ }
  if (!safeEqual(pass, PASSWORD)) return ask();
  next();
});

// Never let Express, a tunnel or the game cache /out: most frames are the same few
// values, and a cached or 304 reply would hand the game stale data.
app.disable('etag');
app.use((req, res, next) => {
  if (req.path === '/out') res.set('Cache-Control', 'no-store');
  next();
});

// The game's transmitter may not label its POST body as JSON, so /out reads the body
// as raw text whatever the Content-Type is, and parses it itself (see readInputBits).
// This must come before express.json(), which then skips the already-read body.
app.use('/out', express.text({ type: () => true }));
app.use(express.json());

const PORT = 3000;

// ======================= SETTINGS =======================

// Which clock circuit you have in the game. There is no strobe bit: the 7 code bits are
// OR'd together, and "any code bit on" is what triggers a write. Code 0000000 means
// "nothing" and is what the pins sit at when idle.
//
//   'pulse-fast' / 'pulse-safe' (simple circuit): the 7 code pins go into an 8-input OR
//           whose output goes straight to the panel's clock and set enabled. The clock
//           therefore rises each time the code goes from 0 to non-zero, and the panel
//           writes one character per rising edge, however long the code stays on the
//           pins. A code-0 gap is needed between every pair of characters so the clock
//           can fall and rise again.
//   'loop'  (the original): AND output -> NOT -> 0.01 s delay -> back into the AND.
//           That is a free-running clock, so it keeps writing while a code is on the
//           pins and cannot be made reliable at a 0.1 s poll. Frames are sent once.
//
// Per preset: CHAR_FRAMES = polls each character is held; GAP = where code-0 frames go
// ('always' between every pair, 'repeats' only between identical letters); GAP_FRAMES =
// how many code-0 polls make up a gap. Lower the numbers for speed, raise them for safety.
//
// With the 'pulse' circuit pick a speed:
//   'pulse-fast' 2 polls per character (0.2 s at a 0.1 s interval = 5 letters/second).
//                A lost poll can lose a letter.
//   'pulse-safe' 4 polls per character (2.5 letters/second). Survives one lost poll.
//
// With the 'change' circuit (every code bit compared with a delayed copy of itself, so
// the clock fires on ANY change of the code to a non-zero value) no gap is needed
// between different letters, only between identical ones:
//   'change'      1 poll per character (10 letters/second at 0.1 s). A lost poll can
//                 lose a letter.
//   'change-safe' each character held 2 polls (5 letters/second). Survives one lost poll.
const CIRCUIT = 'pulse-fast';
// CLEAR_WAIT is no longer used by clearFrames(); see CLEAR_HOLD / CLEAR_SETTLE below.
const PRESETS = {
  'pulse-fast': { CHAR_FRAMES: 1, GAP: 'always', GAP_FRAMES: 1, CLEAR_WAIT: 1 },
  'pulse-safe': { CHAR_FRAMES: 3, GAP: 'always', GAP_FRAMES: 3, CLEAR_WAIT: 1 },
  change: { CHAR_FRAMES: 1, GAP: 'repeats', GAP_FRAMES: 1, CLEAR_WAIT: 1 },
  'change-safe': { CHAR_FRAMES: 2, GAP: 'repeats', GAP_FRAMES: 2, CLEAR_WAIT: 1 },
  loop: { CHAR_FRAMES: 1, GAP: 'repeats', GAP_FRAMES: 1, CLEAR_WAIT: 1 },
  // EXPERIMENT: no gaps at all and no wait after the clear, one poll per character.
  // With the simple circuit the clock never falls between letters, so expect only the
  // first letter to be written. Set CIRCUIT back to 'pulse-fast' afterwards.
  turbo: { CHAR_FRAMES: 1, GAP: 'never', GAP_FRAMES: 0, CLEAR_WAIT: 0 },
};
const { CHAR_FRAMES, GAP, GAP_FRAMES } = PRESETS[CIRCUIT];

// Every text send starts with a clear frame (first bit = 1, code bits 0000000)
const CLEAR_BEFORE_TEXT = true;

// Clear frame is held this many polls, then this many code-0 polls are sent
// so the reset can finish before the first letter. Raise if you still get junk.
const CLEAR_HOLD = 1;
const CLEAR_SETTLE = 1;

// ---- Show the user's message on the panel before the reply ----
const SHOW_INPUT = true;

// How many characters fit on ONE row of your panel before it wraps.
// The character table has no newline, so the script pads the input with spaces
// up to the next row boundary so the reply starts on a fresh row.
// 4 is a guess: send "abcdefghijklmnop" from Manual tools, count the letters on
// the first row, and put that number here.
const CHARS_PER_ROW = 4;

// If your in-game panel has a code that moves the cursor to the next line,
// put it here (0-127) and padding is skipped. Leave null otherwise.
const NEWLINE_CODE = null;

// Longest echo of the user's message itself (anything longer is cut at this length).
// The prefix and suffix below are added on top of this.
const ECHO_MAX_CHARS = 16;

// The echo is drawn as  PREFIX + message + SUFFIX,  e.g.  (▶hello)
// Your character table has no ">" so the arrow "▶" (code 61) is used instead.
// Put a space inside the prefix (like '(▶ ') if you want a gap, at the cost of one cell.
const ECHO_PREFIX = '(▶';
const ECHO_SUFFIX = ')';

// null = the reply starts at the beginning of the row directly under the echo.
// The echo is padded with blank cells up to the next row boundary, which only
// lines up if CHARS_PER_ROW matches your panel (or NEWLINE_CODE is set).
// A number = send that many blank cells between echo and reply instead. That
// distance is fixed, so the reply only sits under the echo by luck.
const ECHO_GAP = null;

// What goes between the echo and the reply
function separatorCodes(usedChars) {
  if (ECHO_GAP !== null) return Array(ECHO_GAP).fill(SPACE_CODE);
  return lineBreakCodes(usedChars);
}

// Codes that move the cursor to the start of the next row
function lineBreakCodes(usedChars) {
  if (NEWLINE_CODE !== null) return [NEWLINE_CODE & 127];
  if (!CHARS_PER_ROW || usedChars === 0) return [];
  const pad = (CHARS_PER_ROW - (usedChars % CHARS_PER_ROW)) % CHARS_PER_ROW;
  return Array(pad).fill(SPACE_CODE);
}

// Code sent for a space: 63 = 0111111, which is blank in the character table
const SPACE_CODE = 63;

// Flip if the game reads the 8-bit string in the opposite direction
const REVERSE_BITS = false;

// ---- Control pins, read from the value the transmitter POSTs to /out ----
// Position in the posted string, counting from 0 at the leftmost (first) pin.
const PIN_INTERRUPT = 0;
const PIN_REDO = 1;

// true = an interrupt also clears the panel; false = the half-drawn text stays.
const INTERRUPT_CLEARS_SCREEN = false;

// Per-character overrides, as full 7-bit codes (0-127).
// 'Î' is missing from your table, so it uses the same code as 'Ì'.
const CUSTOM = { 'Î': 113 };

// ======================= GROQ SETTINGS =======================

// Get a key at https://console.groq.com/keys . It starts with "gsk_".
// You can also start the server with GROQ_API_KEY=... to pre-fill it.
let groqKey = String(process.env.GROQ_API_KEY || '').trim();

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

// 'openai/gpt-oss-20b' is Groq's current fast, inexpensive replacement for the
// retired 'llama-3.1-8b-instant'. It is a reasoning model, so:
//   - we use max_completion_tokens (not max_tokens)
//   - we set reasoning_effort: 'low' so it does not burn the whole budget thinking
//   - the budget is generous: reasoning and visible text share it, and if it runs
//     out the reply is cut off mid-sentence (finish_reason 'length'), which we detect.
const GROQ_MODEL = 'openai/gpt-oss-20b';

// Reply length policy. The model is asked to stay under SOFT; between SOFT and HARD
// is accepted as "a bit long". Above HARD (or a token-limit cut) we ask the model to
// answer again, shorter but complete. A reply is NEVER cut mid-word.
const REPLY_SOFT_CHARS = 48;
const REPLY_HARD_CHARS = 120;
const COMPLETION_TOKENS = 2048;   // room for hidden reasoning + the visible reply
const MAX_INPUT_CHARS = 300;      // don't forward huge prompts

// How much of the conversation to remember. Each "turn" is one user message plus
// one assistant reply. Older turns are dropped once the limit is exceeded.
const MAX_HISTORY_TURNS = 10;

// ======================= PROMPT (CUSTOMIZABLE) =======================

// The default prompt is made of two parts:
//   DEFAULT_PERSONA - who the model is and how it behaves. This is the part you
//                     normally want to replace with your own text.
//   PANEL_RULES     - the technical limits of the panel (short, one line, only
//                     characters the panel can draw). Appended after your prompt
//                     unless you untick "Add the panel rules" on the page.
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

// The prompt that is in use right now. null = use DEFAULT_PERSONA.
// Pre-fill it with PANEL_PROMPT="..." when starting the server.
let customPrompt = String(process.env.PANEL_PROMPT || '').trim().slice(0, MAX_PROMPT_CHARS) || null;
let appendRules = true;

function currentSystemPrompt() {
  const persona = customPrompt !== null ? customPrompt : DEFAULT_PERSONA;
  // The default persona always gets the panel rules; a custom prompt gets them
  // only when the box is ticked.
  if (customPrompt === null || appendRules) return persona.trim() + ' ' + PANEL_RULES;
  return persona.trim();
}

const SHORTEN_PROMPT =
  'That answer was cut off or too long. Reply again with the complete answer in under 48 characters. ' +
  'Keep complete words and complete sentences; shorten the wording instead of cutting anything off.';

// ======================= CONVERSATION MEMORY =======================

// [{ role: 'user' | 'assistant', content: '...' }, ...]
let history = [];

// The last message that got an answer; the REDO pin asks the AI about it again.
let lastUserMessage = '';

function pushHistory(role, content) {
  history.push({ role, content });
  const cap = MAX_HISTORY_TURNS * 2;
  if (history.length > cap) history = history.slice(-cap);
}

function clearHistory() {
  history = [];
  lastUserMessage = ''; // nothing left to redo
  abandonChat();        // an answer still being written must not bring it back
}

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

// What the panel draws for a code, for the page status line
function glyph(code) {
  if (code === 0) return '(nothing)';
  return CHARS[code] || '(blank)';
}

// ======================= OUTPUT =======================

let queue = [];
let last = { clear: 0, code: 0 }; // the last frame sent (shown in the page status)
let held = null; // when set to an 8-bit string, /out sends exactly this until released (for wiring tests)

function bin8(n) {
  const s = (n & 255).toString(2).padStart(8, '0');
  return REVERSE_BITS ? s.split('').reverse().join('') : s;
}
const toValue = (f) => bin8((f.clear << 7) | (f.code & 127));

const blank = () => ({ clear: 0, code: 0 });
const times = (f, count) => Array.from({ length: count }, () => ({ ...f }));

// The clear frame is held CLEAR_HOLD polls, then CLEAR_SETTLE code-0 polls follow
// so the reset has time to finish before the first letter arrives.
function clearFrames() {
  return [...times({ clear: 1, code: 0 }, CLEAR_HOLD), ...times(blank(), CLEAR_SETTLE)];
}

// Each character is held for CHAR_FRAMES polls, with a code-0 gap (GAP_FRAMES polls)
// where the preset asks for one (see CIRCUIT)
function buildFrames(codes) {
  const out = [];
  let prev = queue.length ? queue[queue.length - 1].code : last.code;
  for (const code of codes) {
    const needGap = prev !== 0 && (GAP === 'always' || (GAP === 'repeats' && prev === code));
    if (needGap) out.push(...times(blank(), GAP_FRAMES));
    out.push(...times({ clear: 0, code }, CHAR_FRAMES));
    prev = code;
  }
  return out;
}

// ---- Poll diagnostics: who is calling /out, how often, and are there gaps? ----
// Every request to /out consumes a frame, so a second caller (another browser tab,
// a tunnel health check, a second transmitter) or a stalled tunnel scrambles the
// panel. These numbers are shown at the bottom of the page.
const pollLog = []; // timestamps of the last 10 s of /out requests
const pollClients = new Map();
let pollTotal = 0;

function notePoll(req) {
  const now = Date.now();
  pollTotal++;
  pollLog.push(now);
  while (pollLog.length && now - pollLog[0] > 10000) pollLog.shift();
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '?').split(',')[0].trim();
  const who = ip + ' / ' + String(req.headers['user-agent'] || 'no-agent').slice(0, 40);
  pollClients.set(who, (pollClients.get(who) || 0) + 1);
  if (pollClients.size > 20) pollClients.delete(pollClients.keys().next().value);
}

function pollStats() {
  const now = Date.now();
  while (pollLog.length && now - pollLog[0] > 10000) pollLog.shift();
  let maxGap = 0;
  for (let i = 1; i < pollLog.length; i++) maxGap = Math.max(maxGap, pollLog[i] - pollLog[i - 1]);
  return {
    perSec: pollLog.filter((t) => now - t <= 1000).length,
    maxGapMs: maxGap,
    agoMs: pollLog.length ? now - pollLog[pollLog.length - 1] : null,
    total: pollTotal,
    clients: Array.from(pollClients.entries()).map(([k, v]) => v + 'x ' + k),
  };
}

// ---- Sent log: the characters the server actually put on the pins, newest last ----
// Compare this with what the panel drew. [CLR] = clear frame, · = blank cell.
const sentLog = [];
let prevSent = { clear: 0, code: 0 };

function noteSent(frame) {
  if (frame.clear && !prevSent.clear) {
    sentLog.push('[CLR]');
  } else if (!frame.clear && frame.code !== 0 && frame.code !== prevSent.code) {
    sentLog.push(frame.code === SPACE_CODE ? '·' : (CHARS[frame.code] || '<' + frame.code + '>'));
  }
  while (sentLog.length > 80) sentLog.shift();
  prevSent = frame;
}

// ---- Control pins (INTERRUPT / REDO) ----

// Pull the 8-bit string out of the request. Accepts {"value":"00000000"} as a JSON
// body (whatever the Content-Type), a bare 8-bit body, or ?value=... in the URL.
// Returns null when there is nothing usable (a plain GET, or a malformed body).
function readInputBits(req) {
  let v;
  const raw = req.body;
  if (raw && typeof raw === 'object') {
    v = raw.value;
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const j = JSON.parse(raw);
      v = j && typeof j === 'object' ? j.value : j;
    } catch (e) {
      const m = raw.match(/[01]{8}/);
      v = m ? m[0] : undefined;
    }
  }
  if (v === undefined || v === null) v = req.query.value;
  if (v === undefined || v === null) return null;

  let s = String(v).trim();
  if (!/^[01]+$/.test(s)) return null;
  s = s.padEnd(8, '0').slice(0, 8); // first character = first pin
  return REVERSE_BITS ? s.split('').reverse().join('') : s;
}

let prevIn = null;      // the previous POSTed value; null until the first POST
let lastIn = null;      // shown on the page
let lastAction = '';    // shown on the page

function noteAction(text) {
  lastAction = new Date().toLocaleTimeString() + ' ' + text;
}

// INTERRUPT: stop whatever is being drawn and forget any answer still being written.
function interruptResponse() {
  abandonChat();      // a Groq call still in flight is discarded when it returns
  queue = [];
  if (INTERRUPT_CLEARS_SCREEN) queue.push(...clearFrames());
  noteAction('INTERRUPT');
}

// REDO: ask the AI again about the last message and draw the new answer.
function redoResponse() {
  if (!groqKey) return noteAction('REDO ignored (no key)');
  if (!lastUserMessage) return noteAction('REDO ignored (nothing to redo)');
  if (chatBusy) return noteAction('REDO ignored (still working)');
  queue = []; // stop drawing the old answer right away
  noteAction('REDO');
  runChat(lastUserMessage, true).catch((e) => {
    noteAction('REDO failed: ' + e.message);
    console.error('Redo failed:', e.message);
  });
}

// A pin only fires on its rising edge (0 -> 1), so a transmitter that keeps
// POSTing the same "1" does not trigger it again on every poll.
function handleControlPins(bits) {
  lastIn = bits;
  if (prevIn !== null) {
    const rose = (i) => bits[i] === '1' && prevIn[i] === '0';
    if (rose(PIN_INTERRUPT)) interruptResponse();
    if (rose(PIN_REDO)) redoResponse();
  }
  prevIn = bits; // first POST only sets the baseline, so a pin that is already high at start does nothing
}

// The game calls this. GET = plain poll. POST = the transmitter's pin state comes in
// the body and is handled first. Either way, each call consumes one frame from the queue
// and the answer is {"value":"........"}.
function outHandler(req, res) {
  notePoll(req);
  if (OUT_TOKEN && req.query.token !== OUT_TOKEN) {
    return res.status(401).json({ error: 'bad or missing token' });
  }
  if (req.method === 'POST') {
    const bits = readInputBits(req);
    if (bits !== null) handleControlPins(bits);
  }
  if (held !== null) return res.json({ value: held });
  const frame = queue.length ? queue.shift() : blank(); // empty: always 00000000
  last = frame;
  noteSent(frame);
  res.json({ value: toValue(frame) });
}

app.route('/out').get(outHandler).post(outHandler);

// ======================= GROQ HELPERS =======================

// Everything that sends something to the panel needs a verified key.
function requireKey(res) {
  if (groqKey) return true;
  res.status(401).json({ error: 'No Groq API key set yet. Paste your gsk_... key on the page first.' });
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

// Last-resort length cap, only used when the model still refuses to be short.
// Cuts at a word boundary so a word is never split.
function finalizeReply(text) {
  let t = cleanReply(text);
  if (t.length <= REPLY_HARD_CHARS) return t;
  let cut = t.slice(0, REPLY_HARD_CHARS);
  const space = cut.lastIndexOf(' ');
  if (space > 0) cut = cut.slice(0, space);
  return cut.trim();
}

// One Groq call. Returns { content, finishReason } where finishReason is 'stop',
// 'length', etc. 'length' means the reply was cut off by the token budget.
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

// Ask for a short reply, and if it came back cut off or over-long, retry (up to
// RETRY_LIMIT times) asking the model for a COMPLETE shorter answer. Never returns
// a mid-word cut.
async function askGroq(message, hist = history) {
  const base = [
    { role: 'system', content: currentSystemPrompt() }, // default or your custom prompt
    ...hist, // remembered turns (for a redo: without the answer being replaced)
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

    // Ask again: include what was produced so the model can rewrite it completely.
    messages = [
      ...base,
      { role: 'assistant', content: content || '(no visible text)' },
      { role: 'user', content: SHORTEN_PROMPT },
    ];

    if (cutByTokens) {
      // Also give the retry more headroom so the visible answer can finish.
      messages.push({ role: 'user', content: 'Use very few words so the whole answer fits.' });
    }
  }

  // Retries exhausted: return whatever we have, never split a word.
  const clean = finalizeReply(lastContent);
  if (!clean) throw new Error('Model returned no usable text. Try again.');
  return clean;
}

// ======================= API FOR THE WEB PAGE =======================

const n = (v, max) => Math.max(0, Math.min(max, Number(v) | 0));

// Set / clear the Groq key. A non-empty key is checked against api.groq.com first,
// so a typo is caught immediately instead of silently breaking every send.
app.post('/api/key', async (req, res) => {
  const key = String(req.body.key || '').trim();

  if (!key) {
    groqKey = '';
    clearHistory(); // forgetting the key also forgets the conversation
    return res.json({ ok: true, key: false, message: 'Key forgotten. The panel is locked.' });
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
  res.json({ ok: true, key: true, message: 'Key set — the panel is unlocked.' });
});

// Read the prompt currently in use (the page loads this into the text box).
app.get('/api/prompt', (_req, res) => {
  res.json({
    custom: customPrompt !== null,
    prompt: customPrompt !== null ? customPrompt : DEFAULT_PERSONA.trim(),
    defaultPrompt: DEFAULT_PERSONA.trim(),
    appendRules,
    rules: PANEL_RULES,
    maxChars: MAX_PROMPT_CHARS,
  });
});

// Set your own prompt. An empty prompt goes back to the default.
// Changing the prompt also starts a fresh conversation, so old replies written
// under the previous prompt don't confuse the model.
app.post('/api/prompt', (req, res) => {
  const prompt = String(req.body.prompt || '').trim();
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: 'Prompt too long (max ' + MAX_PROMPT_CHARS + ' characters).' });
  }
  if (req.body.appendRules !== undefined) appendRules = !!req.body.appendRules;

  customPrompt = prompt ? prompt : null;
  if (customPrompt === null) appendRules = true;
  clearHistory();

  res.json({
    ok: true,
    custom: customPrompt !== null,
    appendRules,
    message: customPrompt !== null ? 'Custom prompt saved. New conversation started.' : 'Back to the default prompt. New conversation started.',
  });
});

// Type a message, get a short Groq reply that can see earlier turns, and show
// the message followed by the reply on the panel. The exchange is remembered
// for the next call.
// chatBusy stops two requests (button + Enter, or two tabs) from running at once.
let chatBusy = false;
// Bumped by every new request and by INTERRUPT. A request whose number is no longer
// current was interrupted (or superseded): its answer is thrown away.
let chatGen = 0;

// Throw away any AI request that is still in flight (its answer is ignored when it
// arrives) and free the "busy" lock so new messages and REDO work straight away.
function abandonChat() {
  chatGen++;
  chatBusy = false;
}

// Ask the AI and put the exchange on the panel. Used by the web page (/api/chat) and
// by the REDO pin. redo = true replaces the last exchange instead of adding a new one.
// Resolves to { reply } or { interrupted: true }; throws if Groq fails.
async function runChat(message, redo = false) {
  const myGen = ++chatGen;
  chatBusy = true;
  const base = redo ? history.slice(0, -2) : history; // redo: leave out the old answer
  let reply;
  try {
    reply = await askGroq(message, base);
  } finally {
    if (myGen === chatGen) chatBusy = false;
  }
  if (myGen !== chatGen) return { interrupted: true };

  // Remember this exchange only after a successful reply.
  if (redo) history = base.slice();
  pushHistory('user', message);
  pushHistory('assistant', reply);
  lastUserMessage = message;

  queue = []; // the new message replaces whatever was still being drawn
  if (CLEAR_BEFORE_TEXT) queue.push(...clearFrames());

  if (SHOW_INPUT) {
    // Echo only characters the panel can draw, so nothing turns into '?'
    const body = Array.from(cleanReply(message)).slice(0, ECHO_MAX_CHARS);
    const echo = [...Array.from(ECHO_PREFIX), ...body, ...Array.from(ECHO_SUFFIX)];
    const codes = [
      ...echo.map(encode),
      ...separatorCodes(echo.length),
      ...Array.from(reply).slice(0, 200).map(encode),
    ];
    queue.push(...buildFrames(codes));
  } else {
    queue.push(...buildFrames(Array.from(reply).slice(0, 200).map(encode)));
  }
  return { reply };
}

app.post('/api/chat', async (req, res) => {
  if (!requireKey(res)) return;
  if (chatBusy) return res.status(429).json({ error: 'Still working on the previous message.' });

  const message = normalizeText(req.body.message || '').trim().slice(0, MAX_INPUT_CHARS);
  if (!message) return res.status(400).json({ error: 'Type a message first.' });

  let result;
  try {
    result = await runChat(message);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
  if (result.interrupted) return res.json({ reply: '(interrupted)', interrupted: true, queued: queue.length, memory: history.length / 2 });

  res.json({ reply: result.reply, queued: queue.length, memory: history.length / 2 });
});

// Same as the INTERRUPT / REDO pins, for testing from the page.
app.post('/api/interrupt', (_req, res) => {
  interruptResponse();
  res.json({ ok: true, queued: queue.length });
});

app.post('/api/redo', (_req, res) => {
  if (!requireKey(res)) return;
  redoResponse();
  res.json({ ok: true, action: lastAction });
});

// Forget the conversation (the key is kept).
app.post('/api/memory/clear', (_req, res) => {
  clearHistory();
  res.json({ ok: true, memory: 0 });
});

app.post('/api/text', (req, res) => {
  if (!requireKey(res)) return;
  // Remove emoji variation selectors (arrows often arrive with one) and line breaks
  const text = String(req.body.text || '').replace(/\uFE0F/g, '').replace(/[\r\n]/g, ' ');
  if (CLEAR_BEFORE_TEXT) queue.push(...clearFrames());
  queue.push(...buildFrames(Array.from(text).slice(0, 200).map(encode)));
  res.json({ queued: queue.length });
});

app.post('/api/clear', (_req, res) => {
  if (!requireKey(res)) return;
  lastUserMessage = ''; // REDO does nothing until a new message is sent
  abandonChat();
  queue.push(...clearFrames());
  res.json({ queued: queue.length });
});

app.post('/api/code', (req, res) => {
  if (!requireKey(res)) return;
  queue.push(...buildFrames([n(req.body.code, 127)]));
  res.json({ queued: queue.length });
});

// Sends every code from..to in order so you can watch what each one draws
app.post('/api/sweep', (req, res) => {
  if (!requireKey(res)) return;
  const from = n(req.body.from, 127);
  const to = Math.max(from, n(req.body.to, 127));
  const codes = [];
  for (let c = from; c <= to; c++) codes.push(c);
  queue.push(...buildFrames(codes));
  res.json({ queued: queue.length });
});

// Hold an exact 8-bit string on the pins (sent as typed, left to right) until released
app.post('/api/hold', (req, res) => {
  if (!requireKey(res)) return;
  const v = String(req.body.value || '');
  if (!/^[01]{8}$/.test(v)) return res.status(400).json({ error: 'need exactly 8 bits' });
  held = v;
  res.json({ held });
});

app.post('/api/release', (_req, res) => {
  held = null;
  res.json({ held });
});

app.post('/api/cancel', (_req, res) => {
  abandonChat(); // also drops an answer that is still being written
  queue = [];
  held = null;
  res.json({ queued: 0 });
});

app.get('/api/status', (_req, res) => {
  res.json({
    key: !!groqKey,
    model: GROQ_MODEL,
    prompt: customPrompt !== null ? 'custom' : 'default',
    memory: history.length / 2,
    memoryMax: MAX_HISTORY_TURNS,
    polls: pollStats(),
    sent: sentLog.join(''),
    queued: queue.length,
    code: last.code,
    clear: last.clear,
    value: held !== null ? held : toValue(last),
    input: lastIn,
    action: lastAction,
    glyph: held !== null ? 'HELD (test)' : last.clear ? 'CLEAR SCREEN' : glyph(last.code),
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
  details { background:#1c1c1c; border-radius:12px; padding:1rem; }
  summary { cursor:pointer; font-weight:600; }
</style>
<h1>Panel Text</h1>

<section id="keysec">
  <h2>1. Groq API key (required)</h2>
  <input id="key" type="password" placeholder="gsk_..." autocomplete="off">
  <button onclick="saveKey()">Save key</button>
  <button class="gray" onclick="forgetKey()">Forget key</button>
  <small>Get one at console.groq.com/keys. It is kept in the server's memory only (lost on restart). Nothing below works until a working key is set.</small>
  <div class="st" id="keyst">checking...</div>
</section>

<section id="chatsec">
  <h2>2. Message</h2>
  <input id="msg" type="text" placeholder="Say something..." autocomplete="off">
  <button id="sendbtn" class="needs-key" onclick="sendMsg()">Send</button>
  <button class="gray" onclick="clearMemory()">New conversation</button>
  <small>The panel shows your message first, then the reply under it. It remembers the last few messages.</small>
  <div class="st" id="reply"></div>
</section>

<section id="promptsec">
  <h2>3. AI prompt</h2>
  <textarea id="prompt" placeholder="Describe how the AI should behave..."></textarea>
  <label class="wrap"><input id="rules" type="checkbox" checked>Add the panel rules (one short line, only characters the panel can draw)</label>
  <button onclick="savePrompt()">Save prompt</button>
  <button class="gray" onclick="resetPrompt()">Reset to default</button>
  <small>Example: You are a grumpy pirate. Answer in pirate slang. Saving starts a new conversation. Leave the box empty and save to go back to the default. Kept in memory only (lost on restart).</small>
  <div class="st" id="promptst"></div>
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
    <h2>Control pins (test)</h2>
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

<script>
  var H = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' };
  var keySet = false;
  var sending = false;

  function num(id) { return parseInt(document.getElementById(id).value, 10) || 0; }

  async function post(path, body) {
    var r = await fetch(path, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
    var j = {};
    try { j = await r.json(); } catch (e) {}
    refresh();
    return j;
  }

  function applyKey(on) {
    keySet = !!on;
    var btns = document.querySelectorAll('.needs-key');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !keySet;
    var box = document.getElementById('keyst');
    box.textContent = keySet ? 'Key set - the panel is unlocked.' : 'No key set - everything is locked.';
    box.className = 'st ' + (keySet ? 'ok' : 'bad');
    document.getElementById('keysec').className = keySet ? '' : 'locked';
  }

  async function saveKey() {
    var el = document.getElementById('key');
    var k = el.value.trim();
    var box = document.getElementById('keyst');
    box.textContent = 'checking with Groq...';
    box.className = 'st';
    try {
      var r = await fetch('/api/key', { method: 'POST', headers: H, body: JSON.stringify({ key: k }) });
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

  // ---- AI prompt ----
  // Loaded once on page load (not on the 0.5 s refresh) so it never overwrites
  // what you are typing.
  async function loadPrompt() {
    try {
      var r = await fetch('/api/prompt', { headers: H });
      var p = await r.json();
      document.getElementById('prompt').value = p.prompt;
      document.getElementById('rules').checked = p.appendRules;
      var box = document.getElementById('promptst');
      box.textContent = p.custom ? 'Using your custom prompt.' : 'Using the default prompt.';
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
        headers: H,
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
    if (!msg || !keySet || sending) return;
    sending = true;
    var btn = document.getElementById('sendbtn');
    btn.disabled = true;
    out.textContent = 'thinking...';
    try {
      var r = await fetch('/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: msg }) });
      var j = await r.json();
      if (!r.ok) out.textContent = 'error: ' + (j.error || r.status);
      else { out.textContent = 'reply: ' + j.reply; box.value = ''; }
    } catch (e) {
      out.textContent = 'error: ' + e.message;
    }
    sending = false;
    btn.disabled = !keySet;
    refresh();
  }

  function sendText() { post('/api/text', { text: document.getElementById('text').value }); }
  function sendCode() { post('/api/code', { code: num('code') }); }
  function sweep() { post('/api/sweep', { from: num('from'), to: num('to') }); }
  function hold() { post('/api/hold', { value: document.getElementById('hold').value }); }

  async function refresh() {
    try {
      var r = await fetch('/api/status', { headers: H });
      var s = await r.json();
      applyKey(s.key);
      document.getElementById('st1').textContent = 'model: ' + s.model + ' | prompt: ' + s.prompt + ' | queued frames: ' + s.queued;
      document.getElementById('st2').textContent = 'memory: ' + s.memory + ' / ' + s.memoryMax + ' turns';
      document.getElementById('st3').textContent = 'on the pins: code ' + s.code + ' = ' + s.glyph + ' (clear bit ' + s.clear + ')';
      document.getElementById('st4').textContent = 'value: ' + s.value;
      var p = s.polls;
      document.getElementById('st5').textContent = 'polls/sec: ' + p.perSec + ' | longest gap (10 s): ' + p.maxGapMs + ' ms | last poll: ' + (p.agoMs === null ? 'none yet' : p.agoMs + ' ms ago') + ' | total: ' + p.total;
      document.getElementById('st6').textContent = 'callers of /out: ' + (p.clients.length ? p.clients.join('  ||  ') : 'none');
      document.getElementById('st7').textContent = 'sent to panel (newest last): ' + (s.sent || '(nothing yet)');
      document.getElementById('st8').textContent = 'posted by game: ' + (s.input || '(nothing yet)') + ' (pin 1 = interrupt, pin 2 = redo) | last action: ' + (s.action || 'none');
    } catch (e) {}
  }

  document.getElementById('msg').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendMsg();
  });

  loadPrompt();
  refresh();
  setInterval(refresh, 500);
</script>`;

app.get('/', (_req, res) => res.send(PAGE));

app.listen(PORT, () => {
  console.log('Panel page: http://localhost:' + PORT + '/ (password protected)');
  console.log('Game transmitter path: /out' + (OUT_TOKEN ? '?token=...' : ' (open)'));
  console.log(groqKey ? 'Groq key loaded from GROQ_API_KEY.' : 'No Groq key yet - set one on the page.');
  console.log(customPrompt !== null ? 'Custom prompt loaded from PANEL_PROMPT.' : 'Using the default prompt (change it on the page).');
});
