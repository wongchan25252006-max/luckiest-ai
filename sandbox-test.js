require('dotenv').config();
const { db } = require('./database');
const { generateReply } = require('./services/ai');
const { findOrCreateConversation } = require('./services/messaging');

const USER_ID = 2;

const testCases = [
  { lang: 'English',    customerName: 'Sarah',    body: 'Hi! How much for a custom Ankara dress and how long does it take to make?' },
  { lang: 'Pidgin',     customerName: 'Chinedu',  body: 'How far babe, I wan order one two-piece set. You dey ship to Abuja?' },
  { lang: 'Pidgin',     customerName: 'Tolu',     body: 'Abeg how much be your bridal own? My sister dey wed for December.' },
  { lang: 'French',     customerName: 'Aisha',    body: "Bonjour! Est-ce que vous livrez en France? Combien coûte une robe Ankara?" },
  { lang: 'Yoruba/EN',  customerName: 'Bukola',   body: 'E kaaro o, do you sell mens agbada too?' },
  { lang: 'Escalation', customerName: 'Angry guy', body: 'I paid 20k three weeks ago and you have not delivered. This is a scam, I will report you to EFCC!' },
  { lang: 'Unknown Q',  customerName: 'Jenny',    body: 'Do you offer monthly installment payment plans through Klarna?' },
  { lang: 'Casual',     customerName: 'Ada',      body: 'omo that dress on your IG yesterday — fire 🔥 you still get am?' }
];

(async () => {
  console.log('\n=== LuckiestAI sandbox test — test user (Amaka, LuckiestThreads) ===\n');

  for (const tc of testCases) {
    const externalId = 'sandbox-' + tc.customerName.replace(/\s+/g, '-').toLowerCase();
    const conv = findOrCreateConversation({
      userId: USER_ID,
      platform: 'telegram',
      externalId,
      customerName: tc.customerName,
      customerHandle: null
    });

    db.prepare(
      `INSERT INTO messages (conversation_id, direction, sender, body, ai_generated, created_at)
       VALUES (?, 'inbound', ?, ?, 0, ?)`
    ).run(conv.id, tc.customerName, tc.body, Date.now());

    console.log(`─── [${tc.lang}] ${tc.customerName}`);
    console.log(`    customer: ${tc.body}`);

    const result = await generateReply({
      userId: USER_ID,
      conversationId: conv.id,
      incomingMessage: tc.body,
      customerName: tc.customerName
    });

    console.log(`    Amaka:    ${result.reply || '(empty)'}`);
    console.log(`    needs_human: ${result.needs_human}${result.reason ? '  (reason: ' + result.reason + ')' : ''}`);
    console.log();

    if (result.reply) {
      db.prepare(
        `INSERT INTO messages (conversation_id, direction, sender, body, ai_generated, created_at)
         VALUES (?, 'outbound', 'ai', ?, 1, ?)`
      ).run(conv.id, result.reply, Date.now());
    }
    if (result.needs_human) {
      db.prepare(`UPDATE conversations SET needs_human = 1, status = 'needs_help' WHERE id = ?`).run(conv.id);
    }
    db.prepare(`UPDATE conversations SET last_message_at = ? WHERE id = ?`).run(Date.now(), conv.id);
  }

  console.log('=== Done. Open /messages.html (as test user) or /admin.html to see the threads. ===\n');
  process.exit(0);
})();
