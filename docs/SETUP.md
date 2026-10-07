# Set up another server

Use a new Discord application, Worker, and D1 database. Do not deploy this repository’s existing `wrangler.jsonc` or reuse its IDs. The commands below use your own local configuration instead. The working Cathedral deployment does not need to change.

## 1. Create the Discord bot

In the [Discord Developer Portal](https://discord.com/developers/applications):

- Create an application and bot. Save its application ID, public key, and bot token.
- Enable **Message Content Intent** and **Server Members Intent**.
- Install it in your server with `bot` and `applications.commands` scopes and permissions **View Channels**, **Read Message History**, **Send Messages**, and **Embed Links** (`84992`).
- Give it access to the source channel and game channel. Do not grant Administrator or Manage Messages.

Enable Discord Developer Mode to copy the server and channel IDs.

## 2. Configure Cloudflare

Requires Node 24+ and a Cloudflare account.

```sh
npm ci
npm run check
npx wrangler login
npx wrangler d1 create my-message-guesser
cp wrangler.example.jsonc wrangler.local.jsonc
cp .env.example .dev.vars
```

Fill every placeholder in `wrangler.local.jsonc`, including the new D1 ID. Choose a unique Worker name and your timezone. Leave `crons` empty until testing is complete.

Fill `.dev.vars` with your bot token, application ID, public key, and server ID. Both local files are ignored by Git. Keep the token out of Wrangler’s `vars`.

```sh
npx wrangler d1 migrations apply my-message-guesser --remote --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
npx wrangler secret put DISCORD_TOKEN --config wrangler.local.jsonc
node --env-file=.dev.vars scripts/register-commands.mjs
```

Use your chosen database name in the migration command. Avoid `npm run deploy` and `npm run db:migrate` for a new installation: those defaults target the existing deployment.

In the Discord application settings, set the Interactions Endpoint URL to `https://YOUR-WORKER.workers.dev/interactions`.

## 3. Test and enable daily games

Run `/guesser-admin practice`. The initial author-count checks run in small batches; retry after a short pause if the bot is not ready. Verify a correct guess, five misses, and `/guesser-admin finish-practice`. Practice scores do not affect the leaderboard.

For an optional private test channel, add `TEST_CHANNEL_ID` to your configuration and a second D1 binding named `TEST_DB` pointing to a separate, migrated database. Commands and buttons in that channel use testing data; the daily schedule uses only `DB` and `GAME_CHANNEL_ID`.

When ready, set `triggers.crons` to `["*/5 * * * *"]` and deploy using your local config. Run `/guesser-admin sync` to post today’s puzzle immediately. The schedule checks every five minutes and starts a new round at midnight in `TIME_ZONE`.

## Author exclusions and branding

Excluded accounts are stored in D1’s `state` table. The key is `excluded_authors:SOURCE_CHANNEL_ID`; its value is a JSON array of Discord user IDs. An empty array means no exclusions. The setting applies to both future message selection and future choice lists. Preserve existing exclusions when adding an account. Existing rounds retain their saved choices; never remove their correct author or reset players’ attempts.

The minimum message count is `AUTHOR_THRESHOLD` in `src/eligibility.ts` (currently more than 100).

Set the bot’s name/avatar in Discord. To customize the remaining Cathedral labels and `#everything` wording, edit `src/game.ts`, `src/index.ts`, and `scripts/register-commands.mjs` in your copy, then run checks and register commands again. This repository’s original installation keeps its current branding.

## Notes for agents

- Never copy another installation’s puzzles, scores, tokens, or private data.
- Use `--config wrangler.local.jsonc` for every Wrangler operation on the new installation.
- Do not delete channel messages. The only deletion supported by the game is dismissing its own verified private picker after a loss.
- Keep `npm run check` passing. CI runs checks and a dry-run build; it does not deploy.
- `/health` checks availability. `/guesser-admin status` shows search readiness and maintenance status. The bot can appear offline because it uses HTTP interactions rather than a Gateway connection.
