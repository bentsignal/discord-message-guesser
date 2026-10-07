# Discord Message Guesser

A daily Discord game: guess who sent an old message from your server.

## Rules

- The bot shows three messages from a channel’s history. Guess who sent the **bold middle message**; the messages above and below are context.
- Click **Guess** and select a name. You get five tries.
- `???` hides the author, including on nearby messages they sent.
- 🟥 is a miss, 🟩 is correct, and ⬜ is an unused try. Results are public; guessed names stay private.
- A correct guess gives you a private link to the original message. At the daily reset, everyone gets the answer, link, and results recap.
- Stats and the leaderboard count daily games. Practice rounds don’t count.

Messages come from current human members with more than 100 messages in the source channel. Bots, command-like messages, and configured excluded accounts are skipped. The correct author is included in the choices.

## Commands

| Command | What it does |
| --- | --- |
| `/guesser play` | Open today’s guessing menu |
| `/guesser help` | Explain how to play |
| `/guesser stats` | Your record |
| `/guesser leaderboard` | Top ten players |
| `/guesser-admin status` | Check the bot’s status |
| `/guesser-admin sync` | Retry pending work and today’s puzzle |
| `/guesser-admin practice` | Start a practice round; optionally choose a source message |
| `/guesser-admin finish-practice` | Reveal and recap the latest practice round |

Admin commands require **Manage Server** or **Administrator**. The bot does not need Administrator.

## Set up your server

Runs on Cloudflare Workers and D1. You’ll need a Discord application and a Cloudflare account.

Follow [SETUP.md](docs/SETUP.md), or give it to your coding agent. Start from [wrangler.example.jsonc](wrangler.example.jsonc): the existing `wrangler.jsonc` belongs to a running server.

Source and game channels are configured separately. The reset is midnight in your chosen timezone. Exclusions live in the database; no server’s excluded accounts are hardcoded. History is sampled on demand, without copying the channel into a database.

## Development

```sh
npm ci
npm run check
```

Read [AGENTS.md](AGENTS.md) before making changes. Never commit tokens or private Discord data.
