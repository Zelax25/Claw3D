export type VoiceReplyProvider = "elevenlabs" | "speaches";

export type VoiceReplySynthesisRequest = {
  text: string;
  provider?: VoiceReplyProvider;
  voiceId?: string | null;
  speed?: number;
};

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5";

// Speaches (OpenAI-compatible /v1/audio/speech) — local, on-LAN TTS. Selected
// by VOICE_REPLY_PROVIDER=speaches; needs VOICE_TTS_BASE_URL to point at the
// speaches service (e.g. http://10.10.0.35:8000). Model + default voice are
// env-driven so the deployment owns them.
const DEFAULT_SPEACHES_MODEL = "speaches-ai/piper-en_US-amy-medium";
const DEFAULT_SPEACHES_VOICE = "amy";

const normalizeVoiceSpeed = (value: number | null | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(1.2, Math.max(0.7, value));
};

const normalizeVoiceId = (value: string | null | undefined): string => {
  const explicit = value?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_ELEVENLABS_VOICE_ID;
};

const synthesizeWithElevenLabs = async (
  request: VoiceReplySynthesisRequest
): Promise<Response> => {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing ELEVENLABS_API_KEY.");
  }
  const voiceId = normalizeVoiceId(request.voiceId);
  const speed = normalizeVoiceSpeed(request.speed);
  const response = await fetch(
    `${ELEVENLABS_API_URL}/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text: request.text,
        model_id: DEFAULT_ELEVENLABS_MODEL_ID,
        voice_settings: {
          stability: 0.42,
          similarity_boost: 0.88,
          style: 0.2,
          use_speaker_boost: true,
          speed,
        },
      }),
      cache: "no-store",
    }
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(detail || "ElevenLabs voice synthesis failed.");
  }
  return response;
};

const synthesizeWithSpeaches = async (
  request: VoiceReplySynthesisRequest
): Promise<Response> => {
  const baseUrl = process.env.VOICE_TTS_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error("Missing VOICE_TTS_BASE_URL.");
  }
  const model = process.env.VOICE_TTS_MODEL?.trim() || DEFAULT_SPEACHES_MODEL;
  // The voice picker in the UI lists ElevenLabs voice ids, which don't map to
  // speaches voices, so use the deployment's configured voice rather than the
  // per-agent ElevenLabs id.
  const voice = process.env.VOICE_TTS_VOICE?.trim() || DEFAULT_SPEACHES_VOICE;
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/audio/speech`, {
    method: "POST",
    headers: {
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: request.text,
      voice,
      response_format: "mp3",
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(detail || "Speaches voice synthesis failed.");
  }
  return response;
};

export const synthesizeVoiceReply = async (
  request: VoiceReplySynthesisRequest
): Promise<Response> => {
  // The deployment chooses the backend via VOICE_REPLY_PROVIDER; this overrides
  // the client-sent provider (the UI only knows "elevenlabs"). Falls back to the
  // request provider, then elevenlabs.
  const envProvider = process.env.VOICE_REPLY_PROVIDER?.trim();
  const provider: VoiceReplyProvider =
    envProvider === "speaches" || envProvider === "elevenlabs"
      ? envProvider
      : (request.provider ?? "elevenlabs");
  switch (provider) {
    case "speaches":
      return synthesizeWithSpeaches(request);
    case "elevenlabs":
      return synthesizeWithElevenLabs(request);
    default:
      throw new Error("Unsupported voice reply provider.");
  }
};
