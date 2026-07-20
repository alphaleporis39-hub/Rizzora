export const prerender = false;

import type { APIRoute } from "astro";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabaseClient: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  supabaseClient = createClient(url, key);
  return supabaseClient;
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const DAILY_LIMIT = 20;

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

export const POST: APIRoute = async ({ request }) => {
  const apiKey = process.env.GROQ_API_KEY || import.meta.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "AI service is not configured. Please contact support." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let supabase: SupabaseClient;
  try {
    supabase = getSupabase();
  } catch (err) {
    console.error("[generate-reply] Supabase init failed:", err);
    return new Response(JSON.stringify({ error: "Usage tracking service is temporarily unavailable. Please try again later." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userId = request.headers.get("x-user-id");
  if (!userId || typeof userId !== "string" || userId.length < 10 || userId.length > 80) {
    return new Response(JSON.stringify({ error: "Invalid request. Please reload the page and try again." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const today = new Date().toISOString().slice(0, 10);

  let currentCount = 0;
  const { data: existingRow, error: readErr } = await supabase
    .from("ai_usage")
    .select("count")
    .eq("user_id", userId)
    .eq("usage_date", today)
    .maybeSingle();

  if (readErr) {
    console.error("[generate-reply] Supabase read error:", readErr.message, readErr.code, readErr.details);
    return new Response(JSON.stringify({ error: "Usage tracking service is temporarily unavailable. Please try again later." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  currentCount = existingRow?.count ?? 0;
  console.log("[generate-reply] Current usage for", userId, "on", today, ":", currentCount);

  if (currentCount >= DAILY_LIMIT) {
    return new Response(JSON.stringify({ error: "You've reached your daily limit of 20 AI generations. Please try again tomorrow." }), {
      status: 429,
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
        max_tokens: 400,
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

    const newCount = currentCount + 1;

    if (existingRow) {
      const { data: updateData, error: updateErr } = await supabase
        .from("ai_usage")
        .update({ count: newCount, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("usage_date", today)
        .select("count");

      if (updateErr) {
        console.error("[generate-reply] Supabase update failed:", updateErr.message, updateErr.code, updateErr.details);
      } else {
        console.log("[generate-reply] Usage updated:", userId, today, "count:", newCount, "response:", JSON.stringify(updateData));
      }
    } else {
      const { data: insertData, error: insertErr } = await supabase
        .from("ai_usage")
        .insert({ user_id: userId, usage_date: today, count: newCount });

      if (insertErr) {
        if (insertErr.code === "23505") {
          console.log("[generate-reply] Unique violation on insert, falling back to update for:", userId, today);
          const { data: retryData, error: retryErr } = await supabase
            .from("ai_usage")
            .update({ count: newCount, updated_at: new Date().toISOString() })
            .eq("user_id", userId)
            .eq("usage_date", today)
            .select("count");

          if (retryErr) {
            console.error("[generate-reply] Supabase fallback update failed:", retryErr.message, retryErr.code, retryErr.details);
          } else {
            console.log("[generate-reply] Usage updated via fallback:", userId, today, "count:", newCount, "response:", JSON.stringify(retryData));
          }
        } else {
          console.error("[generate-reply] Supabase insert failed:", insertErr.message, insertErr.code, insertErr.details);
        }
      } else {
        console.log("[generate-reply] Usage inserted:", userId, today, "count:", newCount, "response:", JSON.stringify(insertData));
      }
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
