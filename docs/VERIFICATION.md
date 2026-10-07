# Verification

Verified September 25, 2026 in the private testing server.

- Deployed the Worker, D1 schema, and five-minute schedule on Cloudflare.
- Discord verified the signed interactions endpoint successfully.
- Imported all four source test messages and posted one daily puzzle.
- Tested the same practice round with both existing accounts: one incorrect guess and one correct guess.
- Confirmed private menus and confirmations stay private, while both public results appear in the game channel.
- Confirmed the first player’s submission does not stop the second player from answering.
- Confirmed selecting a bot is rejected without consuming a guess.
- Confirmed reopening a completed player’s menu refuses a second guess.
- Confirmed a non-admin cannot finish a practice round.
- Finished the practice round as server owner: original author revealed, original-message link shown, controls removed, and recap lists the correct player before the incorrect player.
- Daily guesses and daily standings were left unused for the owner’s testing.
- Cloudflare’s scheduled job ran successfully after deployment.
- Unsigned live endpoint requests return HTTP 401.
- Checked that the bot token is absent from tracked files; local secret file is ignored and has mode 0600.
- Automated tests and GitHub Actions pass.

The midnight transition is covered by date-boundary/DST tests and the same reveal path exercised in practice. A real midnight transition was not waited for during this session.

## September 26: copy cleanup and media

- Deployed media schema migration and optional `/guesser practice message:` argument.
- Updated nine existing puzzle/result/recap posts to the new concise layout, preserving scores.
- Tested targeted practice rounds against the user's uploaded PNG, MP4, and X post in the private game channel. Discord displayed the image, played the 48-second video inline, and showed the X author/content preview. All three rounds were left available for user testing.
- Checked the real YouTube oEmbed endpoint: a valid video produced metadata; an invalid video was rejected. YouTube playback in a live puzzle still needs a user-posted source sample.
- Typecheck and all 36 automated tests passed, covering link failures, redirect restrictions, preview metadata, media eligibility, concise output, and existing game behavior.
- Link checks establish availability at selection time; they cannot guarantee later uptime or detect every HTTP-200 error page. Native previews remain subject to provider/client restrictions.

## September 26: on-demand history sampling

- Replaced bulk history import with Discord search scoped to the configured source channel. Random month selection spans the oldest human message through today; dense periods are narrowed before choosing a result offset.
- Removed the copied message archive with migration 0004. Existing puzzles and scores are preserved. No paid services were enabled.
- Persisted search cooldowns for rate-limit and indexing responses; bounded search work per invocation and retries through existing Cron maintenance.
- Verified a live `/guesser-admin practice` with no source argument after dropping the archive: a random X-link puzzle posted successfully with its native preview.
- All 40 tests passed, including old/recent period selection, dense-period subdivision, request caps, cooldown persistence, former-member rejection, and daily repeat avoidance.
- Production-scale history has not yet been tested because the bot still targets the private test server.

## September 26: Cathedral private deployment

- User authorized API/CLI setup in The Cathedral, explicitly excluding computer-use navigation and all server deletion. Recorded this in AGENTS.md.
- Validated supplied server/source/private-output/future-output IDs through read-only API calls. Source and server sharing an ID is valid; the source is `everything`.
- Provisioned a separate D1 database for Cathedral private testing; retained the previous server's database. Deployed with an empty Cron schedule.
- Removed private-reply deletion. The selector becomes “Guess submitted.”; Discord DELETE and bulk-delete calls are blocked before any network request. Commands are upserted individually rather than bulk replaced.
- Posted and fetched one real randomly sampled practice puzzle in the private test channel. Confirmed the Guess button, application identity, and channel. Verified command registration and admin permissions, plus Worker health. No posts were sent to the future public channel.
- All 41 automated tests passed. User interaction testing in The Cathedral remains for the user; no server UI automation was performed.

## September 26: context, member browsing, three guesses

- Enabled the application's limited Server Members intent through the official API; verified the Cathedral member-list endpoint returns 76 human members. Picker uses sorted nickname/display-name options in groups of at most 25, with pagination only above 100 remaining members.
- New rounds filter command-like targets and retain short anonymous before/after excerpts. Context mentions are redacted, URLs reduced to `[link]`, and the target is explicitly marked. Existing rounds retain their original one-guess limit.
- Added atomic attempt records with unique interaction/person constraints, expected-attempt validation, and a trigger producing one final outcome only at success/exhaustion. Closing a round finalizes unfinished participants. Public results and recaps include attempt squares; daily stats count final outcomes, not individual attempts.
- All 45 tests passed, including stale/double submissions, duplicate names, third-miss finalization, early success, close/expiry, old-round compatibility, 76-member coverage, command filtering, context placement, and no-deletion enforcement.
- Created a fresh practice round using real Cathedral history and verified its posted message through the API: before and after context, target arrow, and Guess button are present. Interactive visual testing is left to the user because server UI automation is prohibited. No existing messages were deleted; public posting and scheduled daily rounds remain disabled.

## September 26: regular authors and simpler clues

- Removed before/after labels and the separate target heading. The target is now arrow + bold message, with “See attachment below.” for attachments.
- Added cached source-channel counts for current human members. New puzzles require more than 100 messages; their saved eligible-author IDs govern both target selection and dropdown choices. Bots and former members are excluded. Legacy rounds preserve their existing choices.
- Completed the initial count check through bounded Discord searches with persisted cooldowns: 28 members qualify. Only IDs/counts are cached, without copying the channel history.
- Applied additive migration 0006 and deployed the Worker. Posted a fresh practice puzzle only in the private Cathedral test channel; API verification confirmed bold target, no old labels, Guess button, three attempts, and all 28 eligible choices across two dropdowns, including the answer.
- Typecheck and all 51 tests passed, including strict threshold boundaries, cache reuse, bounded refresh, cooldown recovery, former-member exclusion, and matching target/choice pools. Visual interaction testing is left to the user. No messages were deleted; scheduled and public posting remain disabled.

## September 26: manually excluded authors

- Added a source-scoped author exclusion setting in D1 state. It applies before count checks and governs both new target selection and the saved choice pool. Account IDs stay in private configuration, outside the public repository.
- Configured the three requested exclusions and deployed. A fresh private practice puzzle has exactly 25 choices in one dropdown, with its answer included and all excluded accounts absent. Existing rounds and messages were preserved.
- Typecheck and all 52 tests passed, including exclusion application and source-channel isolation.

## September 26: speaker context and finished-picker dismissal

- New context stores the other speaker’s display name; neighboring messages from the target author use `???`. Legacy anonymous context remains readable. Verified a fresh private practice post has two labeled context entries and 25 eligible choices.
- Results state the number of guesses, with a blank line before attempt squares and no redundant numeric fraction. Unused squares remain white.
- User explicitly authorized dismissing completed ephemeral pickers. The dedicated helper reads the interaction response and verifies its ephemeral flag and application author before deleting only that response. General Discord DELETE and bulk-delete remain blocked; no channel-message cleanup was performed. Updated AGENTS.md with this narrow exception.
- Typecheck and all 55 tests passed, including target-author masking, display names, result spacing, completed-picker dismissal, and refusal to dismiss public or other-application responses. Deployed successfully. Actual private-picker dismissal awaits the user’s next interaction; server UI automation remains prohibited.

## September 26: neighboring media

- New context retains up to two links and two fresh attachments per neighbor, plus available checked link metadata. Target-author neighbors remain `???`; other speakers retain display names.
- Media context switches the puzzle to ordered message cards: preceding message, bold arrow-marked target, following message. Images appear in their cards; video/files have clickable watch/open links. Available link metadata supplies previews. Text-only context keeps the existing compact layout.
- Deployed and posted a real practice puzzle in the private test channel with a neighboring photo. Read-only API verification found three cards, the target in the middle, the contextual image first, a Discord-proxied image URL, and the Guess control.
- Typecheck and all 58 tests passed, including media retention, speaker masking, card ordering, reveal preservation, and Discord embed count/text limits. In-card videos are clickable rather than inline players; visual review remains with the user. No channel messages were deleted.

## September 26: revert neighboring media cards

- At the user's request, restored compact text context with `[link]` and `[Attachment]` placeholders. Display names and the bold `➡ ???:` target remain; target media still displays normally.
- Existing saved media context renders as placeholders without deleting stored records. Updated the current private practice post in place and verified its compact format through the API.
- Deployed successfully. Typecheck and all 56 tests pass, including saved-media-context compatibility and preservation of target attachments. No messages were deleted.

## September 26: live launch

- User authorized launch to `games` (1387873171813957673) and requested that testing not affect standings. Confirmed the bot has View Channel, Read Message History, Send Messages and Embed Links permissions through read-only API checks.
- Created `cathedral-guesser-cathedral-live` and applied migrations. Kept the testing databases and Discord channel intact. Copied only author-count/source settings and exclusions; verified zero rounds and guesses before launch. One existing Worker/application now points to this clean live database.
- Enabled five-minute scheduled maintenance; game-day boundaries remain midnight America/New_York. Deployed version `4300b389-6725-413f-8c24-955683fa0150` with the live channel and database bindings.
- Ran maintenance and verified the first daily (not practice) puzzle is open in `games`, with three guesses, 25 choices, and the correct Guess control. Verified successful maintenance state, zero practice rounds and Worker health. Testing results were not transferred.
- Typecheck and all 56 tests passed before deployment. No channel messages or archived testing records were deleted. The next real midnight transition remains to occur; date-boundary/DST behavior is covered by existing tests.

## September 26: alternate-account exclusion

- Applied the user's additional account exclusion through the existing live source-scoped setting. Future target selection and choices now exclude that account; the requested primary account remains eligible.
- Verified the excluded account is not today's answer before removing it from today's saved choice pool. The current puzzle remains open with 24 choices, its correct author selectable and its three-guess limit unchanged. No attempts, scores, source messages or puzzle content were modified.
- This was a live configuration change using existing functionality; no Worker redeployment was needed. Already-open private menus refresh on reopening or when an excluded option is submitted, without consuming that selection.

## September 26: clearer instructions, timestamps and source links

- Rewrote help around three consecutive messages from everything and guessing the middle, arrow-marked message. Explained same-speaker `???`, three attempts and result squares directly.
- New context saves original timestamps; targets derive their timestamp from the source message ID. Discord displays absolute dates/times in the viewer's locale. Legacy context remains readable.
- Correct guesses now replace the ephemeral picker with a private original-message link; correct players can reopen Guess to retrieve it. Losses still dismiss privately without exposing the answer. Day-end recaps include an Original message link button, alongside the existing source link on the revealed puzzle.
- Re-enabled private testing through a TEST_DB binding on the same Worker. Only interactions originating in the configured testing channel use that database; scheduled maintenance stays on live data. Guess-triggered result delivery is scoped to the played round. Preserved previous testing records and synchronized author exclusions.
- Deployed and posted a fresh private practice round. Read-only API verification confirmed three original timestamps, the bold arrow-marked target and the Guess control. All 59 tests and typecheck passed, including private win/loss behavior, live/test routing, timestamp rendering and recap links. User interaction testing remains with the user; no live scores were changed.

## September 26: apply current layout to the live daily post

- Updated the existing daily post in games in place to the current speaker-heading layout. Matched both saved context excerpts to their source neighbors before adding their original timestamps.
- Verified three timestamps, unchanged Guess controls, and unchanged source, author, message text, media, choices, guess limit, status and Discord message ID. Only context timestamp metadata and the post's display text changed; guesses and results were not edited. Existing embeds were preserved.

## October 7: five guesses

- New rounds allow five guesses. Migration 0007 rebuilt `attempts` to raise its CHECK limit to five, keeping all existing attempts (203 live). Earlier rounds keep their saved three-guess limit. Applied to live and test databases, deployed, and re-registered the command description.
- At the user's request, replaced today's three-guess daily puzzle. The user deleted its posts in games, and a read-only API check confirmed none remained. Its rows (round, 3 results, 9 attempts) were backed up to an ignored local file and then removed from the live database only. Scheduled maintenance posted a new five-guess puzzle for today. No other rounds, scores, or Discord messages were changed.
