import { log } from "./logger.ts";

/**
 * Transcribe an audio buffer using Groq's Whisper API.
 * Returns the transcribed text, or empty string on failure.
 */
export async function transcribe(audioBuffer: Buffer, groqKey: string): Promise<string> {
  if (!groqKey) {
    log.warn("transcribe", "No Groq API key configured — cannot transcribe voice message");
    return "";
  }

  try {
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: "audio/ogg" });
    formData.append("file", blob, "voice.ogg");
    formData.append("model", "whisper-large-v3-turbo");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error("transcribe", "Groq API error", { status: response.status, body: errorText });
      return "";
    }

    const result = await response.json() as { text?: string };
    return result.text?.trim() ?? "";
  } catch (err) {
    log.error("transcribe", "Failed to transcribe audio", { error: String(err) });
    return "";
  }
}
