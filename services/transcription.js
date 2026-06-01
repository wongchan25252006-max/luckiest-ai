// Optional voice transcription via OpenAI Whisper.
// Set OPENAI_API_KEY in .env to enable. Without it, voice arrives as "[voice message]"
// and the conversation is flagged for human follow-up.

async function transcribe(audioBuffer, filename = 'audio.ogg') {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const form = new FormData();
    const blob = new Blob([audioBuffer]);
    form.append('file', blob, filename);
    form.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });
    if (!res.ok) {
      console.error('[transcription] Whisper failed:', res.status, await res.text());
      return null;
    }
    const { text } = await res.json();
    return text || null;
  } catch (err) {
    console.error('[transcription] error:', err.message);
    return null;
  }
}

module.exports = { transcribe };
