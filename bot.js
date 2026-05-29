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
    console.log("✅ Rule saved:", rule);
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
    console.error("❌ getUserNickname error:", e);
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

// ==================== GROUP AI BRAIN (Gemini prompt — Groq API) ====================

async function aiBrain(userMessage, userId, userName, data) {
  const fullState   = buildShortState(data);
  const adminRules  = await buildAdminRulesText();
  const savedNick   = await getUserNickname(userId);
  const bookingName = savedNick || userName;

  const systemPrompt = `አንተ የሎተሪ booking bot ነህ። JSON ብቻ መልስ። ምንም explanation አትጨምር።

nickname: ${savedNick ? `"${savedNick}"` : "የለም"}
ሁኔታ: ${fullState}
${adminRules}

=== INTENT RULES (ምንም spelling፣ ቋንቋ፣ ወይም አጻጻፍ ቢጠቀም INTENT ተረዳ) ===

አስፈላጊ: ሰዎች perfect አይጽፉም። የተሳሳተ spelling፣ mixed language፣ አጭር ቃላት ሁሉ ተረዳ።

1. BOOKING intent — + ምልክት ያለው = ግማሽ፣ የሌለው = ሙሉ:
   - ⚠️ ቁጥር ላይ "+" ምልክት ካለ = ግማሽ (half)
   - ⚠️ ቁጥር ላይ "+" ምልክት ከሌለ = ሙሉ (full)
   - ምሳሌ: "91+" = 91 ግማሽ → book_half_p1
   - ምሳሌ: "96" = 96 ሙሉ → book_full
   - ምሳሌ: "91+ 96" = 91 ግማሽ + 96 ሙሉ → book_multiple mixed
   - ምሳሌ: "91+ 96+" = ሁለቱም ግማሽ → book_multiple half
   - ምሳሌ: "91 96" = ሁለቱም ሙሉ → book_multiple full

   አንድ ቁጥር ሙሉ: {"action":"book_full","number":X,"name":"${bookingName}","reply":"እሺ ሙሉ ተይዟል 🙏"}
   አንድ ቁጥር ግማሽ: {"action":"book_half_p1","number":X,"name":"${bookingName}","reply":"እሺ ግማሽ ተይዟል 🙏"}
   ብዙ ቁጥሮች: {"action":"book_multiple","bookings":[{"number":91,"type":"half"},{"number":96,"type":"full"}],"name":"${bookingName}","reply":"እሺ ተይዟል 🙏"}

   ሌሎች የግማሽ ቃላት (ሁሉም ቁጥሮች ግማሽ ማለት): half, gmash, gemash, ግማሽ, 1/2, haf, gmas, በግማሽ, ሃፍ

3. ቀይር/ተካ intent (cancel_and_rebook):
   - ትርጉም: አንድ ቁጥር ሰርዞ ሌላ ቁጥር መያዝ
   - ምልክቶች/ቃላት: ወደ, በ, change, from, to, replace, ቀይር, ቀይረው, ቀይርልኝ, swap, ትካው, ምትካ, argew, arg, mels, መልስ, cancel and add, sriz and yaz, ሰርዝና ያዝ, kutr X mels Y, X ትካ Y
   - format: {"action":"cancel_and_rebook","cancel_number":X,"book_number":Y,"book_type":"full","name":"${bookingName}","reply":"እሺ ቀይረናል 🙏"}

4. ስም ጠቅሶ ያዝ intent:
   - ትርጉም: የሌላ ሰው ስም ጠቅሶ booking ማድረግ
   - ቃላት: ያዝ, set, bel, ble, በል, hold, ብለህ, ብላ, ስም, name, yaz, blo, bleh
   - format: {"action":"book_full","number":X,"name":"[ያ ስም]","reply":"እሺ [ስም] ብለህ ተይዟል 🙏"}

5. ሰርዝ intent:
   - ትርጉም: የያዘውን ቁጥር መሰረዝ
   - ቃላት: ሰርዝ, cancel, remove, አልፈልግም, አውጣ, delete, sriz, sarez, argew, arg, alfelgm, አልፈልገውም, አታስቀምጥ
   - format: {"action":"cancel","number":X,"reply":"እሺ ተሰርዟል 🙏"}

6. ነፃ slot ጥያቄ intent:
   - ትርጉም: ምን ቁጥሮች ነፃ እንደሆኑ መጠየቅ
   - ቃላት: አለ?, ነፃ, free, yale, ale, ቁጥር አለ, available, menfes, ክፍት
   - format: {"action":"reply","reply":"✅ ነፃ slots: [ዝርዝር]"}

7. NICKNAME intent:
   - ትርጉም: ስም መቀየር ወይም መስጠት
   - ቃላት: ለኔ...በል, ስሜ, my name, call me, nickname, sme, semé
   - format: {"action":"save_nickname","nickname":"[ስም]","reply":"እሺ ተቀይሯል 🙏"}

8. CHANGE TYPE intent — ትልቅ ትኩረት ያስፈልጋል:
   - ትርጉም: ቀድሞ የያዘ ቁጥር ከግማሽ → ሙሉ ወይም ሙሉ → ግማሽ መቀየር
   - ቃላት: mulu, ሙሉ, full, mulu yarg, full adrg, ሙሉ አድርግ, ሙሉ አርግ, gmash, ግማሽ, half, gmash adrg, ግማሽ አድርግ, half yarg
   - ⚠️ BOOKING አይደለም — TYPE CHANGE ነው!
   - ምሳሌ: "91+ mulu አርግ" = 91 ያዘ ነበር (ግማሽ) → ሙሉ ቀይር → change_type
   - ምሳሌ: "91 mulu" = 91 ያዘ ነበር → ሙሉ ቀይር → change_type

   CASE A — አንድ ቁጥር ብቻ (ቀጥታ ቀይር):
   {"action":"change_type","number":X,"new_type":"full","reply":"እሺ ሙሉ ሆነ 🙏"}

   CASE B — ብዙ ቁጥሮች specific (ሁለቱንም ቀይር):
   - "31 21 mulu አርግ" → ሁለቱንም change_type
   {"action":"change_type_multiple","numbers":[31,21],"new_type":"full","reply":"እሺ ሁለቱም ሙሉ ሆኑ 🙏"}

   CASE C — "አርጋቸው" / "ሁሉንም" / "ሁሉም" (user ያዛቸውን ሁሉ ቀይር):
   - "ሙሉ አርጋቸው", "ሁሉንም full አድርግ", "ሁሉም mulu yarg"
   - user ያዛቸውን slots ሁሉ ከ state ውስጥ ፈልግ → ሁሉንም ቀይር
   {"action":"change_type_multiple","numbers":[X,Y,Z],"new_type":"full","reply":"እሺ ሁሉም ሙሉ ሆኑ 🙏"}

   CASE D — አሻሚ (ቁጥር አልጠቀሰም፣ ብዙ slots አለው):
   - user ብዙ slots ካለው እና ቁጥር ሳይጠቅስ "mulu አርግ" ካለ → ጠይቅ
   {"action":"ask","reply":"የቱን ቁጥር ሙሉ ላድርግ? ያዝካቸው ቁጥሮች: [ዝርዝር]"}

=== IMPORTANT RULES ===
- የተያዘ slot → {"action":"reply","reply":"ተቀድመሃል ቤተሰብ 🙏"}
- እራሱ ያዘ → {"action":"reply","reply":"ይዥሃለሁ ቤተሰብ 🙏"}
- ክፍያ screenshot → {"action":"reply","reply":"ተቀብዬአለሁ ✅ Admin ያረጋግጣል"}
- leading zero: "01"=1, "06"=6, "09"=9
- nickname ካለ ሁሌ nickname ተጠቀም
- reply field ሁሌ ሙሉ አማርኛ መልስ ይኑረው — ባዶ አይሁን
- "mulu/full + ቁጥር" = CHANGE TYPE እንጂ NEW BOOKING አይደለም!

JSON ብቻ ምለስ:`;

  const userPrompt = `ተጠቃሚ: ${userName} (ID:${userId})
መልእክት: "${userMessage}"`;

  const raw = await groqCall(systemPrompt, userPrompt, 250, 0.7);
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

  const actionData = await aiBrain(rawText, userId, userName, data);
  console.log("🧠 Action:", actionData);

  if (actionData.action === "save_nickname" && actionData.nickname) {
    await saveUserNickname(userId, actionData.nickname);
    await ctx.reply(actionData.reply || "✅ ስምህ ተቀይሯል!");
    return;
  }

  if (actionData.action === "ask" || actionData.action === "reply") {
    const reply = actionData.reply || "❓";
    await saveUserChatMessage(userId, "assistant", reply);
    await ctx.reply(reply);
    return;
  }

  const result = executeAction(actionData, userId, data);

  if (result.changed) {
    await saveData(result.data);
    await updateLotteryMessage(result.data);
    const filled = Object.values(result.data.slots).filter(isSlotFullBooked).length;
    if (filled === 20) {
      await ctx.reply("🎉 ሁሉም slots ተሞልቷል! ዕጣ ቅርብ ነው! 🎰");
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
