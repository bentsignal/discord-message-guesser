import type { Env, Message, Round, Member, Guess } from './types';
import { discord, DiscordError, noMentions, nonce } from './discord';
import { GUESS_LIMIT, eligibleMessage, gameDay, roundPayload, recapPages, resultPayload, recapPayload } from './game';

import { parseMedia, validateMedia } from './media';
import {finalizeUnfinished} from './attempts';
import {eligibleAuthors} from './eligibility';
import {memberName} from './members';
import { sampleCandidates } from './sampling';

export async function state(env: Env, key: string): Promise<string | null> {
  return env.DB.prepare('SELECT value FROM state WHERE key = ?').bind(key).first<string>('value');
}
export async function setState(env: Env, key: string, value: string) {
  await env.DB.prepare('INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,value).run();
}
export async function withLease<T>(env: Env, key: string, work: () => Promise<T>): Promise<T | undefined> {
  const holder = crypto.randomUUID();
  const acquired = await env.DB.prepare(`INSERT INTO leases(key,holder,expires) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET holder=excluded.holder, expires=excluded.expires WHERE leases.expires < ? RETURNING holder`)
    .bind(key, holder, Date.now()+120_000, Date.now()).first();
  if (!acquired) return;
  try { return await work(); }
  finally { await env.DB.prepare('DELETE FROM leases WHERE key=? AND holder=?').bind(key,holder).run(); }
}

export async function currentMember(env: Env, userId: string): Promise<Member | null> {
  try {
    const member = await discord<Member>(env,`/guilds/${env.GUILD_ID}/members/${userId}`);
    return member.user.bot ? null : member;
  } catch (error) {
    if (error instanceof DiscordError && error.status===404) return null;
    throw error;
  }
}

export async function createRound(env: Env, id?: string, sourceId?: string): Promise<Round | null> {
  const day = gameDay(new Date(),env.TIME_ZONE);
  const roundId = id || day;
  const existing = await env.DB.prepare('SELECT * FROM rounds WHERE id=?').bind(roundId).first<Round>();
  if (existing) return existing;
  const pool=await eligibleAuthors(env);
  if(!pool.ready || !pool.members.length)return null;
  const authors=pool.members.map(m=>m.user.id);
  const candidates=sourceId && id
    ? [await discord<Message>(env,`/channels/${env.SOURCE_CHANNEL_ID}/messages/${sourceId}`)]
    : await sampleCandidates(env);
  let checked=0;
  for (const candidate of candidates) {
    if(!eligibleMessage(candidate) || !authors.includes(candidate.author.id))continue;
    if(!id && await env.DB.prepare('SELECT id FROM rounds WHERE source_id=? AND practice=0 AND day>=? LIMIT 1').bind(candidate.id,new Date(Date.now()-365*86400000).toISOString().slice(0,10)).first())continue;
    if(++checked>3)break;
    if (!(await currentMember(env,candidate.author.id))) continue;
    let live: Message;
    try { live = await discord<Message>(env,`/channels/${env.SOURCE_CHANNEL_ID}/messages/${candidate.id}`); }
    catch (error) {
      if (error instanceof DiscordError && error.status===404) continue;
      throw error;
    }
    if (!eligibleMessage(live)) continue;
    const media=await validateMedia(live);
    if(!media || roundPayload({id:roundId,day,practice:id?1:0,source_id:live.id,author_id:live.author.id,content:live.content,media_json:JSON.stringify(media),status:'pending',discord_id:null,revealed:0}).content.length>2000) {
      if(sourceId)return null;
      continue;
    }
    const before=await discord<Message[]>(env,`/channels/${env.SOURCE_CHANNEL_ID}/messages?before=${live.id}&limit=1`);
    const after=await discord<Message[]>(env,`/channels/${env.SOURCE_CHANNEL_ID}/messages?after=${live.id}&limit=1`);
    const contextText=(m?:Message)=>{
      if(!m)return undefined;
      const text=(m.content||'').replace(/https?:\/\/[^\s<>]+/g,'[link]');
      return [text.slice(0,260)+(text.length>260?'…':''),m.attachments?.length?'[Attachment]':''].filter(Boolean).join(' ');
    };
    const contextEntry=async(m?:Message)=>{
      const text=contextText(m);if(!m||!text)return undefined;
      if(m.author.id===live.author.id)return {text,name:'???',timestamp:m.timestamp};
      const member=pool.members.find(person=>person.user.id===m.author.id)||await currentMember(env,m.author.id);
      return {text,name:(member?memberName(member):m.author.global_name||m.author.username).slice(0,80),timestamp:m.timestamp};
    };
    const context=JSON.stringify({before:await contextEntry(before[0]),after:await contextEntry(after[0])});
    // Reserve room for context without disqualifying a long target message.
    const preview={id:roundId,day,practice:id?1:0,source_id:live.id,author_id:live.author.id,content:live.content,media_json:JSON.stringify(media),context_json:context,guess_limit:GUESS_LIMIT,status:'pending',discord_id:null,revealed:0};
    const safeContext=roundPayload(preview).content.length<=2000?context:'{}';
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO rounds(id,day,practice,source_id,author_id,content,media_json,context_json,guess_limit,eligible_authors_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(roundId,day,id?1:0,live.id,live.author.id,live.content,JSON.stringify(media),safeContext,GUESS_LIMIT,JSON.stringify(authors)),
    ]);
    return env.DB.prepare('SELECT * FROM rounds WHERE id=?').bind(roundId).first<Round>();
  }
  return null;
}

async function existingPost(env: Env, marker: string): Promise<string | undefined> {
  const recent = await discord<Message[]>(env,`/channels/${env.GAME_CHANNEL_ID}/messages?limit=100`);
  return recent.find(m => m.author.id===env.DISCORD_APPLICATION_ID && (m.embeds?.some(e => e.footer?.text.startsWith(marker) || e.url?.endsWith(`#${encodeURIComponent(marker)}`)) || m.components?.some(row=>row.components?.some(c=>c.custom_id===marker))))?.id;
}
export async function publishRound(env: Env, round: Round) {
  if (round.discord_id) return;
  const found = await existingPost(env,`play:${round.id}`);
  const message = found ? {id:found} : await discord<{id:string}>(env,`/channels/${env.GAME_CHANNEL_ID}/messages`,'POST', {
    ...roundPayload(round), nonce:await nonce(`round:${round.id}`), enforce_nonce:true,
  });
  await env.DB.prepare("UPDATE rounds SET discord_id=?, status='open' WHERE id=? AND status='pending'").bind(message.id,round.id).run();
}
export async function revealOldRounds(env: Env) {
  const day = gameDay(new Date(),env.TIME_ZONE);
  await env.DB.prepare("UPDATE rounds SET status='closed' WHERE day < ? AND status!='closed'").bind(day).run();
  const old = await env.DB.prepare("SELECT * FROM rounds WHERE status='closed' AND revealed=0 LIMIT 1").all<Round>();
  for (const round of old.results) {
    await finalizeUnfinished(env,round.id);
    if (round.discord_id) {
      const counts = await env.DB.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(correct),0) AS correct FROM guesses WHERE round_id=?').bind(round.id).first<{total:number;correct:number}>();
      try {
        const payload=roundPayload(round,true,counts!.total,counts!.correct,env.GUILD_ID,env.SOURCE_CHANNEL_ID);
        // Keep Discord's existing media/previews when revealing the author.
        const {embeds: _embeds,...reveal}=payload;
        await discord(env,`/channels/${env.GAME_CHANNEL_ID}/messages/${round.discord_id}`,'PATCH',reveal);
      } catch (error) { if (!(error instanceof DiscordError && error.status===404)) throw error; }
    }
    {
      const players=await env.DB.prepare('SELECT user_id,correct,attempts_used FROM guesses WHERE round_id=? ORDER BY correct DESC,attempts_used,created_at,user_id').bind(round.id).all<{user_id:string;correct:number;attempts_used:number}>();
      const pages=recapPages(round.practice ? `${round.day} · Practice` : round.day,players.results,round.guess_limit||1).map((content,page)=>({content,page}));
      await env.DB.prepare(`INSERT OR IGNORE INTO recaps(round_id,page,content)
        SELECT ?,json_extract(value,'$.page'),json_extract(value,'$.content') FROM json_each(?)`).bind(round.id,JSON.stringify(pages)).run();
    }
    await env.DB.prepare('UPDATE rounds SET revealed=1 WHERE id=?').bind(round.id).run();
  }
}
export async function publishResults(env: Env,roundId?:string) {
  const pending = roundId?await env.DB.prepare('SELECT * FROM guesses WHERE published_id IS NULL AND round_id=? LIMIT 2').bind(roundId).all<Guess>():await env.DB.prepare('SELECT * FROM guesses WHERE published_id IS NULL LIMIT 2').all<Guess>();
  for (const guess of pending.results) {
    await withLease(env,`result:${guess.interaction_id}`,async () => {
      const latest = await env.DB.prepare('SELECT published_id FROM guesses WHERE interaction_id=?').bind(guess.interaction_id).first<Guess>();
      if (latest?.published_id) return;
      const marker = `Result ${guess.interaction_id}`;
      const found = await existingPost(env,marker);
      const round=await env.DB.prepare('SELECT * FROM rounds WHERE id=?').bind(guess.round_id).first<Round>();
      if(!round)return;
      const payload=resultPayload(guess,round);
      const message = found ? {id:found} : await discord<{id:string}>(env,`/channels/${env.GAME_CHANNEL_ID}/messages`,'POST',{
        ...payload,embeds:payload.embeds.map(e=>({...e,url:`https://discord.com/channels/${env.GUILD_ID}/${env.GAME_CHANNEL_ID}/${round.discord_id}#${encodeURIComponent(marker)}`})),
        nonce:await nonce(marker),enforce_nonce:true,
      });
      await env.DB.prepare('UPDATE guesses SET published_id=? WHERE interaction_id=?').bind(message.id,guess.interaction_id).run();
    });
  }
}
export async function maintenance(env: Env) {
  await withLease(env,'maintenance',async () => {
    await revealOldRounds(env);
    await publishResults(env);
    await publishRecaps(env);
    const round = await createRound(env);
    if (round) await publishRound(env,round);
    await refreshPreview(env);
    await setState(env,'last_success',new Date().toISOString());
  });
}

export async function publishRecaps(env: Env) {
  const pending=await env.DB.prepare('SELECT * FROM recaps WHERE published_id IS NULL ORDER BY round_id,page LIMIT 1').all<{round_id:string;page:number;content:string}>();
  for(const recap of pending.results) {
    const marker=`Recap ${recap.round_id} / ${recap.page+1}`;
    const found=await existingPost(env,marker);
    const round=await env.DB.prepare('SELECT * FROM rounds WHERE id=?').bind(recap.round_id).first<Round>();
    if(!round)continue;
    const payload=recapPayload(round,recap.content,recap.page,env.GUILD_ID,env.SOURCE_CHANNEL_ID);
    const message=found?{id:found}:await discord<{id:string}>(env,`/channels/${env.GAME_CHANNEL_ID}/messages`,'POST',{
      ...payload,embeds:payload.embeds.map(e=>({...e,url:`https://discord.com/channels/${env.GUILD_ID}/${env.GAME_CHANNEL_ID}/${round.discord_id}#${encodeURIComponent(marker)}`})),
      nonce:await nonce(marker),enforce_nonce:true,
    });
    await env.DB.prepare('UPDATE recaps SET published_id=? WHERE round_id=? AND page=?').bind(message.id,recap.round_id,recap.page).run();
  }
}

// Native previews can take a moment. Use verified metadata only if Discord did
// not unfurl the link itself; never overwrite a native YouTube/video player.
export async function refreshPreview(env: Env) {
  const round=await env.DB.prepare("SELECT * FROM rounds WHERE status='open' AND discord_id IS NOT NULL AND created_at < datetime('now','-1 minute') AND json_array_length(media_json,'$.previews')>0 ORDER BY created_at DESC LIMIT 1").first<Round>();
  if(!round)return;
  const message=await discord<Message>(env,`/channels/${env.GAME_CHANNEL_ID}/messages/${round.discord_id}`);
  const media=parseMedia(round.media_json);
  if(message.embeds?.some(e=>e.url||e.title||e.description))return;
  const images=(media.attachments||[]).filter(a=>a.content_type?.startsWith('image/')).map(a=>({image:{url:a.url}}));
  await discord(env,`/channels/${env.GAME_CHANNEL_ID}/messages/${round.discord_id}`,'PATCH',{embeds:[...images,...(media.previews||[])],allowed_mentions:noMentions});
}
