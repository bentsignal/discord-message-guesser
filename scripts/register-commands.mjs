// Run with: node --env-file=.dev.vars scripts/register-commands.mjs
const {DISCORD_TOKEN, DISCORD_APPLICATION_ID, GUILD_ID}=process.env;
if (!DISCORD_TOKEN||!DISCORD_APPLICATION_ID||!GUILD_ID) throw new Error('Set DISCORD_TOKEN, DISCORD_APPLICATION_ID, and GUILD_ID');
const descriptions={play:'Guess who sent today’s message',help:'Learn how Cathedral Guesser works',stats:'See your daily guessing record',leaderboard:'See the server’s daily standings',status:'Check history search and bot health',sync:'Admin: retry today’s puzzle and pending results',practice:'Admin: post a separate practice puzzle','finish-practice':'Admin: close the latest practice puzzle and show its recap'};
const commands=[
    {name:'guesser',description:'Five guesses. Who sent it?',type:1,
      options:['play','help','stats','leaderboard'].map(name=>({type:1,name,description:descriptions[name]}))},
    {name:'guesser-admin',description:'Manage Cathedral Guesser',type:1,default_member_permissions:'32',
      options:['status','sync','practice','finish-practice'].map(name=>({type:1,name,description:descriptions[name],...(name==='practice'?{options:[{type:3,name:'message',description:'Source message ID or message link to test (optional)',required:false}]}:{})}))},
  ];
// Upsert each command individually; never bulk-replace/delete server commands.
for(const command of commands){
  const response=await fetch(`https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${GUILD_ID}/commands`,{
    method:'POST',headers:{Authorization:`Bot ${DISCORD_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Command registration failed (${response.status})`);
}
console.log('Registered commands in the configured server without deleting existing commands.');
