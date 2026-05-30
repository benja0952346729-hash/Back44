const { Bot } = require("grammy");
const { Pool } = require("pg");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const http = require("http");

// ==================== CONFIG ====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_ID  = parseInt(process.env.ADMIN_TELEGRAM_ID || "0");
const DATABASE_URL       = process.env.DATABASE_URL;
const GROQ_API_KEY       = process.env.GROQ_API_KEY;

// ==================== GEMINI KEY POOL ====================
const geminiKeys = [];
for (let i = 1; i <= 30; i++) {
  const key = process.env[`GEMINI_KEY_${i}`];
  if (key) geminiKeys.push({ key, exhausted: false, resetAt: null });
}
console.log(`✅ Gemini keys loaded: ${geminiKeys.length}`);

let geminiKeyIndex = 0;

function getNextGeminiKey() {
  const now = Date.now();
  // reset keys ሰዓቱ ካለፈ
  for (const k of geminiKeys) {
    if (k.exhausted && k.resetAt && now > k.resetAt) {
      k.exhausted = false;
      k.resetAt = null;
    }
  }
  // available key ፈልግ
  for (let i = 0; i < geminiKeys.length; i++) {
    const idx = (geminiKeyIndex + i) % geminiKeys.length;
    if (!geminiKeys[idx].exhausted) {
      geminiKeyIndex = (idx + 1) % geminiKeys.length;
      return { key: geminiKeys[idx].key, idx };
    }
  }
  return null; // ሁሉም exhausted
}

function markGeminiKeyExhausted(idx) {
  if (geminiKeys[idx]) {
    geminiKeys[idx].exhausted = true;
    geminiKeys[idx].resetAt = Date.now() + 60 * 1000; // 1 min reset
    console.log(`⚠️ Gemini key ${idx + 1} exhausted, switching...`);
  }
}

// ==================== GROQ CLIENT ====================
const groq = new Groq({ apiKey: GROQ_API_KEY });

async function groqCall(systemPrompt, userPrompt, maxTokens = 300, temperature = 0.1) {
  try {
    const completion = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim() || "";
    console.log("✅ Groq OK");
    return text;
  } catch (e) {
    console.error("❌ Groq error:", e.message);
    return "";
  }
}

// ==================== GEMINI CALL ====================
async function geminiCall(systemPrompt, userPrompt, maxTokens = 400) {
  let attempts = 0;
  while (attempts < geminiKeys.length) {
    const result = getNextGeminiKey();
    if (!result) {
      console.log("⚠️ All Gemini keys exhausted, falling back to Groq");
      return null; // Groq fallback
    }
    const { key, idx } = result;
    try {
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        systemInstruction: systemPrompt,
      });
      const response = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
      });
      const text = response.response.text().trim();
      console.log(`✅ Gemini key ${idx + 1} OK`);
      return text;
    } catch (e) {
      if (e.message?.includes("429") || e.message?.includes("quota") || e.message?.includes("RESOURCE_EXHAUSTED")) {
        markGeminiKeyExhausted(idx);
        attempts++;
        continue;
      }
      console.error(`❌ Gemini key ${idx + 1} error:`, e.message);
      attempts++;
    }
  }
  console.log("⚠️ All Gemini keys failed, falling back to Groq");
  return null;
}

// ==================== PATTERN MATCHER ====================
// ምሳሌዎቹን የሚመስሉ clear patterns → Groq
// አዲስ/ውስብስብ → Gemini

const CLEAR_PATTERNS = [
  // ቁጥር + keyword patterns
  /^\d{1,3}[\+]?\s*\w+\s*(bl|bel|yaz|hold|set|say|በል|ብለህ|ብላ|blo|bleh|yazlgn|yazlih|yazachew|yazachw|ያዝ)$/i,
  // slash separator
  /^\d{1,3}[\/\%]\d{1,3}/,
  // range patterns
  /\d{1,3}\s*(isk|to|end|wede|esk|eslk|-)\s*\d{1,3}/i,
  // simple number only
  /^\d{1,3}[\+]?$/,
  // cancel patterns
  /\d{1,3}.*?(arg|sriz|cancel|ሰርዝ|argew|srez)/i,
  // paid patterns
  /ከፈልኩ|paid|screenshot/i,
  // account patterns
  /አካውንት|account|akawnt|pay|ክፍያ|cbe|telebr|telebirr/i,
  // multiple numbers with slash
  /^\d{1,3}[\/\%\+]\d{1,3}[\/\%\+]?\d{0,3}/,
  // gmash/half/full + number
  /^(gmash|half|bgmash|ግማሽ|mulu|full|ሙሉ)?\s*\d{1,3}/i,
  // number + gmash/half/full
  /^\d{1,3}\s*(gmash|half|bgmash|ግማሽ|mulu|full|ሙሉ)/i,
  // ቢል/ቢያዝ commands
  /ቢል|ቢያዝ|ቢላ|ያዝልን|ያዝልኝ/,
  // h X isk Y range
  /^(h|hn|from)\s+\d{1,3}/i,
];

function isPatternMatch(message) {
  const msg = message.trim();
  for (const pattern of CLEAR_PATTERNS) {
    if (pattern.test(msg)) return true;
  }
  return false;
}

// ==================== REPLY HELPERS ====================

const FULL_REPLIES = [
  "እሺ ቤተሰብ ተይዟል 🙏",
  "እሺ 🙏 ገቢ",
  "ተይዟል ቤተሰብ 🙏",
];

function getFullReply(name) {
  const withName = `እሺ ${name} 🙏 ገቢ`;
  const all = [...FULL_REPLIES, withName];
  return all[Math.floor(Math.random() * all.length)];
}

function getHalfReply() {
  return "እሺ በግማሽ ተይዟል 🙏";
}

function getFullChangedReply() {
  return "ሙሉ ሆኗል 🙏";
}

function getP2JoinReply() {
  return "እሺ በግማሽ ተይዟል 🙏";
}

function getMixedClarifyReply(halfNums, fullNums) {
  const all = [...halfNums, ...fullNums].join(", ");
  const full = fullNums.join(", ");
  const opts = [
    `ሁሉንም በግማሽ ልያዝ? ወይስ ${full} ሙሉ ናቸው?`,
    `${full} ሙሉ ናቸው? ወይስ ሁሉም ግማሽ?`,
    `ቤተሰብ ሁሉም ግማሽ ናቸው (${all})? ወይስ አንዳንዱ ሙሉ?`,
  ];
  return opts[Math.floor(Math.random() * opts.length)];
}

// ==================== LOTTERY TEMPLATE ====================
const LOTTERY_TEMPLATE = `በ 400 ብር 5 ቁጥሮችን በተከታታይ በመያዝ እድሎን ይሞክሩ ለ 20 ሰው ብቻ ፈጣን ዕድል መልካም ዕድል

መደብ 👉በ 4️⃣0️⃣0️⃣ ብር 
       👉ግማሽ 2️⃣0️⃣0️⃣ ብር 

1ኛ 🥇5️⃣,0️⃣0️⃣0️⃣ ብር 
2ኛ 🥈1000
3ኛ 🥇400

{numbers}

CBE 1000641057146 biniyam dawit
አዋሽ  01335630641400
ዳሽን  5389857825011
ቴሌ ብር 0952346729`;

// ==================== DATABASE ====================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_rules (
        id         SERIAL PRIMARY KEY,
        rule       TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_chat_history (
        id         SERIAL PRIMARY KEY,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_chat_history (
        id         SERIAL PRIMARY KEY,
        user_id    BIGINT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lottery_state (
        id                  SERIAL PRIMARY KEY,
        slots               JSONB NOT NULL,
        lottery_message_id  BIGINT,
        chat_id             BIGINT,
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      INSERT INTO lottery_state (slots, lottery_message_id, chat_id)
      SELECT $1::jsonb, NULL, NULL
      WHERE NOT EXISTS (SELECT 1 FROM lottery_state)
    `, [JSON.stringify(buildEmptySlots())]);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_nicknames (
        user_id    BIGINT PRIMARY KEY,
        nickname   TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_bookings (
        id          SERIAL PRIMARY KEY,
        user_id     BIGINT NOT NULL,
        user_name   TEXT NOT NULL,
        chat_id     BIGINT NOT NULL,
        question    TEXT NOT NULL,
        context     JSONB NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS learned_patterns (
        id          SERIAL PRIMARY KEY,
        input       TEXT NOT NULL UNIQUE,
        output      JSONB NOT NULL,
        explanation TEXT,
        confidence  INT DEFAULT 1,
        confirmed   BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("✅ DB initialized");
  } catch (e) {
    console.error("❌ DB init error:", e);
  }
}

// ==================== LOTTERY STATE ====================

function makeEmptySlot(i) {
  const start = (i - 1) * 5 + 1;
  return {
    numbers: Array.from({ length: 5 }, (_, j) => start + j),
    type: null,
    p1_id: null, p1_name: null, p1_paid: false,
    p2_id: null, p2_name: null, p2_paid: false,
  };
}

function buildEmptySlots() {
  const slots = {};
  for (let i = 1; i <= 20; i++) slots[String(i)] = makeEmptySlot(i);
  return slots;
}

async function loadData() {
  try {
    const res = await pool.query(
      "SELECT slots, lottery_message_id, chat_id FROM lottery_state ORDER BY id LIMIT 1"
    );
    if (res.rows.length === 0) {
      return { slots: buildEmptySlots(), lottery_message_id: null, chat_id: null };
    }
    const row = res.rows[0];
    return {
      slots: row.slots,
      lottery_message_id: row.lottery_message_id,
      chat_id: row.chat_id,
    };
  } catch (e) {
    console.error("❌ loadData error:", e);
    return { slots: buildEmptySlots(), lottery_message_id: null, chat_id: null };
  }
}

async function saveData(data) {
  try {
    await pool.query(
      `UPDATE lottery_state
       SET slots = $1::jsonb,
           lottery_message_id = $2,
           chat_id = $3,
           updated_at = NOW()
       WHERE id = (SELECT id FROM lottery_state ORDER BY id LIMIT 1)`,
      [JSON.stringify(data.slots), data.lottery_message_id, data.chat_id]
    );
  } catch (e) {
    console.error("❌ saveData error:", e);
  }
}

async function resetSlots() {
  try {
    await pool.query(
      `UPDATE lottery_state
       SET slots = $1::jsonb, updated_at = NOW()
       WHERE id = (SELECT id FROM lottery_state ORDER BY id LIMIT 1)`,
      [JSON.stringify(buildEmptySlots())]
    );
  } catch (e) {
    console.error("❌ resetSlots error:", e);
  }
}

// ==================== PENDING BOOKINGS ====================

async function savePending(userId, userName, chatId, question, context) {
  try {
    await pool.query(
      `INSERT INTO pending_bookings (user_id, user_name, chat_id, question, context, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + INTERVAL '90 seconds')
       ON CONFLICT DO NOTHING`,
      [userId, userName, chatId, question, JSON.stringify(context)]
    );
  } catch (e) {
    console.error("❌ savePending error:", e);
  }
}

async function getPending(userId) {
  try {
    const res = await pool.query(
      `SELECT * FROM pending_bookings
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    return res.rows.length ? res.rows[0] : null;
  } catch (e) {
    console.error("❌ getPending error:", e);
    return null;
  }
}

async function deletePending(userId) {
  try {
    await pool.query("DELETE FROM pending_bookings WHERE user_id = $1", [userId]);
  } catch (e) {
    console.error("❌ deletePending error:", e);
  }
}

async function getExpiredPendings() {
  try {
    const res = await pool.query(
      `SELECT * FROM pending_bookings WHERE expires_at <= NOW()`
    );
    return res.rows;
  } catch (e) {
    return [];
  }
}

async function deleteExpiredPendings() {
  try {
    await pool.query("DELETE FROM pending_bookings WHERE expires_at <= NOW()");
  } catch (e) {
    console.error("❌ deleteExpiredPendings error:", e);
  }
}

// ==================== LEARNED PATTERNS ====================

async function saveLearnedPattern(input, output, explanation, confirmed = false) {
  try {
    await pool.query(
      `INSERT INTO learned_patterns (input, output, explanation, confidence, confirmed)
       VALUES ($1, $2::jsonb, $3, 1, $4)
       ON CONFLICT (input) DO UPDATE
         SET confidence = learned_patterns.confidence + 1,
             output = $2::jsonb,
             explanation = $3,
             confirmed = CASE WHEN learned_patterns.confidence + 1 >= 3 THEN TRUE ELSE $4 END,
             updated_at = NOW()`,
      [input.toLowerCase().trim(), JSON.stringify(output), explanation, confirmed]
    );
    console.log(`✅ Pattern learned: "${input}"`);
  } catch (e) {
    console.error("❌ saveLearnedPattern error:", e);
  }
}

async function getLearnedPattern(input) {
  try {
    const res = await pool.query(
      `SELECT * FROM learned_patterns
       WHERE input = $1 AND confirmed = TRUE`,
      [input.toLowerCase().trim()]
    );
    return res.rows.length ? res.rows[0] : null;
  } catch (e) {
    return null;
  }
}

async function loadConfirmedPatterns(limit = 30) {
  try {
    const res = await pool.query(
      `SELECT input, output, explanation FROM learned_patterns
       WHERE confirmed = TRUE
       ORDER BY confidence DESC LIMIT $1`,
      [limit]
    );
    return res.rows;
  } catch (e) {
    return [];
  }
}

async function buildLearnedPatternsText() {
  const patterns = await loadConfirmedPatterns();
  if (!patterns.length) return "";
  const lines = patterns.map(p =>
    `"${p.input}" → ${p.explanation || JSON.stringify(p.output)}`
  ).join("\n");
  return `\n========= የተማሩ Patterns =========\n${lines}\n`;
}

async function getNumberPendingByOther(number, userId) {
  try {
    const res = await pool.query(
      `SELECT * FROM pending_bookings
       WHERE user_id != $1
         AND expires_at > NOW()
         AND context->>'numbers' LIKE $2`,
      [userId, `%${number}%`]
    );
    return res.rows.length ? res.rows[0] : null;
  } catch (e) {
    return null;
  }
}

// ==================== ADMIN RULES ====================

async function loadAdminRules() {
  try {
    const res = await pool.query("SELECT rule FROM admin_rules ORDER BY id ASC");
    return res.rows.map(r => r.rule);
  } catch (e) {
    console.error("❌ loadAdminRules error:", e);
    return [];
  }
}

async function saveAdminRule(rule) {
  try {
    await pool.query("INSERT INTO admin_rules (rule) VALUES ($1)", [rule]);
  } catch (e) {
    console.error("❌ saveAdminRule error:", e);
  }
}

async function deleteAllAdminRules() {
  try {
    await pool.query("DELETE FROM admin_rules");
  } catch (e) {
    console.error("❌ deleteAllAdminRules error:", e);
  }
}

async function getUserNickname(userId) {
  try {
    const res = await pool.query(
      "SELECT nickname FROM user_nicknames WHERE user_id = $1", [userId]
    );
    return res.rows.length ? res.rows[0].nickname : null;
  } catch (e) {
    return null;
  }
}

async function saveUserNickname(userId, nickname) {
  try {
    await pool.query(
      `INSERT INTO user_nicknames (user_id, nickname)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET nickname = $2, updated_at = NOW()`,
      [userId, nickname]
    );
  } catch (e) {
    console.error("❌ saveUserNickname error:", e);
  }
}

async function buildAdminRulesText() {
  const rules = await loadAdminRules();
  if (!rules.length) return "";
  const lines = rules.map(r => `- ${r}`).join("\n");
  return `\n========= Admin ያስተማረኝ ህጎች =========\n${lines}\n`;
}

// ==================== CHAT HISTORY ====================

async function loadAdminChatHistory(limit = 20) {
  try {
    const res = await pool.query(
      "SELECT role, content FROM admin_chat_history ORDER BY id DESC LIMIT $1", [limit]
    );
    return res.rows.reverse().map(r => ({ role: r.role, content: r.content }));
  } catch (e) {
    return [];
  }
}

async function saveAdminChatMessage(role, content) {
  try {
    await pool.query(
      "INSERT INTO admin_chat_history (role, content) VALUES ($1, $2)", [role, content]
    );
  } catch (e) {
    console.error("❌ saveAdminChatMessage error:", e);
  }
}

async function clearAdminChatHistory() {
  try {
    await pool.query("DELETE FROM admin_chat_history");
  } catch (e) {
    console.error("❌ clearAdminChatHistory error:", e);
  }
}

async function loadUserChatHistory(userId, limit = 8) {
  try {
    const res = await pool.query(
      `SELECT role, content FROM user_chat_history
       WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
      [userId, limit]
    );
    return res.rows.reverse().map(r => ({ role: r.role, content: r.content }));
  } catch (e) {
    return [];
  }
}

async function saveUserChatMessage(userId, role, content) {
  try {
    await pool.query(
      "INSERT INTO user_chat_history (user_id, role, content) VALUES ($1, $2, $3)",
      [userId, role, content]
    );
  } catch (e) {
    console.error("❌ saveUserChatMessage error:", e);
  }
}

// ==================== DATA HELPERS ====================

function isSlotFullBooked(slot) {
  if (slot.type === "full") return true;
  if (slot.type === "half" && slot.p2_id !== null) return true;
  return false;
}

function getSlotByNumber(number, data) {
  for (const [slotId, slot] of Object.entries(data.slots)) {
    if (slot.numbers.includes(Number(number))) return [slotId, slot];
  }
  return [null, null];
}

function formatFirstLine(num, slot) {
  const n = String(num).padStart(2, "0") + "#";
  if (!slot.type) return n;
  if (slot.type === "full") {
    const mark = slot.p1_paid ? "✅" : "⏳";
    return `${n} ${slot.p1_name} ${mark}`;
  }
  const p1Name = slot.p1_name || "";
  const p1Mark = slot.p1_paid ? "✅" : "⏳";
  if (!slot.p2_id) return `${n} ${p1Name}+ ${p1Mark}`;
  const p2Name = slot.p2_name || "";
  const p2Mark = slot.p2_paid ? "✅" : "⏳";
  if (slot.p1_paid && slot.p2_paid) return `${n} ${p1Name}+${p2Name} ✅`;
  return `${n} ${p1Name}${p1Mark}+${p2Name}${p2Mark}`;
}

function buildNumbersText(data) {
  const groups = [];
  for (const slot of Object.values(data.slots)) {
    const lines = slot.numbers.map((num, idx) =>
      idx === 0 ? formatFirstLine(num, slot) : String(num).padStart(2, "0") + "#"
    );
    groups.push(lines.join("\n"));
  }
  return groups.join("\n\n");
}

function buildFullMessage(data) {
  return LOTTERY_TEMPLATE.replace("{numbers}", buildNumbersText(data));
}

function buildShortState(data) {
  const freeSlots = [], halfOpen = [], bookedInfo = [];

  for (const slot of Object.values(data.slots)) {
    const nums = slot.numbers;
    const rng  = `${nums[0]}-${nums[nums.length - 1]}`;
    if (!slot.type) {
      freeSlots.push(rng);
    } else if (slot.type === "half" && !slot.p2_id) {
      const p1Paid = slot.p1_paid ? "✅" : "⏳";
      halfOpen.push(`${rng}(${slot.p1_name}${p1Paid}+ክፍት)`);
    } else if (slot.type === "full") {
      const paid = slot.p1_paid ? "✅" : "⏳";
      bookedInfo.push(`${rng}:${slot.p1_name}(ID:${slot.p1_id})${paid}`);
    } else if (slot.type === "half" && slot.p2_id) {
      const p1p = slot.p1_paid ? "✅" : "⏳";
      const p2p = slot.p2_paid ? "✅" : "⏳";
      bookedInfo.push(`${rng}:${slot.p1_name}(ID:${slot.p1_id})${p1p}+${slot.p2_name}(ID:${slot.p2_id})${p2p}`);
    }
  }

  const filled = Object.values(data.slots).filter(isSlotFullBooked).length;
  const lines  = [`ጠቅላላ: ${filled}/20 ሞልቷል`];
  if (freeSlots.length)  lines.push(`ነፃ slots: ${freeSlots.join(", ")}`);
  if (halfOpen.length)   lines.push(`ግማሽ ክፍት: ${halfOpen.join(", ")}`);
  if (bookedInfo.length) lines.push(`የተያዙ: ${bookedInfo.join(" | ")}`);
  return lines.join("\n");
}

function getUserSlots(userId, data) {
  const result = [];
  for (const [slotId, slot] of Object.entries(data.slots)) {
    if (slot.p1_id === userId || slot.p2_id === userId) {
      result.push({ slotId, slot });
    }
  }
  return result;
}

// ==================== SYSTEM PROMPT BUILDER ====================

function buildSystemPrompt(bookingName, savedNick, userSlotsText, fullState, adminRules, historyText, learnedPatternsText = "") {
  return `አንተ ብልህ የሎተሪ AI ነህ። JSON ወይም FREE TEXT መልስ መስጠት ትችላለህ።

★★★ CRITICAL RULE — AI BRAIN FIRST ★★★
አንተ ሰው ነህ — ታስባለህ። JSON template ብቻ አይደለህ።
መልእክቱን አንብብ → INTENT ተረዳ → ትክክለኛ action ምረጥ → respond.
50% brain thinking + 50% JSON structure = perfect response.
JSON template ካልሸፈነው → አስብ፣ ትክክለኛ action ምረጥ። ታሪክ ተጠቀም።

nickname: ${savedNick ? `"${savedNick}"` : "የለም"}
የዚህ user slots: ${userSlotsText}
ሁኔታ: ${fullState}
${adminRules}
${learnedPatternsText}

የቅርብ ጊዜ ታሪክ:
${historyText}

════════════════════════════════════
 ★★★ NAME EXTRACTION — SUPER CRITICAL ★★★
════════════════════════════════════

ስም ማውጣት ህጎች — 100% accuracy ያስፈልጋል:

★ RULE 1: ቁጥር + ቃል + keyword = ስሙ ቃሉ ነው
★ RULE 2: "አንድ" "ሁለት" "ሦስት" = ቁጥር ቃሎች — ስም ሊሆኑ ይችላሉ! context ተጠቀም
★ RULE 3: ቁጥር ከሆነ (1,2,3...) ignore — ቃል ከሆነ = ስም
★ RULE 4: keyword በኋላ ያለ ቃል ሁሌ ስም ነው
★ RULE 5: ቁጥሩ ካለቀ በኋላ ያሉ ቃሎች ሁሉ ስም + keyword ናቸው

NAME BOOKING — ሁሉም pattern:
"01 አስቴር በል"           → number=1,  name=አስቴር,   type=full
"01 አንድ አስቴር በል"       → number=1,  name=አስቴር,   type=full
"01 አንድ አስቴር"          → number=1,  name=አስቴር,   type=full
"1 አስቴር bl"             → number=1,  name=አስቴር,   type=full
"01 astere bel"          → number=1,  name=astere,  type=full
"01 astere bl"           → number=1,  name=astere,  type=full
"01 astere yaz"          → number=1,  name=astere,  type=full
"01 bgmash astere bl"    → number=1,  name=astere,  type=half
"01 gmash astere bl"     → number=1,  name=astere,  type=half
"01 bgmash አስቴር በል"     → number=1,  name=አስቴር,   type=half
"01 half astere"         → number=1,  name=astere,  type=half
"21 dawit bel"           → number=21, name=dawit,   type=full
"21 dawit bl"            → number=21, name=dawit,   type=full
"21 ዳዊት በል"             → number=21, name=ዳዊት,    type=full
"21 ዳዊት ብለህ ያዝ"        → number=21, name=ዳዊት,    type=full
"21 bgmash ዳዊት bl"      → number=21, name=ዳዊት,    type=half
"21+ dawit"              → number=21, name=dawit,   type=half
"21+ ዳዊት"               → number=21, name=ዳዊት,    type=half
"31 bgmash chaltu bl"    → number=31, name=chaltu,  type=half
"51 bgmash liya yazlgn"  → number=51, name=liya,    type=half
"76 ሙሉ በላይ"             → number=76, name=በላይ,    type=full
"96 sara full"           → number=96, name=sara,    type=full
"11 abebe gmash"         → number=11, name=abebe,   type=half
"61 meron mulu"          → number=61, name=meron,   type=full
"81 selam bleh yaz"      → number=81, name=selam,   type=full
"41+ tigist bl"          → number=41, name=tigist,  type=half
"16+ liya yazlgn"        → number=16, name=liya,    type=half
"71gmash sara blo"       → number=71, name=sara,    type=half
"06 full kalkidan bl"    → number=6,  name=kalkidan,type=full
"56+ yared set"          → number=56, name=yared,   type=half
"26 hold biruk"          → number=26, name=biruk,   type=full
"46 ግማሽ meseret ብላ"     → number=46, name=meseret, type=half
"86 amara say"           → number=86, name=amara,   type=full
"66+ nati yazlih"        → number=66, name=nati,    type=half
"76 ሙሉ kidist blo"       → number=76, name=kidist,  type=full
"31 ግማሽ abdi ብለህ ያዝ"   → number=31, name=abdi,    type=half
"96 ቀጥታ ስሙ abel"        → number=96, name=abel,    type=full
"01 grmash hewan bl"     → number=1,  name=hewan,   type=half
"11 tsion full yaz"      → number=11, name=tsion,   type=full

★ "አንድ/ሁለት/ሦስት" ambiguity rule:
"01 አንድ አስቴር" → 01=slot, አንድ=filler, አስቴር=ስም
"01 አንድ" → keyword ካለ = name=አንድ; ካልሆነ = filler
"21 ሁለት ሳራ bl" → 21=slot, ሁለት=filler, ሳራ=ስም
"21 ሁለት bl" → 21=slot, ሁለት=ስም

★★★ NO-SPACE PATTERNS — CRITICAL ★★★
"21+41አቤል"    → 21=half, 41=full name=አቤል → ask_clarify
"21+41+አቤል"   → numbers=21,41  name=አቤል  type=half → book_multiple
"21+አቤል"      → number=21  name=አቤል  type=half
"31አቤል"       → number=31  name=አቤል  type=full
"56/66yazachew" → numbers=56,66  name=${bookingName}  type=full (yazachew=command)

★★★ EACH NUMBER HAS OWN NAME ★★★
"31በሙሉ አቤል 11begmas አስጎም አቤል" →
  31=full name=አቤል, 11=half name=አቤል (አስጎም=same name)
"21 mulu dawit 31 gmash sara" → 21=full name=dawit, 31=half name=sara
"11 abel 21+ tigist"          → 11=full name=abel,  21=half name=tigist

════════════════════════════════════
 LANGUAGE UNDERSTANDING
════════════════════════════════════

HALF keywords: +, g, ግ, ግማ, ግማሽ, half, gmash, haf, gmas, gem, gm, 1/2, gmsh, grash, bgmash, bgramash, bgmsh
FULL keywords: ምልክት የለም፣ mulu, full, ሙሉ, fll, mul, mlu, fuul, fful, mluu

CANCEL keywords: ሰርዝ, cancel, sriz, remove, arg, argew, del, delete, alfelgm, srez, kansel, cncel, rmove, delet, srz, lflegm

CHANGE keywords: ቀይር, change, swap, replace, to, ወደ, mkeyir, chng, chage, swp, replce, keyir, kyr, wede, chanje

NAME BOOKING keywords: በል, ብለህ, ብላ, bleh, blo, bl, yaz, hold, set, say, ስም, name, ነው, ብሎ, yazlign, yazlih, yazlgn, bhlo, yazlh, bel, yazachew, yazachw

★★★ AMHARIC ACTION WORDS — ስም አይደሉም! ★★★
ቢል = ቢያዝ = ያዝ = book/hold (NOT a name!)
ቢላ = ቢያዘው = ያዝ
ያዝልን = ያዝልኝ = ይያዝልኝ = ቁጥሩን ያዝ = command
አስጎም = እሱንም = እሷንም = ደሞ = እንዲሁ = same name as before
asgom = same name as before
yazachew = yazlign = ያዝልኝ = command (NOT a name!)
★ RULE: keyword (bl/bel/በል...) ከ yazachew በኋላ ካለ → yazachew ስም ነው
★ RULE: keyword ከሌለ → yazachew command ነው = name=${bookingName}

"65/21/41 ቢል"   → numbers=65,21,41  type=full  name=${bookingName}
"21 ቢል"         → number=21  type=full  name=${bookingName}
"21 ቢያዝ"        → number=21  type=full  name=${bookingName}
"21+ ቢል"        → number=21  type=half  name=${bookingName}
"51 yazachew bl" → name=yazachew  type=full
"51 yazachew በል"→ name=yazachew  type=full
"51%56 yazachew"→ numbers=51,56  name=${bookingName}  type=full (yazachew=command)

ACCOUNT/PAYMENT: አካውንት, account, akawnt, pay, ክፍያ, bank, cbe, telebr, telebirr

════════════════════════════════════
 ★★★ RANGE UNDERSTANDING — CRITICAL ★★★
════════════════════════════════════

ቡድኖች: 1-5, 6-10, 11-15, 16-20, 21-25, 26-30, 31-35, 36-40, 41-45, 46-50,
        51-55, 56-60, 61-65, 66-70, 71-75, 76-80, 81-85, 86-90, 91-95, 96-100

★★★ RANGE + TYPE DETECTION ★★★
"h X isk Y" → h=from(ignore), X=number, type=FULL
"isk" "until" "to" "end" "al end" "wede" "esk" "eslk" = range connectors = FULL slot
"hn" "h" before number = range start, NOT half!

RANGE examples — ሙሉ:
"h 51 isk 55" → number=51, type=full
"51 isk 55"   → number=51, type=full
"51 to 55"    → number=51, type=full
"51-55 full"  → number=51, type=full
"h 21 isk 25" → number=21, type=full

RANGE examples — ግማሽ (+ ወይም gmash ካለ):
"h 51 isk 55 gmash" → number=51, type=half
"51 isk 55 half"    → number=51, type=half
"h 51 isk 55+"      → number=51, type=half

"01-05" → number=1   "51-55" → number=51  "96-100" → number=96

════════════════════════════════════
 BOOKING RULES
════════════════════════════════════

── CASE 1: ነፃ slot ──
ግማሽ → book_half_p1 | ሙሉ → book_full

★ ብዙ ቁጥር:
"21 31 41"    → book_multiple ሁሉም full
"21+ 31+ 41+" → book_multiple ሁሉም half
"21 31+ 41"   → mixed → ask_clarify
"21 31"       → book_multiple ሁለቱም full

★★★ SLASH "/" OR "%" SEPARATOR ★★★
slash "/" or "%" = ሁለት የተለያዩ ቁጥሮች → book_multiple!
"51%56 sara"  → numbers=51,56  name=sara  type=full
"51%56+"      → numbers=51,56  type=half
"56/66"       → numbers=56,66  type=full
"21/31 dawit" → numbers=21,31  name=dawit type=full
"11/21/31 abel"→ numbers=11,21,31 name=abel type=full

── CASE 2: የራሱ ቁጥር ዳግም ──
ሙሉ ያዘ + ዳግም ሙሉ → "ቀድሞ ይዘሃል ቤተሰብ 🙏"
ሙሉ ያዘ + "+" → change_type half
ግማሽ ያዘ + ምልክት የለም → change_type full

★★★ CANCEL MULTIPLE ★★★
"71 81 arg"     → cancel_multiple numbers=[71,81]
"71/81 arg"     → cancel_multiple numbers=[71,81]
"21 31 41 sriz" → cancel_multiple numbers=[21,31,41]
cancel_multiple JSON: {"action":"cancel_multiple","numbers":[71,81],"reply":"እሺ ሁሉም ተሰርዟል 🙏"}

★★★ VAGUE CHANGE ★★★
"ቀይር"/"change" ብቻ → ask_clarify
"21 ቀይር" → ask_clarify (ወደ ምን?)
"21 ወደ 31" → cancel_and_rebook
"21 ሙሉ"   → change_type full
"21+"       → change_type half

── CASE 3: ሌላ user ግማሽ slot → book_half_p2
── CASE 4: MIXED AMBIGUOUS → ask_clarify
── CASE 5: CONTINUATION — ታሪክ ተጠቀም

════════════════════════════════════
 OTHER INTENTS
════════════════════════════════════

አካውንት/payment:
{"action":"reply","reply":"💳 የክፍያ አካውንቶች:\n\nCBE 1000641057146 biniyam dawit\nቴሌ ብር 0952346729"}

ሰርዝ: {"action":"cancel","number":X,"reply":"እሺ ተሰርዟል 🙏"}
ቀይር: {"action":"cancel_and_rebook","cancel_number":X,"book_number":Y,"book_type":"full","name":"${bookingName}","reply":"እሺ ቀይረናል 🙏"}

SLOT STATUS:
"21 አለ?" → free: {"action":"reply","reply":"✅ 21 ነፃ ነው!"}
          → taken: {"action":"reply","reply":"❌ 21 ተይዟል"}

ክፍያ: {"action":"reply","reply":"ተቀብዬአለሁ ✅ Admin ያረጋግጣል"}
የራሱ slot: {"action":"reply","reply":"የያዝካቸው ቁጥሮች: [ዝርዝር] 🙏"}
NICKNAME: {"action":"save_nickname","nickname":"[ስም]","reply":"እሺ ተቀይሯል 🙏"}

CHANGE TYPE:
አንድ: {"action":"change_type","number":X,"new_type":"full","reply":"ሙሉ ሆኗል 🙏"}
ብዙ:  {"action":"change_type_multiple","numbers":[X,Y],"new_type":"full","reply":"ሁሉም ሙሉ ሆኑ 🙏"}

════════════════════════════════════
 IMPORTANT RULES
════════════════════════════════════
- የተያዘ ቁጥር (ሌላ ሰው) → {"action":"reply","reply":"ተቀድመሃል ቤተሰብ 🙏"}
- ቅሬታ/ስድብ → {"action":"reply","reply":"እኔ የቢንያም online አጋዝ robot ነኝ ለማንኛውም ጥያቄ በ 0952346729 ይደውሉ 😍"}
- screenshot → {"action":"reply","reply":"ተቀብዬአለሁ ✅ Admin ያረጋግጣል"}
- ሎተሪ ካልሆነ → {"action":"ignore"}
- leading zero: "01"=1
- nickname ካለ ሁሌ nickname ተጠቀም
- reply field ሁሌ ሙሉ አማርኛ

JSON ብቻ ምለስ (ምንም explanation አትጨምር):`;
}

// ==================== ADMIN CHAT ====================

async function adminGroqChat(userMessage, data) {
  const fullState  = buildShortState(data);
  const adminRules = await buildAdminRulesText();
  const history    = await loadAdminChatHistory(15);

  const historyText = history.length
    ? history.map(m => `${m.role === "user" ? "Admin" : "Bot"}: ${m.content}`).join("\n")
    : "";

  const systemPrompt = `አንተ ሙሉ የሎተሪ ስርዓት AI ነህ። Admin ጋር private ታወራለህ።
ሁሉንም ታወቃለህ — slots፣ ተጫዋቾች፣ ክፍያ፣ ህጎች።

የሎተሪ ሁኔታ:
${fullState}

የተመዘገቡ ህጎች: ${adminRules || "ምንም"}

ታሪክ:
${historyText}

መመሪያ:
- አማርኛ ብቻ ተጠቀም
- ህግ ሲጨምር → [SAVE_RULE: ህጉን ፃፍ]
- ህጎች ሲሰረዙ → [DELETE_RULES]
- አጭር፣ ግልጽ መልስ ስጥ`;

  return groqCall(systemPrompt, userMessage, 400, 0.3);
}

function processAdminResponse(response) {
  const newRules = [];
  let deleteAll  = false;
  let clean      = response;

  const ruleMatches = [...response.matchAll(/\[SAVE_RULE:\s*(.+?)\]/g)];
  for (const m of ruleMatches) {
    if (m[1].trim()) newRules.push(m[1].trim());
  }
  clean = clean.replace(/\[SAVE_RULE:\s*.+?\]/g, "").trim();

  if (response.includes("[DELETE_RULES]")) {
    deleteAll = true;
    clean = clean.replace("[DELETE_RULES]", "").trim();
  }

  return { clean, newRules, deleteAll };
}

// ==================== AI ROUTER ====================

async function parseAIResponse(raw) {
  if (!raw) return { action: "reply", reply: "❌ ጊዜያዊ ችግር አለ። ቆይተህ ሞክር።" };
  try {
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    const match = clean.match(/\{.*\}/s);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.error("❌ AI parse error:", e);
  }
  return { action: "reply", reply: "❌ ጊዜያዊ ችግር አለ። ቆይተህ ሞክር።" };
}

async function aiBrain(userMessage, userId, userName, data) {
  const fullState   = buildShortState(data);
  const adminRules  = await buildAdminRulesText();
  const savedNick   = await getUserNickname(userId);
  const bookingName = savedNick || userName;
  const userHistory = await loadUserChatHistory(userId, 8);
  const userSlots   = getUserSlots(userId, data);

  const historyText = userHistory.length
    ? userHistory.map(m => `${m.role === "user" ? "User" : "Bot"}: ${m.content}`).join("\n")
    : "ምንም ታሪክ የለም";

  const userSlotsText = userSlots.length
    ? userSlots.map(({ slot }) => {
        const nums = slot.numbers;
        return `${nums[0]}-${nums[nums.length-1]}(${slot.type === "half" ? "ግማሽ" : "ሙሉ"})`;
      }).join(", ")
    : "ምንም";

  // ★ Step 1: Learned pattern ፈልግ — exact match
  const learned = await getLearnedPattern(userMessage);
  if (learned) {
    console.log(`📚 Learned pattern hit: "${userMessage}"`);
    // name/userId inject
    const output = { ...learned.output };
    if (!output.name) output.name = bookingName;
    if (output.bookings) {
      output.bookings = output.bookings.map(b => ({ ...b, name: b.name || bookingName }));
    }
    return output;
  }

  // ★ Step 2: Learned patterns → system prompt ውስጥ ጨምር
  const learnedPatternsText = await buildLearnedPatternsText();

  const systemPrompt = buildSystemPrompt(bookingName, savedNick, userSlotsText, fullState, adminRules, historyText, learnedPatternsText);
  const userPrompt = `ተጠቃሚ: ${userName} (ID:${userId})\nመልእክት: "${userMessage}"`;

  const useGroq = isPatternMatch(userMessage);
  console.log(`🔀 Router: ${useGroq ? "GROQ (pattern match)" : "GEMINI (new/complex)"}`);

  let raw = null;

  if (useGroq) {
    raw = await groqCall(systemPrompt, userPrompt, 400, 0.7);
    console.log("🧠 Groq raw:", raw);
  } else {
    raw = await geminiCall(systemPrompt, userPrompt, 400);
    if (raw) {
      console.log("🧠 Gemini raw:", raw);
      // ★ Step 3: Gemini ስለሰራ → pattern ለማስቀምጥ ሞክር (unconfirmed — confidence ሲደርስ 3 auto-confirm)
      try {
        const clean = raw.replace(/```(?:json)?/g, "").trim();
        const match = clean.match(/\{.*\}/s);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (parsed.action && parsed.action !== "ignore" && parsed.action !== "reply") {
            await saveLearnedPattern(userMessage, parsed, `auto: ${parsed.action}`, false);
          }
        }
      } catch(e) {}
    } else {
      console.log("🔄 Fallback to Groq");
      raw = await groqCall(systemPrompt, userPrompt, 400, 0.7);
      console.log("🧠 Groq fallback raw:", raw);
    }
  }

  return parseAIResponse(raw);
}

// ==================== PENDING TIMEOUT RESOLVER ====================

async function resolvePendingWithBestGuess(pending, bot) {
  try {
    const data = await loadData();
    const context = pending.context;
    const userId = pending.user_id;
    const userName = pending.user_name;
    const chatId = pending.chat_id;

    const bookings = [];

    if (context.confirmed_bookings && context.confirmed_bookings.length) {
      for (const b of context.confirmed_bookings) bookings.push(b);
    }
    if (context.unclear_numbers && context.unclear_numbers.length) {
      for (const num of context.unclear_numbers) bookings.push({ number: num, type: "full" });
    }

    let changed = false;
    const savedNick = await getUserNickname(userId);
    const bookingName = savedNick || userName;

    for (const b of bookings) {
      const [slotId, slot] = getSlotByNumber(b.number, data);
      if (slotId && !slot.type) {
        Object.assign(data.slots[slotId], {
          type: b.type === "half" ? "half" : "full",
          p1_id: userId, p1_name: bookingName, p1_paid: false,
          p2_id: null, p2_name: null, p2_paid: false,
        });
        changed = true;
      }
    }

    if (changed) {
      await saveData(data);
      await updateLotteryMessage(data);
      const nums = bookings.map(b => b.number).join(", ");
      await bot.api.sendMessage(chatId, `⏰ ${bookingName}፣ ምላሽ ስላልሰጠህ/ሽ በግምት ይዤልሃለሁ (${nums}) 🙏`);

      const userSlots = getUserSlots(userId, data);
      for (const { slot } of userSlots) {
        if (slot.type === "half" && !slot.p2_id) {
          await bot.api.sendMessage(chatId, `ቤተሰብ ${slot.numbers[0]} በግማሽ ነው፣ ሌላ ሰው ቢፈልግ ልቀላቀል ይችላል 🙏`);
          break;
        }
      }
    }

    await deletePending(userId);
  } catch (e) {
    console.error("❌ resolvePending error:", e);
  }
}

// ==================== EXECUTOR ====================

function executeAction(actionData, userId, data) {
  const action = actionData.action || "reply";
  const reply  = actionData.reply || "";
  const number = actionData.number;
  const name   = actionData.name || "ተጠቃሚ";
  const which  = actionData.which || 1;
  let changed  = false;

  if (action === "book_full" && number) {
    const [slotId, slot] = getSlotByNumber(number, data);
    if (slotId && !slot.type) {
      Object.assign(data.slots[slotId], {
        type: "full", p1_id: userId, p1_name: name, p1_paid: false,
        p2_id: null, p2_name: null, p2_paid: false,
      });
      changed = true;
    }
  } else if (action === "book_half_p1" && number) {
    const [slotId, slot] = getSlotByNumber(number, data);
    if (slotId && !slot.type) {
      Object.assign(data.slots[slotId], {
        type: "half", p1_id: userId, p1_name: name, p1_paid: false,
        p2_id: null, p2_name: null, p2_paid: false,
      });
      changed = true;
    }
  } else if (action === "book_half_p2" && number) {
    const [slotId, slot] = getSlotByNumber(number, data);
    if (slotId && slot.type === "half" && !slot.p2_id) {
      Object.assign(data.slots[slotId], { p2_id: userId, p2_name: name, p2_paid: false });
      changed = true;
    }
  } else if (action === "book_multiple") {
    const bookings = actionData.bookings || [];
    for (const b of bookings) {
      const num   = b.number;
      const btype = b.type || "full";
      const bname = b.name || name;
      if (!num) continue;
      const [slotId, slot] = getSlotByNumber(num, data);
      if (slotId && !slot.type) {
        Object.assign(data.slots[slotId], {
          type: btype === "half" ? "half" : "full",
          p1_id: userId, p1_name: bname, p1_paid: false,
          p2_id: null, p2_name: null, p2_paid: false,
        });
        changed = true;
      }
    }
  } else if (action === "cancel" && number) {
    const [slotId, slot] = getSlotByNumber(number, data);
    if (slotId && slot.type) {
      if (slot.p1_id === userId) {
        if (slot.type === "half" && slot.p2_id) {
          Object.assign(data.slots[slotId], {
            p1_id: slot.p2_id, p1_name: slot.p2_name, p1_paid: slot.p2_paid,
            p2_id: null, p2_name: null, p2_paid: false,
          });
        } else {
          const nums = slot.numbers;
          data.slots[slotId] = makeEmptySlot(parseInt(slotId));
          data.slots[slotId].numbers = nums;
        }
        changed = true;
      } else if (slot.type === "half" && slot.p2_id === userId) {
        Object.assign(data.slots[slotId], { p2_id: null, p2_name: null, p2_paid: false });
        changed = true;
      }
    }
  } else if (action === "cancel_multiple") {
    const numbers = actionData.numbers || [];
    for (const num of numbers) {
      const [slotId, slot] = getSlotByNumber(num, data);
      if (slotId && slot.type) {
        if (slot.p1_id === userId) {
          if (slot.type === "half" && slot.p2_id) {
            Object.assign(data.slots[slotId], {
              p1_id: slot.p2_id, p1_name: slot.p2_name, p1_paid: slot.p2_paid,
              p2_id: null, p2_name: null, p2_paid: false,
            });
          } else {
            const nums = slot.numbers;
            data.slots[slotId] = makeEmptySlot(parseInt(slotId));
            data.slots[slotId].numbers = nums;
          }
          changed = true;
        } else if (slot.type === "half" && slot.p2_id === userId) {
          Object.assign(data.slots[slotId], { p2_id: null, p2_name: null, p2_paid: false });
          changed = true;
        }
      }
    }
  } else if (action === "cancel_and_rebook") {
    const cancelNum = actionData.cancel_number;
    const bookNum   = actionData.book_number;
    const bookType  = actionData.book_type || "full";
    if (cancelNum) {
      const [slotId, slot] = getSlotByNumber(cancelNum, data);
      if (slotId && (slot.p1_id === userId || slot.p2_id === userId)) {
        if (slot.p1_id === userId) {
          if (slot.type === "half" && slot.p2_id) {
            Object.assign(data.slots[slotId], {
              p1_id: slot.p2_id, p1_name: slot.p2_name, p1_paid: slot.p2_paid,
              p2_id: null, p2_name: null, p2_paid: false,
            });
          } else {
            const nums = slot.numbers;
            data.slots[slotId] = makeEmptySlot(parseInt(slotId));
            data.slots[slotId].numbers = nums;
          }
        } else {
          Object.assign(data.slots[slotId], { p2_id: null, p2_name: null, p2_paid: false });
        }
        changed = true;
      }
    }
    if (bookNum) {
      const [slotId2, slot2] = getSlotByNumber(bookNum, data);
      if (slotId2 && !slot2.type) {
        Object.assign(data.slots[slotId2], {
          type: bookType === "half" ? "half" : "full",
          p1_id: userId, p1_name: name, p1_paid: false,
          p2_id: null, p2_name: null, p2_paid: false,
        });
        changed = true;
      }
    }
  } else if (action === "mark_paid" && number) {
    const [slotId, slot] = getSlotByNumber(number, data);
    if (slotId && slot.type) {
      if (which === 2 && slot.p2_id) {
        data.slots[slotId].p2_paid = true;
      } else {
        data.slots[slotId].p1_paid = true;
      }
      changed = true;
    }
  } else if (action === "change_type" && number) {
    const [slotId, slot] = getSlotByNumber(number, data);
    if (slotId && slot.type) {
      if (actionData.new_type === "full") {
        data.slots[slotId].type = "full";
        data.slots[slotId].p2_id = null;
        data.slots[slotId].p2_name = null;
        data.slots[slotId].p2_paid = false;
      } else if (actionData.new_type === "half") {
        data.slots[slotId].type = "half";
        data.slots[slotId].p2_id = null;
        data.slots[slotId].p2_name = null;
        data.slots[slotId].p2_paid = false;
      }
      changed = true;
    }
  } else if (action === "change_type_multiple") {
    const numbers = actionData.numbers || [];
    const newType = actionData.new_type || "full";
    for (const num of numbers) {
      const [slotId, slot] = getSlotByNumber(num, data);
      if (slotId && slot.type) {
        if (newType === "full") {
          data.slots[slotId].type = "full";
          data.slots[slotId].p2_id = null;
          data.slots[slotId].p2_name = null;
          data.slots[slotId].p2_paid = false;
        } else if (newType === "half") {
          data.slots[slotId].type = "half";
          data.slots[slotId].p2_id = null;
          data.slots[slotId].p2_name = null;
          data.slots[slotId].p2_paid = false;
        }
        changed = true;
      }
    }
  }

  return { data, reply, changed };
}

// ==================== BOT ====================

const bot = new Bot(TELEGRAM_BOT_TOKEN);

async function updateLotteryMessage(data) {
  if (data.lottery_message_id && data.chat_id) {
    try {
      await bot.api.editMessageText(
        data.chat_id,
        data.lottery_message_id,
        buildFullMessage(data)
      );
    } catch (e) {
      console.error("Message update error:", e.message);
    }
  }
}

bot.command("start_lottery", async (ctx) => {
  if (ctx.from.id !== ADMIN_TELEGRAM_ID) {
    await ctx.reply("❌ Admin ብቻ።");
    return;
  }
  await resetSlots();
  const data = await loadData();
  const sent = await ctx.reply(buildFullMessage(data));
  data.lottery_message_id = sent.message_id;
  data.chat_id = ctx.chat.id;
  await saveData(data);
  await ctx.reply("✅ ሎተሪ ጀምሯል!");
});

bot.command("paid", async (ctx) => {
  if (ctx.from.id !== ADMIN_TELEGRAM_ID) return;
  const args = ctx.match ? ctx.match.trim().split(/\s+/) : [];
  if (!args.length || !args[0]) {
    await ctx.reply("አጠቃቀም: /paid <ቁጥር> [2]");
    return;
  }
  const number = parseInt(args[0]);
  if (isNaN(number)) {
    await ctx.reply("❌ ቁጥር ብቻ ፃፍ");
    return;
  }
  const which = args[1] ? parseInt(args[1]) : 1;
  const data  = await loadData();
  const actionData = { action: "mark_paid", number, which, reply: "" };
  const result = executeAction(actionData, ctx.from.id, data);
  if (result.changed) {
    await saveData(result.data);
    await updateLotteryMessage(result.data);
    const [, slot] = getSlotByNumber(number, result.data);
    const paidName = which === 2 ? slot.p2_name : slot.p1_name;
    await ctx.reply(`✅ ${paidName} ክፍያ ተረጋግጧል!`);
  } else {
    await ctx.reply("❌ Slot አልተገኘም");
  }
});

bot.command("rules", async (ctx) => {
  if (ctx.from.id !== ADMIN_TELEGRAM_ID) return;
  const rules = await loadAdminRules();
  if (!rules.length) {
    await ctx.reply("📚 ምንም ህግ የለም።");
  } else {
    const text = "📚 ህጎች:\n\n" + rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
    await ctx.reply(text);
  }
});

bot.command("clear", async (ctx) => {
  if (ctx.from.id !== ADMIN_TELEGRAM_ID) return;
  await clearAdminChatHistory();
  await ctx.reply("🗑️ ታሪክ ተሰርዟል።");
});

bot.command("ai_status", async (ctx) => {
  if (ctx.from.id !== ADMIN_TELEGRAM_ID) return;
  const available = geminiKeys.filter(k => !k.exhausted).length;
  const exhausted = geminiKeys.filter(k => k.exhausted).length;
  // learned patterns count
  let learnedCount = 0;
  try {
    const res = await pool.query("SELECT COUNT(*) FROM learned_patterns WHERE confirmed = TRUE");
    learnedCount = parseInt(res.rows[0].count);
  } catch(e) {}
  await ctx.reply(`🤖 AI Status:\n\n✅ Gemini keys available: ${available}/${geminiKeys.length}\n⚠️ Exhausted: ${exhausted}\n✅ Groq: active\n📚 Learned patterns: ${learnedCount}`);
});

// /mkr command — admin correction → Gemini ይማራል
bot.command("mkr", async (ctx) => {
  if (ctx.from.id !== ADMIN_TELEGRAM_ID) return;
  const text = ctx.match ? ctx.match.trim() : "";
  if (!text) {
    await ctx.reply("አጠቃቀም:\n/mkr [wrong input] = [correct meaning]\n\nምሳሌ:\n/mkr 1121 bl = 11 እና 21 ሁለቱም full");
    return;
  }

  // format: "input = explanation"
  const eqIdx = text.indexOf("=");
  if (eqIdx === -1) {
    await ctx.reply("❌ '=' ያስፈልጋል። ምሳሌ: /mkr 1121 bl = 11 እና 21 ሁለቱም full");
    return;
  }

  const wrongInput  = text.substring(0, eqIdx).trim();
  const explanation = text.substring(eqIdx + 1).trim();

  if (!wrongInput || !explanation) {
    await ctx.reply("❌ input ወይም explanation ጎደለ።");
    return;
  }

  // Gemini ይጠቀም — pattern ተረዳ → JSON ሰጥ
  const systemPrompt = `አንተ የሎተሪ booking pattern analyzer ነህ።
Admin correction ሲሰጥህ → ትክክለኛ JSON action ስጥ።

Booking actions: book_full, book_half_p1, book_multiple, cancel, cancel_multiple, change_type
Numbers: 1-100 (slots: 1-5, 6-10, 11-15... each 5 numbers)

JSON ብቻ ምለስ። ምንም explanation አታክል።`;

  const userPrompt = `Admin correction:
Input: "${wrongInput}"
Meaning: "${explanation}"

ትክክለኛ JSON action ስጥ። ምሳሌ:
{"action":"book_multiple","bookings":[{"number":11,"type":"full"},{"number":21,"type":"full"}],"reply":"እሺ ሁሉም ተይዟል 🙏"}`;

  await ctx.reply("🧠 Gemini እየተማረ ነው...");

  let raw = await geminiCall(systemPrompt, userPrompt, 300);
  if (!raw) raw = await groqCall(systemPrompt, userPrompt, 300, 0.3);

  let output = null;
  try {
    const clean = (raw || "").replace(/```(?:json)?/g, "").trim();
    const match = clean.match(/\{.*\}/s);
    if (match) output = JSON.parse(match[0]);
  } catch(e) {}

  if (!output) {
    await ctx.reply("❌ Gemini ሊረዳ አልቻለም። ቆይተህ ሞክር።");
    return;
  }

  // DB ላይ ቀምጥ — confirmed=true (admin ስለሰጠ)
  await saveLearnedPattern(wrongInput, output, explanation, true);

  await ctx.reply(`✅ ተማርኩ!\n\n📥 Input: "${wrongInput}"\n📖 Meaning: ${explanation}\n🎯 Action: ${output.action}\n\nቀጣይ ጊዜ ይህን pattern ሲመጣ ትክክል ይሰራል! 🙏`);
});

bot.on("message:text", async (ctx) => {
  const rawText  = ctx.message.text.trim();
  const userId   = ctx.from.id;
  const userName = ctx.from.first_name || "ተጠቃሚ";
  const chatType = ctx.chat.type;
  const chatId   = ctx.chat.id;

  // ADMIN PRIVATE
  if (userId === ADMIN_TELEGRAM_ID && chatType === "private") {
    const data = await loadData();
    console.log(`🔐 Admin: '${rawText}'`);
    await saveAdminChatMessage("user", rawText);

    const response = await adminGroqChat(rawText, data);
    if (!response) {
      await ctx.reply("❌ AI አልተናገረም። ቆይተህ ሞክር።");
      return;
    }

    const { clean, newRules, deleteAll } = processAdminResponse(response);
    if (deleteAll) await deleteAllAdminRules();
    for (const rule of newRules) await saveAdminRule(rule);

    let finalReply = clean;
    if (newRules.length) finalReply += `\n\n📌 ${newRules.length} ህግ ተመዝግቧል።`;
    if (deleteAll)       finalReply += "\n🗑️ ሁሉም ህጎች ተሰርዘዋል።";

    await saveAdminChatMessage("assistant", finalReply);
    await ctx.reply(finalReply || "✅");
    return;
  }

  // GROUP MODE
  const data = await loadData();
  console.log(`📩 ${userName} (${userId}): '${rawText}'`);
  await saveUserChatMessage(userId, "user", rawText);

  const pending = await getPending(userId);

  const expired = await getExpiredPendings();
  for (const exp of expired) {
    if (exp.user_id !== userId) {
      await resolvePendingWithBestGuess(exp, bot);
    }
  }

  const actionData = await aiBrain(rawText, userId, userName, data);
  console.log("🧠 Action:", actionData);

  if (actionData.action === "ignore") return;

  if (actionData.action === "cancel_pending") {
    await deletePending(userId);
    await ctx.reply(actionData.reply || "እሺ ምንም አልያዝኩም 🙏");
    return;
  }

  if (actionData.action === "save_nickname" && actionData.nickname) {
    await saveUserNickname(userId, actionData.nickname);
    await ctx.reply(actionData.reply || "✅ ስምህ ተቀይሯል!");
    return;
  }

  if (actionData.action === "ask_clarify") {
    const context = {
      confirmed_bookings: actionData.confirmed_bookings || [],
      unclear_numbers: actionData.unclear_numbers || [],
      numbers: (actionData.unclear_numbers || []).join(","),
    };

    for (const num of (actionData.unclear_numbers || [])) {
      const otherPending = await getNumberPendingByOther(num, userId);
      if (otherPending) {
        await ctx.reply(`⚡ ቁጥር ${num} ሌላ ሰው እያጣራ ነው። አጣርቼ ይዝልሃለሁ 🙏`);
      }
    }

    await savePending(userId, userName, chatId, actionData.reply, context);
    await saveUserChatMessage(userId, "assistant", actionData.reply);
    await ctx.reply(actionData.reply);

    setTimeout(async () => {
      const stillPending = await getPending(userId);
      if (stillPending) await resolvePendingWithBestGuess(stillPending, bot);
    }, 90 * 1000);

    return;
  }

  if (actionData.action === "ask" || actionData.action === "reply") {
    const reply = actionData.reply || "❓";
    await saveUserChatMessage(userId, "assistant", reply);
    await ctx.reply(reply);
    if (pending) await deletePending(userId);
    return;
  }

  const bookedNumber = actionData.number ||
    (actionData.bookings && actionData.bookings[0]?.number);

  if (bookedNumber) {
    const otherPending = await getNumberPendingByOther(bookedNumber, userId);
    if (otherPending) {
      await ctx.reply(`⚡ ቁጥር ${bookedNumber} ሌላ ሰው እያጣራ ነው። ተቀድመሃል — አጣርቼ ይዝልሃለሁ 🙏`);
      const context = {
        confirmed_bookings: [{ number: bookedNumber, type: actionData.action === "book_half_p1" ? "half" : "full" }],
        unclear_numbers: [],
        numbers: String(bookedNumber),
      };
      await savePending(userId, userName, chatId, `ቁጥር ${bookedNumber} ልያዝ`, context);
      setTimeout(async () => {
        const stillPending = await getPending(userId);
        if (stillPending) await resolvePendingWithBestGuess(stillPending, bot);
      }, 90 * 1000);
      return;
    }
  }

  if (pending) await deletePending(userId);

  const result = executeAction(actionData, userId, data);

  if (result.changed) {
    await saveData(result.data);
    await updateLotteryMessage(result.data);

    const filled = Object.values(result.data.slots).filter(isSlotFullBooked).length;
    if (filled === 20) {
      await ctx.reply("🎉 ሁሉም ቁጥሮች ተሞልቷል! ዕጣ ቅርብ ነው! 🎰");
    }
  }

  const bookingName2 = (await getUserNickname(userId)) || userName;
  let finalReply = result.reply;
  if (result.changed) {
    const act = actionData.action;
    if (act === "book_half_p1") {
      finalReply = getHalfReply();
    } else if (act === "book_full" || act === "book_multiple") {
      finalReply = getFullReply(bookingName2);
    } else if (act === "change_type" || act === "change_type_multiple") {
      finalReply = actionData.new_type === "half" ? "እሺ በግማሽ ተቀይሯል 🙏" : getFullChangedReply();
    } else if (act === "book_half_p2") {
      finalReply = getP2JoinReply();
    } else if (act === "cancel_and_rebook") {
      finalReply = "እሺ ቀይረናል 🙏";
    }
  }

  await saveUserChatMessage(userId, "assistant", finalReply);
  await ctx.reply(finalReply || "✅ ተይዟል!");
});

bot.catch((err) => {
  console.error("🔴 ERROR:", err.error);
});

// ==================== KEEP ALIVE ====================

function runServer() {
  const port = parseInt(process.env.PORT || "10000");
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot is running!");
  }).listen(port, "0.0.0.0", () => {
    console.log(`✅ Keep-alive server on port ${port}`);
  });
}

// ==================== MAIN ====================

async function main() {
  if (!GROQ_API_KEY) {
    console.error("❌ GROQ_API_KEY አልተገኘም!");
    process.exit(1);
  }
  if (!geminiKeys.length) {
    console.warn("⚠️ ምንም Gemini key አልተገኘም! Groq ብቻ ይሰራል።");
  }

  await initDb();
  runServer();

  console.log("✅ Groq loaded");
  console.log(`✅ Gemini pool: ${geminiKeys.length} keys`);
  console.log("✅ Bot እየሰራ ነው...");

  await bot.api.deleteWebhook({ drop_pending_updates: true });
  bot.start({ drop_pending_updates: true });
}

main();
