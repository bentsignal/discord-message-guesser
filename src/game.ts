import type { Message, Round, Guess } from './types';
import { links, parseMedia, supportedAttachments } from './media';
export function gameDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function isCommand(content:string):boolean {
  return /^(?:\/|[!?.$;~][a-z][\w-]*(?:\s|$)|<@!?\d+>\s*[a-z])/i.test(content.trim());
}
export function eligibleMessage(message: Message): boolean {
  return !isCommand(message.content) && !message.author.bot && !message.webhook_id && [0, 19].includes(message.type)
    && (message.content.trim().length > 0 || supportedAttachments(message).length > 0)
    && message.content.length <= 3500 && displayQuote(message.content).length <= 3500;
}
export function displayQuote(content: string): string {
  const text=content.replace(/<@!?\d+>/g, '@someone').replace(/<@&\d+>/g, '@role').replace(/<#\d+>/g, '#channel')
    .replace(/<(https?:\/\/[^>]+)>/g,'$1');
  return text.split(/(https?:\/\/[^\s<>]+)/g).map(part=>/^https?:\/\//.test(part)?part:part.replace(/([\\`*_~|>\[\]])/g,'\\$1')).join('');
}
export function roundTitle(round: Pick<Round,'day'|'practice'>): string {
  return `Cathedral Guesser · ${round.day}${round.practice?' · Practice':''}`;
}
export function originalMessageUrl(round:Round,guild:string,source:string):string {
  return `https://discord.com/channels/${guild}/${source}/${round.source_id}`;
}
function stamp(value?:string):string {
  const ms=value?Date.parse(value):NaN;
  return Number.isFinite(ms)?`<t:${Math.floor(ms/1000)}:f>`:'';
}
function sourceStamp(id:string):string {
  return /^\d{17,20}$/.test(id)?stamp(new Date(Number((BigInt(id)>>22n)+1420070400000n)).toISOString()):'';
}
export function roundPayload(round: Round, revealed = false, _total = 0, _correct = 0, guildId = '', sourceChannel = '') {
  const media=parseMedia(round.media_json);
  const quote=displayQuote(round.content);
  const videoLinks=(media.attachments||[]).filter(a=>a.content_type?.startsWith('video/')).map(a=>a.url);
  const images=(media.attachments||[]).filter(a=>a.content_type?.startsWith('image/')).map(a=>({image:{url:a.url}}));
  const long=quote.length>900;
  const header=`**${round.day}**${round.practice?' · Practice':''}`;
  type ContextEntry=string|{text:string;name:string;timestamp?:string;urls?:string[];media?:{attachments?:unknown[]}};
  let context:{before?:ContextEntry;after?:ContextEntry}={};try{context=JSON.parse(round.context_json||'{}');}catch{}
  const contextLine=(entry?:ContextEntry,maxText=Infinity)=>{
    if(!entry)return '';
    const text=typeof entry==='string'?entry:[entry.text,entry.urls?.length?'[link]':'',entry.media?.attachments?.length?'[Attachment]':''].filter(Boolean).join(' ');
    const name=typeof entry==='string'?'':entry.name;
    const time=typeof entry==='string'?'':stamp(entry.timestamp);
    const heading=name?[`${name==='???'?'👤':'🧑'} ${displayQuote(name).slice(0,60)}`,time].filter(Boolean).join(' · '):'';
    return [heading,displayQuote(text).slice(0,maxText)].filter(Boolean).join('\n').split('\n').map(line=>`> ${line}`).join('\n');
  };
  const attachment=(media.attachments||[]).length>0;
  const targetTime=sourceStamp(round.source_id);
  const targetBlock=`👤 **???**${targetTime?` · ${targetTime}`:''}\n**${quote}${quote&&attachment?'\n':''}${attachment?'See attachment below.':''}**`;
  const target=long?'':targetBlock;
  const content=[header,long?'':contextLine(context.before),target,long?'':contextLine(context.after),...videoLinks,long?links(round.content).join('\n'):'',
    revealed?`**Sent by** <@${round.author_id}> · [Original message](https://discord.com/channels/${guildId}/${sourceChannel}/${round.source_id})`:'**Who sent the bolded message?**'].filter(Boolean).join('\n\n');
  return {
    content,
    allowed_mentions: { parse: [] },
    embeds:[...(long?[{description:[contextLine(context.before,100),targetBlock,contextLine(context.after,100)].filter(Boolean).join('\n\n')}]:[]),...images],
    components: revealed ? [] : [{ type: 1, components: [{type: 2, style: 1, label: 'Guess', custom_id: `play:${round.id}`}]}],
  };
}
export const GUESS_LIMIT=5;
export function resultSquares(correct:number,used=1,limit=GUESS_LIMIT):string {
  return '🟥'.repeat(Math.max(0,used-(correct?1:0)))+(correct?'🟩':'')+'⬜'.repeat(Math.max(0,limit-used));
}
export function resultPayload(guess: Guess, round: Round) {
  const used=guess.attempts_used||1,limit=round.guess_limit||1;
  const outcome=guess.correct?`got it right in ${used} ${used===1?'guess':'guesses'}.`:`didn’t get it in ${used} ${used===1?'guess':'guesses'}.`;
  return {allowed_mentions:{parse:[]},embeds:[{description:`<@${guess.user_id}> ${outcome}${limit>1?`\n\n${resultSquares(guess.correct,used,limit)}`:''}`,footer:{text:roundTitle(round)},color:guess.correct?0x57b382:0xca7a76}]};
}
export function recapPages(_day: string, players: {user_id:string;correct:number;attempts_used?:number}[],limit=1): string[] {
  const correct=players.filter(p=>p.correct===1),wrong=players.filter(p=>p.correct!==1);
  const pages:string[]=[];let page='';
  for(const [label,group] of [['Correct',correct],['Incorrect',wrong]] as const) {
    const heading=`**${label} (${group.length})**`;
    if(page.length+heading.length+30>3500){pages.push(page);page='';}
    page+=(page?'\n\n':'')+heading;
    for(const player of group) {
      const line=`\n<@${player.user_id}>${limit>1?` · ${resultSquares(player.correct,player.attempts_used||1,limit)}`:''}`;
      if(page.length+line.length>3500){pages.push(page);page=heading;}
      page+=line;
    }
  }
  if(page)pages.push(page);return pages;
}
export function recapPayload(round: Round, content: string, page: number,guild='',source='') {
  return {allowed_mentions:{parse:[]},embeds:[{title:`${roundTitle(round)} · Recap${page?' (continued)':''}`,color:0xbda477,description:content,...(guild&&source?{url:originalMessageUrl(round,guild,source)}:{})}],...(guild&&source?{components:[{type:1,components:[{type:2,style:5,label:'Original message',url:originalMessageUrl(round,guild,source)}]}]}:{})};
}
