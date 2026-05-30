const { Bot } = require("grammy");
const { Pool } = require("pg");
const Groq = require("groq-sdk");
const http = require("http");

// ==================== CONFIG ====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_ID  = parseInt(process.env.ADMIN_TELEGRAM_ID || "0");
const DATABASE_URL       = process.env.DATABASE_URL;
const GROQ_API_KEY       = process.env.GROQ_API_KEY;

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

// ==================== GROUP AI BRAIN ====================

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

  const systemPrompt = `አንተ ብልህ የሎተሪ AI ነህ። JSON ወይም FREE TEXT መልስ መስጠት ትችላለህ።

★★★ CRITICAL RULE — AI BRAIN FIRST ★★★
አንተ ሰው ነህ — ታስባለህ። JSON template ብቻ አይደለህ።
መልእክቱን አንብብ → INTENT ተረዳ → ትክክለኛ action ምረጥ → respond.
50% brain thinking + 50% JSON structure = perfect response.
JSON template ካልሸፈነው → አስብ፣ ትክክለኛ action ምረጥ። ታሪክ ተጠቀም።

nickname: ${savedNick ? `"${savedNick}"` : "የለም"}
የዚህ user slots: ${userSlotsText}
ሁኔታ: ${fullState}
${adminRules}

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
"01 አንድ አስቴር በል"       → number=1,  name=አስቴር,   type=full  ★(አንድ=ordinal/filler, አስቴር=ስም)
"01 አንድ አስቴር"          → number=1,  name=አስቴር,   type=full  ★
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
"21+ dawit"              → number=21, name=dawit,   type=half ★(+ = half)
"21+ ዳዊት"               → number=21, name=ዳዊት,    type=half
"31 bgmash chaltu bl"    → number=31, name=chaltu,  type=half
"31 bgmash ቻልቱ በል"      → number=31, name=ቻልቱ,    type=half
"51 bgmash liya yazlgn"  → number=51, name=liya,    type=half
"76 ሙሉ በላይ"             → number=76, name=በላይ,    type=full
"76 mulu belay"          → number=76, name=belay,   type=full
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
"01 አንድ አስቴር" → 01=slot, አንድ=filler(ignore), አስቴር=ስም → name=አስቴር
"01 አንድ" → 01=slot, አንድ=filler OR ስም? → ስም keyword ካለ(bl,yaz,bel) = name=አንድ; ካልሆነ = filler
"21 ሁለት ሳራ bl" → 21=slot, ሁለት=filler, ሳራ=ስም
"21 ሁለት bl" → 21=slot, ሁለት=ስም (keyword አለ)

════════════════════════════════════
 LANGUAGE UNDERSTANDING
════════════════════════════════════

HALF keywords: +, g, ግ, ግማ, ግማሽ, half, gmash, haf, gmas, gem, gm, 1/2, gmsh, grash, bgmash, bgmash, bgramash, bgmsh
FULL keywords: ምልክት የለም፣ mulu, full, ሙሉ, fll, mul, fll, mlu, fuul, fful, mulu, mluu

CANCEL keywords: ሰርዝ, cancel, sriz, remove, arg, argew, del, delete, alfelgm, srez, sriz, kansel, cncel, rmove, delet, srz, alfelgm, lflegm

CHANGE keywords: ቀይር, change, swap, replace, to, ወደ, mkeyir, chng, chage, swp, replce, keyir, kyr, wede, chanje

NAME BOOKING keywords: በል, ብለህ, ብላ, bleh, blo, bl, yaz, hold, set, say, ስም, name, ነው, ብሎ, yazlign, yazlih, yazlgn, bhlo, yazlh, bel

★★★ AMHARIC ACTION WORDS — ስም አይደሉም! ★★★
እነዚህ ቃሎች booking COMMANDS ናቸው — ስም አይደሉም:
ቢል = ቢያዝ = ያዝ = book/hold (NOT a name!)
ቢላ = ቢያዘው = ያዝ
ያዝልን = ያዝ
ያዝልኝ = ያዝ
ይያዝልኝ = ያዝ
ቁጥሩን ያዝ = ያዝ

"65/21/41 ቢል"    → numbers=65,21,41  type=full  name=${bookingName} (ቢል=command!)
"21 ቢል"          → number=21  type=full  name=${bookingName}
"21 ቢያዝ"         → number=21  type=full  name=${bookingName}
"21+ ቢል"         → number=21  type=half  name=${bookingName}
"21 ቢላ"          → number=21  type=full  name=${bookingName}
"65/21/41 ቢያዘው"  → numbers=65,21,41  type=full  name=${bookingName}

ACCOUNT/PAYMENT: አካውንት, account, akawnt, akawont, pay, ክፍያ, bank, cbe, telebr, telebirr

════════════════════════════════════
 ★★★ RANGE UNDERSTANDING — CRITICAL ★★★
════════════════════════════════════

ቁጥር RANGE ሲጽፉ = FIRST number ብቻ ይወሰዳል:

ቡድኖች: 1-5, 6-10, 11-15, 16-20, 21-25, 26-30, 31-35, 36-40, 41-45, 46-50,
        51-55, 56-60, 61-65, 66-70, 71-75, 76-80, 81-85, 86-90, 91-95, 96-100

★★★ RANGE + TYPE DETECTION ★★★
"h X isk Y" pattern → h = hn = from = starting = አይደለም HALF! = range keyword
"isk" "isk55" "until" "to" "end" "al end" "wede" "esk" "eslk" "hsk" = range connectors = FULL slot
"hn" "h" before number = "hn 51" = could be range start, NOT half indicator!

RANGE examples — ሙሉ ናቸው (range connector አለ):
"h 51 isk 55"         → number=51, type=full   ★★★ h=from, isk=to
"h 51 isk 55 yazlet"  → number=51, type=full   ★★★ yazlet=yazlign=ለኔ ያዝ
"h 51 isk 55 yazlgn"  → number=51, type=full
"51 isk 55"           → number=51, type=full
"51 isk 55 yazlet"    → number=51, type=full
"51 to 55"            → number=51, type=full
"51 end 55"           → number=51, type=full
"51 al end"           → number=51, type=full
"51 wede 55"          → number=51, type=full
"hn 51 wede 55 yaz"   → number=51, type=full
"51isk55"             → number=51, type=full
"51-55 full"          → number=51, type=full
"51 eslk 55 yazlgn"   → number=51, type=full
"h 1 isk 5"           → number=1,  type=full
"h 21 isk 25"         → number=21, type=full
"h 96 isk 100"        → number=96, type=full
"h 11 isk 15 yaz"     → number=11, type=full
"h 36 isk 40 yazlih"  → number=36, type=full
"from 51 to 55"       → number=51, type=full

RANGE examples — ግማሽ ናቸው (+ ምልክት አለ OR gmash keyword):
"h 51 isk 55 gmash"   → number=51, type=half  ★ gmash overrides
"51 isk 55 half"      → number=51, type=half
"h 51 isk 55+"        → number=51, type=half
"51 isk 55 bgmash"    → number=51, type=half

"01-05"  → number=1    "1-5"    → number=1
"06-10"  → number=6    "6-10"   → number=6
"11-15"  → number=11
"16-20"  → number=16
"21-25"  → number=21   "21 25"  → number=21
"26-30"  → number=26
"31-35"  → number=31   "31,35"  → number=31
"36-40"  → number=36
"41-45"  → number=41
"46-50"  → number=46
"51-55"  → number=51   "5155"   → number=51
"56-60"  → number=56
"61-65"  → number=61
"66-70"  → number=66
"71-75"  → number=71
"76-80"  → number=76
"81-85"  → number=81
"86-90"  → number=86
"91-95"  → number=91
"96-100" → number=96   "96 100" → number=96

════════════════════════════════════
 BOOKING RULES
════════════════════════════════════

── CASE 1: ነፃ slot ──
ግማሽ → book_half_p1
ሙሉ  → book_full

★ ብዙ ቁጥር (MULTIPLE BOOKING):
"21 31 41"    → book_multiple ሁሉም full
"21+ 31+ 41+" → book_multiple ሁሉም half
"21 31+ 41"   → mixed → ask_clarify
"21 31"       → book_multiple ሁለቱም full
"21+ 31+"     → book_multiple ሁለቱም half

★★★ SLASH "/" SEPARATOR — ሁለት ቁጥር በ slash ★★★
slash "/" = ሁለት የተለያዩ ቁጥሮች ናቸው — book_multiple!
"56/66yazachew"    → numbers=56,66  name=yazachew  type=full  → book_multiple
"56/66 yazachew"   → numbers=56,66  name=yazachew  type=full  → book_multiple
"56/66"            → numbers=56,66  type=full  → book_multiple
"56/66+"           → numbers=56,66  type=half  → book_multiple
"21/31 dawit"      → numbers=21,31  name=dawit  type=full  → book_multiple
"21/31+ dawit"     → numbers=21,31  name=dawit  type=half  → book_multiple
"21/31 dawit bl"   → numbers=21,31  name=dawit  type=full  → book_multiple
"11/21/31 abel"    → numbers=11,21,31  name=abel  type=full  → book_multiple
"56/66 gmash sara" → numbers=56,66  name=sara  type=half  → book_multiple
"56/66 half"       → numbers=56,66  type=half  → book_multiple
"01/11/21 yaz"     → numbers=1,11,21  type=full  → book_multiple
"46/56 tigist bl"  → numbers=46,56  name=tigist  type=full  → book_multiple
"46/56+ tigist"    → numbers=46,56  name=tigist  type=half  → book_multiple
"76/86yazachew"    → numbers=76,86  name=yazachew  type=full  → book_multiple
"56/66yazachew" JSON → {"action":"book_multiple","bookings":[{"number":56,"type":"full"},{"number":66,"type":"full"}],"name":"yazachew","reply":"እሺ yazachew ሁሉም ተይዟል 🙏"}

★ ስም + ብዙ ቁጥር (space separator):
"21 31 dawit bl"   → book_multiple ሁለቱም dawit full
"21+ 31+ sara"     → book_multiple ሁለቱም sara half
"11 21 31 abel yaz"→ book_multiple ሦስቱም abel full
"16+ 26+ tigist bl"→ book_multiple ሁለቱም tigist half

── CASE 2: የራሱ ቁጥር ዳግም ──
ሙሉ ያዘ + ዳግም ሙሉ → "ቀድሞ ይዘሃል ቤተሰብ 🙏"
ሙሉ ያዘ + "+" → change_type half → "እሺ በግማሽ ተቀይሯል 🙏"
ግማሽ ያዘ + ምልክት የለም → change_type full → "ሙሉ ሆኗል 🙏"

── CASE 3: ሌላ user ግማሽ slot ──
→ book_half_p2

── CASE 4: MIXED AMBIGUOUS ──
→ ask_clarify

── CASE 5: CONTINUATION ──
ታሪክ ውስጥ ask_clarify ካለ + user መለሰ → ቀጥል

════════════════════════════════════
 OTHER INTENTS
════════════════════════════════════

አካውንት/payment:
{"action":"reply","reply":"💳 የክፍያ አካውንቶች:\n\nCBE 1000641057146 biniyam dawit\nቴሌ ብር 0952346729"}

ቀይር/ተካ:
{"action":"cancel_and_rebook","cancel_number":X,"book_number":Y,"book_type":"full","name":"${bookingName}","reply":"እሺ ቀይረናል 🙏"}

ሰርዝ:
{"action":"cancel","number":X,"reply":"እሺ ተሰርዟል 🙏"}

SLOT STATUS:
"21 አለ?" → free: {"action":"reply","reply":"✅ 21 ነፃ ነው!"}
          → taken: {"action":"reply","reply":"❌ 21 ተይዟል"}

ክፍያ CONFIRM:
"ከፈልኩ" "paid" "screenshot" →
{"action":"reply","reply":"ተቀብዬአለሁ ✅ Admin ያረጋግጣል"}

የራሱን SLOT ጥያቄ:
"ያዝኩ?" "mine?" "my number?" →
{"action":"reply","reply":"የያዝካቸው ቁጥሮች: [ዝርዝር] 🙏"}

NICKNAME:
{"action":"save_nickname","nickname":"[ስም]","reply":"እሺ ተቀይሯል 🙏"}

CHANGE TYPE:
አንድ: {"action":"change_type","number":X,"new_type":"full","reply":"ሙሉ ሆኗል 🙏"}
ብዙ:  {"action":"change_type_multiple","numbers":[X,Y],"new_type":"full","reply":"ሁሉም ሙሉ ሆኑ 🙏"}

════════════════════════════════════
 IMPORTANT RULES
════════════════════════════════════
- የተያዘ ቁጥር (ሌላ ሰው) → {"action":"reply","reply":"ተቀድመሃል ቤተሰብ 🙏"}
- እራሱ ያዘ → self re-book logic
- ቅሬታ/ስድብ → {"action":"reply","reply":"እኔ የቢንያም online አጋዝ robot ነኝ ለማንኛውም ጥያቄ በ 0952346729 ይደውሉ 😍"}
- screenshot → {"action":"reply","reply":"ተቀብዬአለሁ ✅ Admin ያረጋግጣል"}
- ሎተሪ ካልሆነ → {"action":"ignore"}
- leading zero: "01"=1
- nickname ካለ ሁሌ nickname ተጠቀም
- reply field ሁሌ ሙሉ አማርኛ

★★★ NAME extraction FINAL CHECK ★★★
JSON ከመስጠትህ በፊት ጠይቅ:
1. ቁጥሩ ምንድን ነው? (leading zero አስወግድ)
2. type ምንድን ነው? (+/gmash/half = half, ሌላ = full)
3. ስም አለ? (keyword bl/bel/yaz/blo/ነው/ብለህ/ብላ/set/hold/say ካለ → ቀጥሎ ያለ ቃል ስም)
4. range connector (isk/to/end/wede) ካለ → FULL type
5. "h X isk Y" → h=from(ignore), X=number, type=FULL

JSON ብቻ ምለስ (ምንም explanation አትጨምር):`;

  const userPrompt = `ተጠቃሚ: ${userName} (ID:${userId})
መልእክት: "${userMessage}"`;

  const raw = await groqCall(systemPrompt, userPrompt, 400, 0.7);
  console.log("🧠 AI raw:", raw);

  try {
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    const match = clean.match(/\{.*\}/s);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.error("❌ AI parse error:", e);
  }
  return { action: "reply", reply: "❌ ጊዜያዊ ችግር አለ። ቆይተህ ሞክር።" };
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
      for (const b of context.confirmed_bookings) {
        bookings.push(b);
      }
    }

    if (context.unclear_numbers && context.unclear_numbers.length) {
      for (const num of context.unclear_numbers) {
        bookings.push({ number: num, type: "full" });
      }
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
      await bot.api.sendMessage(chatId,
        `⏰ ${bookingName}፣ ምላሽ ስላልሰጠህ/ሽ በግምት ይዤልሃለሁ (${nums}) 🙏`
      );

      const userSlots = getUserSlots(userId, data);
      for (const { slot } of userSlots) {
        if (slot.type === "half" && !slot.p2_id) {
          const nums2 = slot.numbers[0];
          await bot.api.sendMessage(chatId,
            `ቤተሰብ ${nums2} በግማሽ ነው፣ ሌላ ሰው ቢፈልግ ልቀላቀል ይችላል 🙏`
          );
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
      if (!num) continue;
      const [slotId, slot] = getSlotByNumber(num, data);
      if (slotId && !slot.type) {
        Object.assign(data.slots[slotId], {
          type: btype === "half" ? "half" : "full",
          p1_id: userId, p1_name: name, p1_paid: false,
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

  if (actionData.action === "ignore") {
    return;
  }

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
      if (stillPending) {
        await resolvePendingWithBestGuess(stillPending, bot);
      }
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
        if (stillPending) {
          await resolvePendingWithBestGuess(stillPending, bot);
        }
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

  await initDb();
  runServer();

  console.log("✅ Groq loaded");
  console.log("✅ Bot እየሰራ ነው...");

  await bot.api.deleteWebhook({ drop_pending_updates: true });
  bot.start({ drop_pending_updates: true });
}

main();
