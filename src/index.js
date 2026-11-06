const MAX_TAG_LENGTH = 16;
const RATE_LIMIT_SECONDS = 5;
const MAX_BODY_SIZE = 64 * 1024;

function response(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function telegram(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Telegram returned a non-JSON response (${res.status})`);
  }

  if (!res.ok || !data?.ok) {
    // Do not log the request URL: it contains the bot token.
    throw new Error(`Telegram API failure (${data?.error_code ?? res.status})`);
  }
  return data.result;
}

function validateTag(input) {
  if (typeof input !== "string") return null;

  const tag = input.trim().replace(/\s+/gu, " ");
  if (!tag || [...tag].length > MAX_TAG_LENGTH) return null;

  // Permit ordinary letters, combining marks, numbers and simple separators.
  // This excludes control, bidi, zero-width and other formatting characters.
  if (!/^[\p{L}\p{M}\p{N} ./_-]+$/u.test(tag)) return null;

  return tag;
}

async function isRateLimited(env, userId) {
  const result = await env.DB.prepare(`
    INSERT INTO user_rate_limits (user_id, last_request)
    VALUES (?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      last_request = unixepoch()
    WHERE unixepoch() - last_request >= ?
    RETURNING user_id
  `).bind(userId, RATE_LIMIT_SECONDS).first();

  return !result;
}

async function sendMessage(env, chatId, text, replyTo) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_to_message_id: replyTo,
    allow_sending_without_reply: true,
  });
}

async function handleUpdate(update, env) {
  const message = update?.message;
  if (!message || typeof message.text !== "string" || !message.from || !message.chat) {
    return;
  }

  const user = message.from;
  const chat = message.chat;

  if (user.is_bot) return;
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const match = /^\/mypronoun(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/iu
    .exec(message.text.trim());

  if (!match) return;

  if (
    match[1] &&
    match[1].toLowerCase() !== String(env.BOT_USERNAME).toLowerCase()
  ) {
    return;
  }

  if (await isRateLimited(env, user.id)) return;

  const input = match[2] ?? "";
  const tag = validateTag(input);

  if (!tag) {
    const explanation = input.trim()
      ? "Invalid pronouns. Use up to 16 characters, without emoji or unsupported symbols."
      : "Please provide your pronouns. :3\n\nExample: /mypronoun she/they";

    await sendMessage(env, chat.id, explanation, message.message_id);
    return;
  }

  try {
    // The target is always the command sender; users cannot set another
    // member's tag through this command.
    await telegram(env, "setChatMemberTag", {
      chat_id: chat.id,
      user_id: user.id,
      tag,
    });

    await sendMessage(
      env,
      chat.id,
      `Your pronouns have been successfully updated! ^w^\n\nMember tag: ${tag}\n\nThanks for expressing yourself.`,
      message.message_id,
    );
  } catch (error) {
    // Keep logs free of tokens, request URLs and user-supplied input.
    console.error("Member tag update failed:", error instanceof Error ? error.message : "Unknown error");

    await sendMessage(
      env,
      chat.id,
      "Sorry! I couldn't update your member tag. </3 Please check that the bot has the required administrator permissions.",
      message.message_id,
    );
  }
}

async function processUpdate(update, env) {
  // Claim atomically before handling, preventing concurrent duplicate work.
  const claim = await env.DB.prepare(`
    INSERT OR IGNORE INTO processed_updates (update_id, processed_at)
    VALUES (?, unixepoch())
  `).bind(update.update_id).run();

  if (claim.meta.changes === 0) return;

  try {
    await handleUpdate(update, env);
  } catch (error) {
    // Release the claim so Telegram can retry transient failures.
    await env.DB.prepare(
      "DELETE FROM processed_updates WHERE update_id = ?"
    ).bind(update.update_id).run();
    throw error;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return request.method === "GET"
        ? response("OK")
        : response("Method Not Allowed", 405);
    }

    if (url.pathname !== "/telegram-webhook") return response("Not Found", 404);
    if (request.method !== "POST") return response("Method Not Allowed", 405);

    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.BOT_USERNAME || !env.DB) {
      console.error("Required Worker configuration is missing.");
      return response("Service Unavailable", 503);
    }

    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!suppliedSecret || suppliedSecret !== env.WEBHOOK_SECRET) {
      return response("Unauthorized", 401);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
      return response("Payload Too Large", 413);
    }

    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_SIZE) {
        return response("Payload Too Large", 413);
      }

      const update = JSON.parse(raw);
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
        return response("Invalid Update", 400);
      }

      await processUpdate(update, env);
      return response("OK");
    } catch (error) {
      console.error("Webhook processing failed:", error instanceof Error ? error.message : "Unknown error");
      return response("Internal Server Error", 500);
    }
  },

  async scheduled(_controller, env) {
    await env.DB.prepare(`
      DELETE FROM processed_updates
      WHERE processed_at < unixepoch() - 604800
    `).run();

    await env.DB.prepare(`
      DELETE FROM user_rate_limits
      WHERE last_request < unixepoch() - 86400
    `).run();
  },
};
