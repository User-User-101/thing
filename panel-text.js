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
// "4. AI prompt". It is kept per transmitter, in memory only. To start every new
// transmitter with a custom prompt, use PANEL_PROMPT="You are a pirate..." node panel-text.js
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
// ACCESS: there is no server-wide password any more. Instead, every request carries
// a "pass" header, and the value of that header identifies ONE transmitter (panel).
// In Build Logic, add this HTTP header to your HTTP Transmitter:
//
//     pass: my-secret-password
//
// The headers field on the transmitter takes a dictionary, so paste:
//
//     {"pass":"my-secret-password"}
//
// On the web page, type the SAME password under "1. Connect to a transmitter".
// That is the only password you need. The page itself is open; the password is what
// pairs it with your in-game transmitter. Any password works: type a new one and the
// server creates a new transmitter (a new empty panel); type an existing one and you
// are back on that panel, with its queue, history and prompt intact.
//
// MULTIPLE TRANSMITTERS: every different password is a separate panel. Each has its
// own frame queue, conversation, prompt, and diagnostics. So you can drive several
// in-game panels from the same server by giving each transmitter a different "pass"
// value, and controlling one at a time from the page (or one tab per panel).
//
// HTTP Transmitter in POST mode: the transmitter POSTs its own pin state to /out as
//   {"value":"00000000"}
// (with the pass header) and the server answers with the next panel frame, also as
//   {"value":"........"}.
// The FIRST characters of what you POST are control pins (first pin = leftmost):
//   pin 1 = INTERRUPT: stop the response that is being drawn (or still being thought up)
//   pin 2 = REDO:      ask the AI again for the last message and draw the new answer
// Both act once on the rising edge (0 -> 1), so holding a pin high does not repeat.
// The other 6 pins are ignored. GET /out also works, with the pass header (no controls).
//
// The Groq API key is REQUIRED and is shared by all transmitters on this server.
// Nothing is sent to a panel until a key is set and verified against api.groq.com.
//
// Output is an 8-bit string, leftmost bit first:
//   X S C5 C4 C3 C2 C1 C0
//   X      = clear screen. 1 only in the clear frame, 0 everywhere else.
//   S      = shift pin
//   C5..C0 = the 6 character pins
// Example: 'A' = 01000001, 'a' = 00000001, clear screen = 10000000, idle = 00000000.

const express = require('express');

const app = express();

// ======================= ACCESS CONTROL =======================

// The header every request must carry. The value is the password that identifies
// one transmitter. HTTP header names are case-insensitive, so the game sending
// "Pass: my-secret-password" arrives here as "pass".
const PASS_HEADER = 'pass';

// A password is used as a Map key and sent as a header, so keep it sane.
const MAX_PASSWORD_CHARS = 200;

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

// Read the password header from a request. Empty string means "none given".
function givenPassword(req) {
  const v = req.headers[PASS_HEADER];
  const raw = Array.isArray(v) ? String(v[0] || '') : (v === undefined || v === null ? '' : String(v));
  return raw.trim();
}

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
// The key is shared by every transmitter on this server.
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

// Every new transmitter starts with this prompt (null = the built-in default persona).
// Pre-fill it with PANEL_PROMPT="..." when starting the server.
const INITIAL_PROMPT = String(process.env.PANEL_PROMPT || '').trim().slice(0, MAX_PROMPT_CHARS) || null;

const SHORTEN_PROMPT =
  'That answer was cut off or too long. Reply again with the complete answer in under 48 characters. ' +
  'Keep complete words and complete sentences; shorten the wording instead of cutting anything off.';

// ======================= TRANSMITTERS =======================
//
// One transmitter per distinct "pass" header value. Everything that used to be
// per-server (queue, history, prompt, counters) now lives in an object in this
// Map. Functions that used to read globals take the transmitter as their first
// parameter.

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

    // ---- input (control pins) ----
    prevIn: null,
    lastIn: null,
    lastAction: '',

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

// Return the transmitter for a password, creating an empty one if it is new.
function getTransmitter(password) {
  let t = transmitters.get(password);
  if (!t) {
    t = makeTransmitter(password);
    transmitters.set(password, t);
  }
  t.lastUsedAt = Date.now();
  return t;
}

// Forget transmitters that no one has touched or polled for a long time, so a
// typo or a stranger poking at the tunnel does not keep an object forever.
function pruneTransmitters() {
  const now = Date.now();
  for (const [pass, t] of transmitters) {
    const last = Math.max(t.lastUsedAt || 0, t.lastPollAt || 0);
    if (now - last > TRANSMITTER_IDLE_MS) transmitters.delete(pass);
  }
}
const pruneTimer = setInterval(pruneTransmitters, 60 * 60 * 1000);
if (pruneTimer.unref) pruneTimer.unref();

// Every /api call must carry the pass header. The value selects (or creates) the
// transmitter, which the handler then works on. The page sends the same header
// it just showed you in the dictionary.
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

// What the panel draws for a code, for the page status line
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

// The clear frame is held CLEAR_HOLD polls, then CLEAR_SETTLE code-0 polls follow
// so the reset has time to finish before the first letter arrives.
function clearFrames() {
  return [...times({ clear: 1, code: 0 }, CLEAR_HOLD), ...times(blank(), CLEAR_SETTLE)];
}

// Each character is held for CHAR_FRAMES polls, with a code-0 gap (GAP_FRAMES polls)
// where the preset asks for one (see CIRCUIT). Reads t.queue / t.last so a gap is
// inserted correctly when frames are appended to an already non-empty queue.
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
// Compare this with what the panel drew. [CLR] = clear frame, · = blank cell.
function noteSent(t, frame) {
  if (frame.clear && !t.prevSent.clear) {
    t.sentLog.push('[CLR]');
  } else if (!frame.clear && frame.code !== 0 && frame.code !== t.prevSent.code) {
    t.sentLog.push(frame.code === SPACE_CODE ? '·' : (CHARS[frame.code] || '<' + frame.code + '>'));
  }
  while (t.sentLog.length > 80) t.sentLog.shift();
  t.prevSent = frame;
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

// A pin only fires on its rising edge (0 -> 1), so a transmitter that keeps
// POSTing the same "1" does not trigger it again on every poll.
function handleControlPins(t, bits) {
  t.lastIn = bits;
  if (t.prevIn !== null) {
    const rose = (i) => bits[i] === '1' && t.prevIn[i] === '0';
    if (rose(PIN_INTERRUPT)) interruptResponse(t);
    if (rose(PIN_REDO)) redoResponse(t);
  }
  t.prevIn = bits; // first POST only sets the baseline, so a pin that is already high at start does nothing
}

// The game calls this. The pass header chooses the transmitter. GET = plain poll.
// POST = the transmitter's pin state comes in the body and is handled first.
// Either way, each call consumes one frame from that transmitter's queue and the
// answer is {"value":"........"}.
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

  if (req.method === 'POST') {
    const bits = readInputBits(req);
    if (bits !== null) handleControlPins(t, bits);
  }
  if (t.held !== null) return res.json({ value: t.held });
  const frame = t.queue.length ? t.queue.shift() : blank(); // empty: always 00000000
  t.last = frame;
  noteSent(t, frame);
  res.json({ value: toValue(frame) });
}

app.route('/out').get(outHandler).post(outHandler);

// ======================= GROQ HELPERS =======================

// Everything that sends something to a panel needs a verified key.
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

function currentSystemPrompt(t) {
  const persona = t.customPrompt !== null ? t.customPrompt : DEFAULT_PERSONA;
  // The default persona always gets the panel rules; a custom prompt gets them
  // only when the box is ticked.
  if (t.customPrompt === null || t.appendRules) return persona.trim() + ' ' + PANEL_RULES;
  return persona.trim();
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
async function askGroq(t, message, hist = t.history) {
  const base = [
    { role: 'system', content: currentSystemPrompt(t) }, // default or the transmitter's prompt
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

// ======================= CONVERSATION HELPERS =======================

function pushHistory(t, role, content) {
  t.history.push({ role, content });
  const cap = MAX_HISTORY_TURNS * 2;
  if (t.history.length > cap) t.history = t.history.slice(-cap);
}

// Throw away any AI request that is still in flight (its answer is ignored when it
// arrives) and free the "busy" lock so new messages and REDO work straight away.
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
// Resolves to { reply } or { interrupted: true }; throws if Groq fails.
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

  // Remember this exchange only after a successful reply.
  if (redo) t.history = base.slice();
  pushHistory(t, 'user', message);
  pushHistory(t, 'assistant', reply);
  t.lastUserMessage = message;

  t.queue = []; // the new message replaces whatever was still being drawn
  if (CLEAR_BEFORE_TEXT) t.queue.push(...clearFrames());

  if (SHOW_INPUT) {
    // Echo only characters the panel can draw, so nothing turns into '?'
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

// ======================= API FOR THE WEB PAGE =======================

const n = (v, max) => Math.max(0, Math.min(max, Number(v) | 0));

// Set / clear the Groq key. A non-empty key is checked against api.groq.com first,
// so a typo is caught immediately instead of silently breaking every send.
// The key is shared by all transmitters on this server.
app.post('/api/key', async (req, res) => {
  const key = String(req.body.key || '').trim();

  if (!key) {
    groqKey = '';
    for (const t of transmitters.values()) clearHistory(t); // forgetting the key forgets every conversation
    return res.json({ ok: true, key: false, message: 'Key forgotten. Every panel is locked.' });
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

// Read the prompt currently in use by THIS transmitter (the page loads this).
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

// Set this transmitter's own prompt. An empty prompt goes back to the default.
// Changing the prompt also starts a fresh conversation for this transmitter.
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

// Same as the INTERRUPT / REDO pins, for testing from the page.
app.post('/api/interrupt', (req, res) => {
  interruptResponse(req.transmitter);
  res.json({ ok: true, queued: req.transmitter.queue.length });
});

app.post('/api/redo', (req, res) => {
  if (!requireKey(res)) return;
  redoResponse(req.transmitter);
  res.json({ ok: true, action: req.transmitter.lastAction });
});

// Forget this transmitter's conversation (the key is kept).
app.post('/api/memory/clear', (req, res) => {
  clearHistory(req.transmitter);
  res.json({ ok: true, memory: 0 });
});

app.post('/api/text', (req, res) => {
  const t = req.transmitter;
  if (!requireKey(res)) return;
  // Remove emoji variation selectors (arrows often arrive with one) and line breaks
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
  t.queue.push(...clearFrames());
  res.json({ queued: t.queue.length });
});

app.post('/api/code', (req, res) => {
  const t = req.transmitter;
  if (!requireKey(res)) return;
  t.queue.push(...buildFrames(t, [n(req.body.code, 127)]));
  res.json({ queued: t.queue.length });
});

// Sends every code from..to in order so you can watch what each one draws
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

// Hold an exact 8-bit string on this transmitter's pins until released
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
  <small>Type the same password you put in your in-game HTTP Transmitter. A new password creates a new transmitter (a separate panel); typing an existing one goes back to it. Each password has its own queue, conversation and prompt, so you can drive several panels from this server. Each browser tab remembers its own password, so open a second tab for a second panel.</small>
  <div class="st">Headers dictionary for the game's HTTP Transmitter:</div>
  <textarea id="dict" class="dict" readonly spellcheck="false" placeholder='{"pass":"your-password"}'></textarea>
  <button class="gray" onclick="copyDict()">Copy dictionary</button>
  <div class="st" id="passst">not connected</div>
</section>

<section id="keysec" class="locked">
  <h2>2. Groq API key (required)</h2>
  <input id="key" type="password" placeholder="gsk_..." autocomplete="off">
  <button onclick="saveKey()">Save key</button>
  <button class="gray" onclick="forgetKey()">Forget key</button>
  <small>Get one at console.groq.com/keys. It is kept in the server's memory only (lost on restart), and is shared by every transmitter on this server. No panel works until a working key is set.</small>
  <div class="st" id="keyst">not connected</div>
</section>

<section id="chatsec" class="locked">
  <h2>3. Message</h2>
  <input id="msg" type="text" placeholder="Say something..." autocomplete="off">
  <button id="sendbtn" class="needs-key" onclick="sendMsg()">Send</button>
  <button class="gray" onclick="clearMemory()">New conversation</button>
  <small>The panel shows your message first, then the reply under it. It remembers the last few messages of THIS transmitter.</small>
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
<div class="st" id="st9"></div>

<script>
  var H = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' };
  var PASS_HEADER = '${PASS_HEADER}';
  var pass = '';
  var passSet = false;
  var keySet = false;
  var sending = false;

  function num(id) { return parseInt(document.getElementById(id).value, 10) || 0; }

  function storedPass() { try { return sessionStorage.getItem('panelPass') || ''; } catch (e) { return ''; } }
  function setStoredPass(p) {
    try { if (p) sessionStorage.setItem('panelPass', p); else sessionStorage.removeItem('panelPass'); } catch (e) {}
  }

  // Headers for every request: the JSON bits plus the password in the pass header.
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

  // Enable/disable everything from the two gates: password entered, key set.
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
    document.getElementById('passsec').className = passSet ? '' : 'locked';
  }

  function applyKey(on) {
    keySet = !!on;
    var box = document.getElementById('keyst');
    box.textContent = !passSet ? 'not connected (enter a password first)'
      : (keySet ? 'Key set - the panel is unlocked.' : 'No key set - everything is locked.');
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

  // ---- AI prompt ----
  // Loaded after connecting (not on the 0.5 s refresh) so it never overwrites
  // what you are typing.
  async function loadPrompt() {
    if (!passSet) return;
    try {
      var r = await fetch('/api/prompt', { headers: passHeaders() });
      if (!r.ok) return;
      var p = await r.json();
      document.getElementById('prompt').value = p.prompt;
      document.getElementById('rules').checked = p.appendRules;
      var box = document.getElementById('promptst');
      box.textContent = p.custom ? 'Using this transmitter\'s custom prompt.' : 'Using the default prompt.';
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
      var box = document.getElementById('passst');
      var tr = s.transmitter;
      if (tr.lastPollAgoMs === null) {
        box.textContent = 'connected — the game has not polled with this password yet';
        box.className = 'st bad';
      } else {
        var sec = Math.round(tr.lastPollAgoMs / 1000);
        box.textContent = 'connected — game last polled ' + (sec < 1 ? 'just now' : sec + ' s ago');
        box.className = 'st ok';
      }
      document.getElementById('st1').textContent = 'model: ' + s.model + ' | prompt: ' + s.prompt + ' | queued frames: ' + s.queued;
      document.getElementById('st2').textContent = 'memory: ' + s.memory + ' / ' + s.memoryMax + ' turns (this transmitter)';
      document.getElementById('st3').textContent = 'on the pins: code ' + s.code + ' = ' + s.glyph + ' (clear bit ' + s.clear + ')';
      document.getElementById('st4').textContent = 'value: ' + s.value;
      var p = s.polls;
      document.getElementById('st5').textContent = 'polls/sec: ' + p.perSec + ' | longest gap (10 s): ' + p.maxGapMs + ' ms | last poll: ' + (p.agoMs === null ? 'none yet' : p.agoMs + ' ms ago') + ' | total: ' + p.total;
      document.getElementById('st6').textContent = 'callers of /out for this password: ' + (p.clients.length ? p.clients.join('  ||  ') : 'none');
      document.getElementById('st7').textContent = 'sent to panel (newest last): ' + (s.sent || '(nothing yet)');
      document.getElementById('st8').textContent = 'posted by game: ' + (s.input || '(nothing yet)') + ' (pin 1 = interrupt, pin 2 = redo) | last action: ' + (s.action || 'none');
      document.getElementById('st9').textContent = 'transmitters on this server: ' + tr.count + ' | this one created ' + new Date(tr.createdAt).toLocaleString();
    } catch (e) {}
  }

  document.getElementById('msg').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendMsg();
  });
  document.getElementById('pass').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') connect();
  });

  // Restore the password from this tab, if any. If the server has since forgotten
  // that transmitter, it just looks like a fresh empty one until the game polls.
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

app.listen(PORT, () => {
  const dictionary = JSON.stringify({ [PASS_HEADER]: '<your-password>' });
  console.log('Panel page: http://localhost:' + PORT + '/');
  console.log('Game transmitter path: /out');
  console.log('  Set this header on your HTTP Transmitter:  ' + PASS_HEADER + ': <your-password>');
  console.log('  Headers dictionary:  ' + dictionary);
  console.log('  Each different pass value is a separate panel with its own queue.');
  console.log('  The page itself is open. Type the same password into it to control that panel.');
  console.log(groqKey ? 'Groq key loaded from GROQ_API_KEY (shared by all transmitters).' : 'No Groq key yet - set one on the page.');
  console.log(INITIAL_PROMPT !== null ? 'New transmitters start with the PANEL_PROMPT prompt.' : 'New transmitters start with the default prompt (change it per panel on the page).');
});
