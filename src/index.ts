import type { Env, Interaction, Round, Guess } from './types';
import { discord, dismissPrivatePicker, noMentions, verifySignature } from './discord';
import {INSERT_ATTEMPT} from './attempts';
import {roster,memberControls} from './members';
import { GUESS_LIMIT, gameDay, resultSquares, originalMessageUrl } from './game';
import { createRound, currentMember, maintenance, publishResults, publishRound, publishRecaps, revealOldRounds, state, withLease } from './storage';

export function interactionEnv(env:Env,i:Interaction):Env {
  return env.TEST_DB&&env.TEST_CHANNEL_ID&&i.channel_id===env.TEST_CHANNEL_ID?{...env,DB:env.TEST_DB,GAME_CHANNEL_ID:env.TEST_CHANNEL_ID}:env;
}
const reply = (content: string, components: unknown[] = []) => ({content,components,allowed_mentions:noMentions});
async function editReply(env: Env, i: Interaction, body: unknown) {
  await discord(env,`/webhooks/${env.DISCORD_APPLICATION_ID}/${i.token}/messages/@original`,'PATCH',body);
}
async function showSelector(env: Env, i: Interaction, roundId: string,page=0,notice='') {
  const round = await env.DB.prepare('SELECT * FROM rounds WHERE id=?').bind(roundId).first<Round>();
  if (!round || round.status !== 'open' || round.day !== gameDay(new Date(),env.TIME_ZONE)) return reply('This round is closed.');
  const existing = await env.DB.prepare('SELECT * FROM guesses WHERE round_id=? AND user_id=?').bind(roundId,i.member!.user.id).first<Guess>();
  if (existing) return existing.correct?winnerReply(env,round):reply('Your result is in. The answer is revealed at midnight Eastern.');
  const attempts=await env.DB.prepare('SELECT guessed_id FROM attempts WHERE round_id=? AND user_id=? ORDER BY attempt').bind(roundId,i.member!.user.id).all<{guessed_id:string}>();
  const used=attempts.results.length,limit=round.guess_limit||1;
  const allMembers=await roster(env);
  const eligible:string[]|null=round.eligible_authors_json?JSON.parse(round.eligible_authors_json):null;
  const controls=memberControls(eligible?allMembers.filter(m=>eligible.includes(m.user.id)):allMembers,round.id,used,attempts.results.map(a=>a.guessed_id),page);
  return reply([notice,used?`${resultSquares(0,used,limit)} · ${limit-used} ${limit-used===1?'guess':'guesses'} left`:'','**Who sent the bolded message?**'].filter(Boolean).join('\n\n'),controls);
}
async function submitGuess(env: Env, i: Interaction, roundId: string,expected=0) {
  const guessed = i.data?.values?.[0];
  if (!guessed || !/^\d{17,20}$/.test(guessed) || i.data?.values?.length!==1 || !Number.isInteger(expected) || expected<0 || expected>=GUESS_LIMIT) return reply('Choose one server member.');
  const round=await env.DB.prepare('SELECT * FROM rounds WHERE id=?').bind(roundId).first<Round>();
  if(round?.eligible_authors_json && !(JSON.parse(round.eligible_authors_json) as string[]).includes(guessed))return showSelector(env,i,roundId,0,'Choose someone from this puzzle’s list.');
  if (!(await currentMember(env,guessed))) return showSelector(env,i,roundId,0,'That person is no longer in the server. Your guess was not used.');
  const userId = i.member!.user.id;
  const saved = await env.DB.prepare(INSERT_ATTEMPT)
    .bind(userId,guessed,expected,guessed,i.id,roundId,gameDay(new Date(),env.TIME_ZONE),expected,userId,expected,userId).first<{attempt:number;correct:number}>();
  const finished=await env.DB.prepare('SELECT * FROM guesses WHERE round_id=? AND user_id=?').bind(roundId,userId).first<Guess>();
  if(finished)return finished.correct&&round?winnerReply(env,round):null;
  return showSelector(env,i,roundId,0,saved?'Not quite.':'That selection was already handled.');
}
function winnerReply(env:Env,round:Round){return reply(`[View the original message in #everything](${originalMessageUrl(round,env.GUILD_ID,env.SOURCE_CHANNEL_ID)})`);}
function isAdmin(i: Interaction) {
  const permissions = BigInt(i.member?.permissions || '0');
  return (permissions & 8n)!==0n || (permissions & 32n)!==0n;
}
async function command(env: Env, i: Interaction) {
  const sub = i.data?.options?.[0]?.name || 'play';
  if (sub==='play') return showSelector(env,i,gameDay(new Date(),env.TIME_ZONE));
  if (sub==='help') return reply('**How to play**\nYou’re looking at three messages from #everything, in the order they were sent. **Guess who sent the middle message**, shown in bold under **👤 ???**. The messages above and below it are clues to the conversation. If they also say ???, they were sent by the same person you’re guessing.\n\nClick **Guess** and choose a name. You get **five tries**; choosing a name submits it. 🟥 means a wrong guess, 🟩 means correct, and ⬜ means an unused try.\n\nGet it right and you’ll receive a private link to the original message. Everyone gets the answer and link at midnight Eastern, when the next round starts.\n\n`/guesser stats` — your scores\n`/guesser leaderboard` — top scores');
  if (sub==='stats') {
    const stats = await env.DB.prepare(`SELECT COUNT(*) AS played, COALESCE(SUM(g.correct),0) AS wins FROM guesses g
      JOIN rounds r ON r.id=g.round_id WHERE g.user_id=? AND r.practice=0`).bind(i.member!.user.id).first<{played:number;wins:number}>();
    return reply(`**Your Cathedral Guesser record**\nPlayed: **${stats!.played}** · Correct: **${stats!.wins}** · Incorrect: **${stats!.played-stats!.wins}** · Accuracy: **${stats!.played?Math.round(stats!.wins/stats!.played*100):0}%**`);
  }
  if (sub==='leaderboard') {
    const rows = await env.DB.prepare(`SELECT g.user_id,COUNT(*) AS played,SUM(g.correct) AS wins FROM guesses g
      JOIN rounds r ON r.id=g.round_id WHERE r.practice=0 GROUP BY g.user_id ORDER BY wins DESC,played ASC,g.user_id LIMIT 10`).all<{user_id:string;played:number;wins:number}>();
    return reply('**Cathedral Guesser · Daily standings**\n'+(rows.results.map((r,n)=>`${['🥇','🥈','🥉'][n] || `${n+1}.`} <@${r.user_id}> — **${r.wins}** correct · ${r.played-r.wins} incorrect`).join('\n')||'No daily guesses yet. Be the first!'));
  }
  if (['status','sync','practice','finish-practice'].includes(sub) && !isAdmin(i)) return reply('You need Manage Server permission to use this command.');
  if (sub==='status') {
    const first=await state(env,'source_first_ms');
    const resume=Number(await state(env,'search_resume_at')||0);
    return reply(`**Bot status**\nHistory: ${first?`available since ${new Date(Number(first)).toISOString().slice(0,10)}`:'checked on first puzzle'}\nSearch: ${resume>Date.now()?'waiting for Discord; retries automatically':'ready'}\nLast successful maintenance: ${await state(env,'last_success')||'not yet'}\nDaily reset: **midnight America/New_York**\nGame: <#${env.GAME_CHANNEL_ID}>`);
  }
  if (!isAdmin(i)) return reply('You need Manage Server permission to use this command.');
  if (sub==='sync') {
    await maintenance(env);
    return reply('Maintenance complete. Use `/guesser-admin status` to check progress.');
  }
  if (sub==='finish-practice') {
    const ended=await withLease(env,'maintenance',async()=> {
      const active=await env.DB.prepare("SELECT id FROM rounds WHERE practice=1 AND status='open' ORDER BY created_at DESC,id DESC LIMIT 1").first<{id:string}>();
      if (!active) return false;
      await env.DB.prepare("UPDATE rounds SET status='closed' WHERE id=?").bind(active.id).run();
      await revealOldRounds(env);
      await publishRecaps(env);
      return true;
    });
    return reply(ended?'Practice closed.':'No open practice round found, or maintenance is running.');
  }
  if (sub==='practice') {
    const round = await withLease(env,'maintenance',async()=> {
      const input=i.data?.options?.[0]?.options?.find(o=>o.name==='message')?.value;
      const sourceId=input?.match(/(?:^|\/)(\d{17,20})$/)?.[1];
      if(input && !sourceId)throw new Error('Invalid message ID');
      const r = await createRound(env,`practice-${i.id}`,sourceId);
      if (r) await publishRound(env,r);
      return r;
    });
    return reply(round?'Practice posted.':'No playable message found yet, or Discord needs a short pause. Try again shortly.');
  }
  return reply('Unknown command. Try `/guesser help`.');
}
async function handle(env: Env, i: Interaction) {
  try {
    let body;
    if (i.type===2) body=await command(env,i);
    else {
      const [action,...parts]=(i.data?.custom_id||'').split(':');
      const id=parts[0];
      if (action==='play') body=await showSelector(env,i,id);
      else if (action==='guess') body=await submitGuess(env,i,id,Number(parts[1]||0));
      else if (action==='members') body=await showSelector(env,i,id,Number(parts[1]||0));
      else body=reply('That control is no longer supported. Try `/guesser play`.');
    }
    if(body!==null)await editReply(env,i,body);
    if (i.data?.custom_id?.startsWith('guess:')) {
      try { await publishResults(env,i.data.custom_id.split(':')[1]); }
      catch { console.error('Public result delivery deferred to scheduled retry'); }
      if(body===null)await dismissPrivatePicker(env,i.token);
    }
  } catch (error) {
    console.error('Interaction failed',error instanceof Error ? error.name : 'UnknownError');
    // Do not claim a failed request necessarily means no guess was recorded.
    try { await editReply(env,i,reply('Something went wrong while finishing that request. Your guess may already be saved; use **Guess** to check. Saved guesses cannot be changed.')); }
    catch { console.error('Unable to deliver private error response'); }
  }
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method==='GET' && path==='/health') return Response.json({ok:true,service:'cathedral-guesser'});
    if (request.method!=='POST' || path!=='/interactions') return new Response('Not found',{status:404});
    if (Number(request.headers.get('content-length')||0)>131072) return new Response('Too large',{status:413});
    const body=await request.text();
    if (body.length>131072) return new Response('Too large',{status:413});
    if (!(await verifySignature(request,body,env.DISCORD_PUBLIC_KEY))) return new Response('Invalid signature',{status:401});
    let interaction: Interaction;
    try { interaction=JSON.parse(body); } catch { return new Response('Invalid JSON',{status:400}); }
    if (interaction.type===1) return Response.json({type:1});
    if (interaction.application_id!==env.DISCORD_APPLICATION_ID || interaction.guild_id!==env.GUILD_ID || !interaction.member || interaction.member.user.bot) {
      return Response.json({type:4,data:{...reply('This bot is configured for a different server.'),flags:64}});
    }
    if (![2,3].includes(interaction.type)) return Response.json({type:4,data:{...reply('Unsupported interaction.'),flags:64}});
    ctx.waitUntil(handle(interactionEnv(env,interaction),interaction));
    // Guess controls exist only in ephemeral messages. Update that private message
    // and remove the selector after submission; never edit the shared puzzle here.
    return Response.json(/^(guess|members):/.test(interaction.data?.custom_id||'') ? {type:6} : {type:5,data:{flags:64}});
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(maintenance(env).catch(error=> {
      console.error('Maintenance failed',error instanceof Error ? error.name : 'UnknownError');
      throw error;
    }));
  },
} satisfies ExportedHandler<Env>;
