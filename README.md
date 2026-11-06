# Pronoun Bot

A Telegram bot that lets group members set their own Telegram member tag with:

```text
/mypronoun she/her
/mypronoun they/them
/mypronoun she/they
```

This project is built for Cloudflare Workers + D1 and receives Telegram updates through a webhook.

> Implementation note: This version uses the Telegram HTTP Bot API (`setChatMemberTag`) instead of MTProto. It is a JavaScript Cloudflare Worker project, not a Python project.

## Features

- Lets a user set their own Telegram member tag from a chat command
- Validates and sanitizes user input before sending it to Telegram
- Enforces a per-user cooldown with D1 storage
- Deduplicates webhook updates to avoid duplicate processing
- Protects the webhook with the Telegram secret-token header
- Stores secrets in Cloudflare Worker secrets instead of source code

## Requirements

- Node.js and npm
- A Cloudflare account
- Wrangler CLI (installed via this project's dev dependency)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Telegram group where the bot can be made an administrator

## Telegram permissions

Add the bot to the target group and grant the administrator permission required to manage member tags (`can_manage_tags`). The exact permission availability depends on Telegram's Bot API and your group type.

The command only targets `message.from.id`, so a user cannot use this command to change another member's tag.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the D1 database

```bash
npx wrangler d1 create pronoun-bot-db
```

Copy the returned database ID into `wrangler.toml`, replacing:

```toml
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

### 3. Create the database tables

```bash
npx wrangler d1 execute pronoun-bot-db --remote --file=./schema.sql
```

For local development, use `--local` instead of `--remote`.

### 4. Configure the bot username

In `wrangler.toml`, set `BOT_USERNAME` to the bot's username without the `@` symbol.

### 5. Add secrets

Set the Telegram bot token:

```bash
npx wrangler secret put BOT_TOKEN
```

Generate a webhook secret (Telegram accepts 1–256 characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`):

```bash
openssl rand -hex 32
```

Save it as a Worker secret:

```bash
npx wrangler secret put WEBHOOK_SECRET
```

Do not commit real tokens or secrets to Git.

### 6. Deploy

```bash
npm run deploy
```

Your Worker URL will look similar to:

```text
https://pronoun-bot.YOUR_SUBDOMAIN.workers.dev
```

### 7. Register the Telegram webhook

Replace the placeholders and run:

```bash
curl -X POST \
  "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://pronoun-bot.YOUR_SUBDOMAIN.workers.dev/telegram-webhook",
    "secret_token": "YOUR_WEBHOOK_SECRET",
    "allowed_updates": ["message"]
  }'
```

The `secret_token` value must exactly match the `WEBHOOK_SECRET` Worker secret.

Check webhook status:

```text
https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo
```

Treat the URL above as sensitive because it contains the bot token.

## Local development

Create `.dev.vars` based on `.dev.vars.example` and fill in local test credentials. This file is ignored by Git.

```bash
npm run dev
```

A local webhook requires a publicly reachable HTTPS endpoint or a suitable tunnel. Do not expose a development Worker with production credentials.

## Security and abuse controls

- Webhook requests are authenticated using Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
- Request bodies are capped at 64 KiB.
- The tag is limited to 16 Unicode code points.
- The accepted tag character set excludes emoji, control characters, bidi controls, and invisible formatting characters.
- A per-user cooldown is enforced using D1.
- Update IDs are claimed atomically to prevent concurrent duplicate processing.
- Old deduplication and rate-limit records are cleaned up daily.
- Bot tokens are stored as Worker secrets, not in source files.
- User input and tokens are not included in application logs.

### Important limitations

- The cooldown is per Telegram user across all groups, not per group.
- D1-backed per-user cooldowns do not replace Cloudflare edge rate limiting. For stronger protection against floods from many distinct accounts, configure Cloudflare rate limiting or WAF rules.
- Update claiming provides duplicate suppression, but it is not a transactional exactly-once guarantee for external Telegram API side effects. A process crash after Telegram accepts an action but before completion can still create an inconsistent result.
- Telegram API errors are intentionally not exposed to users. Inspect Worker logs for operational diagnostics.
- Test the bot in a private test group before deploying it to public groups.

## Project structure

```text
pronoun-bot/
├── src/
│   └── index.js
├── schema.sql
├── wrangler.toml
├── package.json
├── .dev.vars.example
├── .gitignore
├── README.md
└── LICENSE
```

## AI assistance

OpenAI Codex was used to assist with the development of this project.

## License

This project is licensed under the BSD 3-Clause License. See the [LICENSE](LICENSE) file for details.
