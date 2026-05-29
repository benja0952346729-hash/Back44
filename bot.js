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
    // NEW: pending bookings table
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
    // expires in 1.5 minutes
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

// Check if a slot/number is pending by another user
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

// Get all slots owned by a user
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

  const systemPrompt = `አንተ የሎተሪ booking AI ነህ። JSON ብቻ መልስ። ምንም explanation አትጨምር።

nickname: ${savedNick ? `"${savedNick}"` : "የለም"}
የዚህ user slots: ${userSlotsText}
ሁኔታ: ${fullState}
${adminRules}

የቅርብ ጊዜ ታሪክ (context):
${historyText}

════════════════════════════════════
 CORE BOOKING RULES
════════════════════════════════════

★ ቁጥር + "+" ምልክት = ግማሽ (half)
★ ቁጥር ብቻ = ሙሉ (full)

── CASE 1: ነፃ slot ──
"21+" → book_half_p1 (ግማሽ ያዝ)
"21"  → book_full (ሙሉ ያዝ)

── CASE 2: የራሱ slot ዳግም ጠራ (SELF RE-BOOK) ──
⚠️ user ቀደም ሲል ያዘው slot ቁጥር ዳግም ጠራ:
- "21+" ያዘ ነበር → "21" ወይም "21+" ዳግም ጻፈ
- ምን ማለቱ ነው: "ሙሉ አርግልኝ"
- → change_type full
- reply: "ሙሉ ሆኗል 🙏"

── CASE 3: ሌላ user ግማሽ slot ጠራ (P2 JOIN) ──
- slot ግማሽ ነው (p1 አለ)
- ሌላ user ያ ቁጥር ጠራ ("21" ወይም "21+")
- → book_half_p2
- reply: "ሙሉ ሆኗል! [p1_name]+[this_user_name] 🙏"

── CASE 4: አሻሚ input ──
User ብዙ ቁጥሮች ጻፈ እና አንዳንዱ ግልጽ አይደለም:
ምሳሌ: "21+ 31 36 በጅ ሙሉ" — 31 ሙሉ? ወይስ 36 ብቻ?
→ action: "ask_clarify"
→ ጥያቄ ጠይቅ: "36 ብቻ ሙሉ ልያዝ? ወይስ 31ም ሙሉ?"
→ context ውስጥ ግልጽ የሆኑትን አስቀምጥ
format: {"action":"ask_clarify","reply":"[ጥያቄ]","confirmed_bookings":[{"number":21,"type":"half"}],"unclear_numbers":[31,36]}

── CASE 5: ከ ask_clarify በኋላ user መለሰ (CONTINUATION) ──
ታሪክ ውስጥ "ask_clarify" ካለ እና user መለሰ:
- "ሁለቱም ሙሉ" / "ሁለቱንም" → confirmed_bookings ሁሉ + unclear ሁሉ ሙሉ ያዝ
- "36 ብቻ" / "36 ብቻ ሙሉ" → 36 ብቻ ያዝ
- "ተው" / "cancel" / "አትያዝ" → ምንም አትያዝ
→ action: "book_multiple" ወይም "reply"

── CASE 6: "ተው" ሲል (CANCEL PENDING) ──
User "ተው"/"cancel"/"አትያዝ" ካለ → pending cancel
format: {"action":"cancel_pending","reply":"እሺ ምንም አልያዝኩም 🙏"}

════════════════════════════════════
 OTHER INTENTS
════════════════════════════════════

3. ቀይር/ተካ (cancel_and_rebook):
{"action":"cancel_and_rebook","cancel_number":X,"book_number":Y,"book_type":"full","name":"${bookingName}","reply":"እሺ ቀይረናል 🙏"}

4. ስም ጠቅሶ ያዝ:
{"action":"book_full","number":X,"name":"[ያ ስም]","reply":"እሺ [ስም] ብለህ ተይዟል 🙏"}

5. ሰርዝ:
{"action":"cancel","number":X,"reply":"እሺ ተሰርዟል 🙏"}

6. ነፃ slot ጥያቄ:
{"action":"reply","reply":"✅ ነፃ slots: [ዝርዝር]"}

7. NICKNAME:
{"action":"save_nickname","nickname":"[ስም]","reply":"እሺ ተቀይሯል 🙏"}

8. CHANGE TYPE:
አንድ: {"action":"change_type","number":X,"new_type":"full","reply":"ሙሉ ሆኗል 🙏"}
ብዙ: {"action":"change_type_multiple","numbers":[X,Y],"new_type":"full","reply":"ሁሉም ሙሉ ሆኑ 🙏"}
አሻሚ: {"action":"ask","reply":"የቱን ቁጥር ሙሉ ላድርግ?"}

════════════════════════════════════
 IMPORTANT RULES
════════════════════════════════════
- የተያዘ slot (ሌላ ሰው) → {"action":"reply","reply":"ተቀድመሃል ቤተሰብ 🙏"}
- እራሱ ያዘ → self re-book logic ተጠቀም
- ክፍያ screenshot → {"action":"reply","reply":"ተቀብዬአለሁ ✅ Admin ያረጋግጣል"}
- leading zero: "01"=1
- nickname ካለ ሁሌ nickname ተጠቀም
- reply field ሁሌ ሙሉ አማርኛ መልስ — ባዶ አይሁን
- ታሪክ አንብብ! context ተረዳ! ቀዳሚ ጥያቄ ካለ continuation ተከተል

JSON ብቻ ምለስ:`;

  const userPrompt = `ተጠቃሚ: ${userName} (ID:${userId})
መልእክት: "${userMessage}"`;

  const raw = await groqCall(systemPrompt, userPrompt, 350, 0.5);
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

    // Best guess: book confirmed_bookings + pick first unclear as full
    const bookings = [];

    if (context.confirmed_bookings && context.confirmed_bookings.length) {
      for (const b of context.confirmed_bookings) {
        bookings.push(b);
      }
    }

    if (context.unclear_numbers && context.unclear_numbers.length) {
      // Best guess: take all unclear as full
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

      // Check if any half slots available to offer
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

  // ── Check if user has pending and this might be a reply ──
  const pending = await getPending(userId);

  // ── Check timeout for ALL expired pendings ──
  const expired = await getExpiredPendings();
  for (const exp of expired) {
    if (exp.user_id !== userId) {
      await resolvePendingWithBestGuess(exp, bot);
    }
  }

  const actionData = await aiBrain(rawText, userId, userName, data);
  console.log("🧠 Action:", actionData);

  // ── Handle cancel_pending ──
  if (actionData.action === "cancel_pending") {
    await deletePending(userId);
    await ctx.reply(actionData.reply || "እሺ ምንም አልያዝኩም 🙏");
    return;
  }

  // ── Handle save_nickname ──
  if (actionData.action === "save_nickname" && actionData.nickname) {
    await saveUserNickname(userId, actionData.nickname);
    await ctx.reply(actionData.reply || "✅ ስምህ ተቀይሯል!");
    return;
  }

  // ── Handle ask_clarify (ambiguous) ──
  if (actionData.action === "ask_clarify") {
    // Save pending context
    const context = {
      confirmed_bookings: actionData.confirmed_bookings || [],
      unclear_numbers: actionData.unclear_numbers || [],
      numbers: (actionData.unclear_numbers || []).join(","),
    };

    // Check if any unclear number is pending by someone else
    let sniped = false;
    for (const num of (actionData.unclear_numbers || [])) {
      const otherPending = await getNumberPendingByOther(num, userId);
      if (otherPending) {
        await ctx.reply(`⚡ ቁጥር ${num} ሌላ ሰው እያጣራ ነው። አጣርቼ ይዝልሃለሁ 🙏`);
        sniped = true;
      }
    }

    await savePending(userId, userName, chatId, actionData.reply, context);
    await saveUserChatMessage(userId, "assistant", actionData.reply);
    await ctx.reply(actionData.reply);

    // Schedule timeout resolver
    setTimeout(async () => {
      const stillPending = await getPending(userId);
      if (stillPending) {
        await resolvePendingWithBestGuess(stillPending, bot);
      }
    }, 90 * 1000); // 1:30 min

    return;
  }

  // ── Handle ask ──
  if (actionData.action === "ask" || actionData.action === "reply") {
    const reply = actionData.reply || "❓";
    await saveUserChatMessage(userId, "assistant", reply);
    await ctx.reply(reply);

    // If had pending, resolve it
    if (pending) await deletePending(userId);
    return;
  }

  // ── Execute booking action ──
  // First check if a number being booked is pending by current user (priority claim)
  const bookedNumber = actionData.number ||
    (actionData.bookings && actionData.bookings[0]?.number);

  if (bookedNumber) {
    const otherPending = await getNumberPendingByOther(bookedNumber, userId);
    if (otherPending) {
      // Snipe protection: notify the other user's pending will be resolved
      await ctx.reply(`⚡ ቁጥር ${bookedNumber} ሌላ ሰው እያጣራ ነው። ተቀድመሃል — አጣርቼ ይዝልሃለሁ 🙏`);
      // Save as pending for this user too
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

  // Clear pending if user gave a direct answer
  if (pending) await deletePending(userId);

  const result = executeAction(actionData, userId, data);

  if (result.changed) {
    await saveData(result.data);
    await updateLotteryMessage(result.data);

    const filled = Object.values(result.data.slots).filter(isSlotFullBooked).length;
    if (filled === 20) {
      await ctx.reply("🎉 ሁሉም slots ተሞልቷል! ዕጣ ቅርብ ነው! 🎰");
    }

    // After booking: check if any of user's new slots are half and offer p2
    const userSlots = getUserSlots(userId, result.data);
    for (const { slot } of userSlots) {
      if (slot.type === "half" && !slot.p2_id) {
        const firstNum = slot.numbers[0];
        // Only notify if this was a new booking
        const wasJustBooked = result.data.slots[
          Object.keys(result.data.slots).find(k =>
            result.data.slots[k].numbers[0] === firstNum
          )
        ];
        if (wasJustBooked) {
          // Small delay then notify
          setTimeout(async () => {
            await bot.api.sendMessage(chatId,
              `ቤተሰብ ${firstNum} ግማሽ ነው — ሌላ ሰው ቢቀላቀል ቦታ አለ 🙏`
            );
          }, 1500);
          break;
        }
      }
    }
  }

  await saveUserChatMessage(userId, "assistant", result.reply);
  await ctx.reply(result.reply || "✅ ተይዟል!");
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
