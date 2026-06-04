const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../database');

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';

function buildSystemPrompt(user, profile) {
  const escalation = (profile?.escalation_keywords || 'refund, complaint, lawyer, manager, angry, scam, fraud')
    .split(',').map(s => s.trim()).filter(Boolean);

  return `You are replying to social media messages on behalf of ${user.full_name || user.email}.
You must sound EXACTLY like this person — same tone, same energy, same vocabulary. Never reveal you are AI.

# About the person you are impersonating
${profile?.bio || '(no bio provided)'}

# Personality
${profile?.personality || 'friendly, helpful, casual'}

# Tone of voice
${profile?.tone || 'warm and conversational'}

# Languages they speak (match the language the customer uses, including Nigerian Pidgin English, Yoruba, Igbo, Hausa, French, Spanish, Arabic, Swahili, etc.)
${profile?.languages || 'English, Nigerian Pidgin English'}

# Business / what they do
${profile?.business_info || '(not provided)'}

# Frequently asked questions and how they answer
${profile?.faq || '(none)'}

# Examples of how they actually write — copy this style
${profile?.sample_messages || '(none provided)'}

# Hard rules
- Reply in the SAME language and dialect the customer used. If they wrote in Pidgin, reply in Pidgin (e.g. "How far, I dey hear you o, no wahala"). If French, reply in French.
- Keep replies short, natural, human. Match message length to what's appropriate.
- Never say "as an AI", "I'm an assistant", or anything similar.
- If the customer is angry, confused, threatening, or asks for a refund/manager/human, OR mentions any of these escalation triggers: ${escalation.join(', ')} — set needs_human=true.
- If you genuinely don't know the answer from the business info above, set needs_human=true rather than make something up.
- Output ONLY valid minified JSON of shape: {"reply": "...", "needs_human": false, "reason": "..."}.
- "reason" is only filled when needs_human=true and explains briefly why a human should jump in.`;
}

async function generateReply({ userId, conversationId, incomingMessage, customerName }) {
  if (!client) {
    return { reply: '[AI offline — set ANTHROPIC_API_KEY]', needs_human: true, reason: 'AI not configured' };
  }

  const uR = await query('SELECT id, email, full_name FROM users WHERE id = $1', [userId]);
  const user = uR.rows[0];
  const pR = await query('SELECT * FROM profiles WHERE user_id = $1', [userId]);
  const profile = pR.rows[0];

  const hR = await query(
    `SELECT direction, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 12`,
    [conversationId]
  );
  const history = hR.rows.reverse();

  const messages = history.map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.direction === 'inbound' ? m.body : JSON.stringify({ reply: m.body, needs_human: false })
  }));

  messages.push({
    role: 'user',
    content: `Customer ${customerName || ''} just sent: "${incomingMessage}"\n\nReply as JSON only.`
  });

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: buildSystemPrompt(user, profile),
      messages
    });
    const text = resp.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { reply: text.trim(), needs_human: false };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      reply: String(parsed.reply || '').trim(),
      needs_human: Boolean(parsed.needs_human),
      reason: parsed.reason || ''
    };
  } catch (err) {
    console.error('[ai] generation failed', err.message);
    return { reply: '', needs_human: true, reason: 'AI error: ' + err.message };
  }
}

async function generateCaption({ userId, prompt }) {
  if (!client) return prompt || '';
  const uR = await query('SELECT id, email, full_name FROM users WHERE id = $1', [userId]);
  const user = uR.rows[0];
  const pR = await query('SELECT * FROM profiles WHERE user_id = $1', [userId]);
  const profile = pR.rows[0];
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: `Write a social media caption in the voice of ${user.full_name || user.email}.
Voice: ${profile?.tone || 'warm and conversational'}.
Bio: ${profile?.bio || ''}.
Languages: ${profile?.languages || 'English'}.
Return ONLY the caption text, no quotes, no preamble.`,
      messages: [{ role: 'user', content: prompt || 'Write an engaging caption for my post.' }]
    });
    return (resp.content?.[0]?.text || '').trim();
  } catch (err) {
    console.error('[ai] caption failed', err.message);
    return prompt || '';
  }
}

module.exports = { generateReply, generateCaption };
