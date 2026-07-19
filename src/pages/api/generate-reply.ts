export const prerender = false;

import type { APIRoute } from "astro";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// Simple in-memory rate limiter (per-IP, resets on server restart)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 8;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 60_000);

const SYSTEM_PROMPT = `You are Rizzora's texting assistant. You help people craft natural, respectful dating replies.

RULES:
- Generate exactly 3 short replies (1-2 sentences each)
- Replies must sound human, natural, and conversational — never robotic or scripted
- Always be respectful, kind, and encouraging
- Match the language the user writes in (English or Hinglish/Hindi in Roman script)
- If the input is Hinglish, reply in Hinglish. If English, reply in English.
- Never be creepy, pushy, or manipulative
- Keep replies under 30 words each
- Do NOT include quotes, labels, or numbering in the reply text itself

OUTPUT FORMAT (strict JSON):
{
  "safe": "reply text here",
  "playful": "reply text here",
  "flirty": "reply text here"
}

safe: Warm, genuine, shows interest without pressure
playful: Light, fun, adds humor and personality
flirty: Expresses clear interest, charming but respectful

Return ONLY the JSON object, no markdown, no explanation.`;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const ip = clientAddress || request.headers.get("x-forwarded-for") || "unknown";

  if (!checkRateLimit(ip)) {
    return new Response(JSON.stringify({ error: "Too many requests. Please wait a moment and try again." }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = import.meta.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "AI service is not configured. Please contact support." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { message?: string; name?: string; draft?: string; language?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request format." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { message, name, draft, language } = body;

  if (!message || typeof message !== "string" || message.trim().length < 2) {
    return new Response(JSON.stringify({ error: "Please enter a message to get replies." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (message.length > 1000) {
    return new Response(JSON.stringify({ error: "Message is too long. Please keep it under 1000 characters." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const lang = language === "hinglish" ? "Hinglish" : "English";
  const who = name?.trim() || "them";

  let userPrompt = `Language: ${lang}\n`;
  userPrompt += `Their name (optional): ${who}\n`;
  userPrompt += `Message I received: "${message.trim()}"\n`;
  if (draft?.trim()) {
    userPrompt += `My draft reply (optional): "${draft.trim()}"\n`;
  }
  userPrompt += `\nGenerate 3 reply options (safe, playful, flirty) in ${lang}.`;

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.85,
        max_tokens: 300,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Groq API error:", res.status, err);

      if (res.status === 401) {
        return new Response(JSON.stringify({ error: "AI service authentication failed. Please contact support." }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (res.status === 429) {
        return new Response(JSON.stringify({
          error: "AI service is experiencing high demand. Please wait a minute and try again.",
          retryAfter: 60,
        }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "AI service is temporarily unavailable. Please try again." }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim();

    if (!raw) {
      return new Response(JSON.stringify({ error: "Empty response from AI. Please try again." }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    let parsed: { safe: string; playful: string; flirty: string };
    try {
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("Failed to parse Groq response:", raw);
      return new Response(JSON.stringify({ error: "Could not parse AI response. Please try again." }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!parsed.safe || !parsed.playful || !parsed.flirty) {
      return new Response(JSON.stringify({ error: "AI response was incomplete. Please try again." }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ replies: parsed }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Generate reply error:", err);
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again later." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
