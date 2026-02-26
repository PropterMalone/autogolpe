/** Static FAQ page served at /faq */

export const FAQ_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autogulp — How to Play Coup on Bluesky</title>
<style>
  :root { --bg: #0d1117; --fg: #e6edf3; --accent: #e5a832; --dim: #8b949e; --card: #161b22; --border: #30363d; --red: #f85149; --teal: #39d2c0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; padding: 2rem 1rem; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
  h1 span { color: var(--dim); font-weight: normal; font-size: 1rem; }
  h2 { color: var(--accent); font-size: 1.2rem; margin: 2rem 0 0.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.3rem; }
  p, li { color: var(--fg); margin-bottom: 0.5rem; }
  ul { padding-left: 1.5rem; }
  code { background: var(--card); padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9em; color: var(--accent); }
  .role { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin: 0.75rem 0; }
  .role strong { color: var(--accent); }
  .role .action { color: var(--teal); font-weight: 600; }
  .role .block { color: var(--red); font-weight: 600; }
  a { color: var(--accent); }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--dim); font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--border); }
  th { color: var(--accent); font-size: 0.85rem; text-transform: uppercase; }
</style>
</head>
<body>

<h1>🥤 Autogulp <span>Coup on Bluesky</span></h1>

<p>Autogulp runs games of <a href="https://en.wikipedia.org/wiki/Coup_(card_game)">Coup</a> — the bluffing card game of political intrigue — entirely through Bluesky posts and DMs.</p>

<h2>Quick Start</h2>
<ul>
  <li>Mention <code>@autogulp.bsky.social queue</code> or DM the bot <code>queue</code> to join</li>
  <li>When 3 players are queued, the game starts automatically</li>
  <li>Check your DMs for your two secret role cards</li>
  <li>On your turn, mention the bot with an action (e.g. <code>income</code>, <code>tax</code>, <code>coup @player</code>)</li>
  <li>Last player standing wins!</li>
</ul>

<h2>How Coup Works</h2>
<p>Each player starts with <strong>2 coins</strong> and <strong>2 secret influence cards</strong>. On your turn, choose an action. Some actions claim a role — anyone can <strong>challenge</strong> you. If you're caught bluffing, you lose a card. If the challenger is wrong, <em>they</em> lose a card. Lose both cards and you're out.</p>

<h2>Actions</h2>
<table>
  <tr><th>Action</th><th>Effect</th><th>Claims Role</th><th>Blockable By</th></tr>
  <tr><td><code>income</code></td><td>+1 coin</td><td>—</td><td>—</td></tr>
  <tr><td><code>foreign aid</code></td><td>+2 coins</td><td>—</td><td>Duke</td></tr>
  <tr><td><code>tax</code></td><td>+3 coins</td><td>Duke</td><td>—</td></tr>
  <tr><td><code>steal @player</code></td><td>Take 2 coins from target</td><td>Captain</td><td>Captain, Ambassador</td></tr>
  <tr><td><code>assassinate @player</code></td><td>Pay 3 coins, target loses a card</td><td>Assassin</td><td>Contessa</td></tr>
  <tr><td><code>exchange</code></td><td>Draw 2, keep 2 (via DM)</td><td>Ambassador</td><td>—</td></tr>
  <tr><td><code>coup @player</code></td><td>Pay 7 coins, target loses a card</td><td>—</td><td>—</td></tr>
</table>
<p><strong>Mandatory coup:</strong> If you have 10+ coins, you <em>must</em> coup.</p>

<h2>Roles</h2>

<div class="role">
  <strong>Duke</strong>
  <p><span class="action">Action:</span> Tax — take 3 coins from the treasury.</p>
  <p><span class="block">Blocks:</span> Foreign aid.</p>
</div>

<div class="role">
  <strong>Assassin</strong>
  <p><span class="action">Action:</span> Assassinate — pay 3 coins, force a player to lose influence.</p>
</div>

<div class="role">
  <strong>Captain</strong>
  <p><span class="action">Action:</span> Steal — take 2 coins from another player.</p>
  <p><span class="block">Blocks:</span> Stealing.</p>
</div>

<div class="role">
  <strong>Ambassador</strong>
  <p><span class="action">Action:</span> Exchange — draw 2 cards from the deck, choose 2 to keep (via DM).</p>
  <p><span class="block">Blocks:</span> Stealing.</p>
</div>

<div class="role">
  <strong>Contessa</strong>
  <p><span class="block">Blocks:</span> Assassination.</p>
</div>

<h2>Responses</h2>
<p>After someone takes an action, other players can respond:</p>
<ul>
  <li><code>challenge</code> — Call their bluff. If they don't have the role they claimed, they lose a card. If they do, <em>you</em> lose a card (and they swap their revealed card for a new one).</li>
  <li><code>block [role]</code> — Claim a role to block the action (e.g. <code>block duke</code> to block foreign aid). This can also be challenged!</li>
  <li><code>pass</code> — Allow the action to proceed.</li>
</ul>
<p>If no one responds within the time window, the action proceeds automatically.</p>

<h2>Commands</h2>
<p>All public commands are mentions of <code>@autogulp.bsky.social</code>:</p>
<ul>
  <li><code>queue</code> or <code>lfg</code> — Join the matchmaking queue</li>
  <li><code>unqueue</code> — Leave the queue</li>
  <li><code>queue?</code> — Check queue status</li>
  <li><code>income</code> / <code>foreign aid</code> / <code>tax</code> / <code>exchange</code> — Untargeted actions</li>
  <li><code>steal @player</code> / <code>assassinate @player</code> / <code>coup @player</code> — Targeted actions</li>
  <li><code>challenge</code> — Challenge the current action or block</li>
  <li><code>block [role]</code> — Block an action (role optional for obvious blocks)</li>
  <li><code>pass</code> — Allow an action to proceed</li>
  <li><code>status</code> — See game state</li>
  <li><code>help</code> — Quick command reference</li>
</ul>

<h2>DM Commands</h2>
<p>DM <code>@autogulp.bsky.social</code> for private actions and queue management:</p>
<ul>
  <li><code>queue</code> or <code>lfg</code> — Join the matchmaking queue (same as public mention)</li>
  <li><code>unqueue</code> — Leave the queue</li>
  <li><code>queue?</code> — Check queue status</li>
  <li><code>hand</code> — View your current cards</li>
  <li><code>reveal 1</code> or <code>reveal 2</code> — Choose which card to lose (by position)</li>
  <li><code>reveal duke</code> — Choose which card to lose (by role name)</li>
  <li><code>keep duke captain</code> — Choose cards to keep after an exchange</li>
</ul>

<h2>DM Setup</h2>
<p>The bot sends your cards and private prompts via DM. For this to work, <strong>follow @autogulp.bsky.social</strong> so it can message you. If your DMs are restricted, the bot won't be able to reach you.</p>

<h2>Tips</h2>
<ul>
  <li>You can claim <em>any</em> role regardless of your actual cards. Bluffing is the heart of Coup.</li>
  <li>Don't challenge unless you're willing to risk a card. A failed challenge hurts.</li>
  <li>Blocking is itself a claim — it can be challenged too.</li>
  <li>Keep track of which roles have been revealed. If both Dukes are face-up, anyone claiming Duke is definitely bluffing.</li>
  <li>With 10+ coins you must coup — so don't let opponents stockpile unchecked.</li>
  <li>Games time out after 30 minutes of inactivity.</li>
</ul>

<footer>
  <p>Autogulp is open source: <a href="https://github.com/PropterMalone/autogolpe">github.com/PropterMalone/autogolpe</a></p>
  <p>Run by <a href="https://bsky.app/profile/proptermalone.bsky.social">@proptermalone.bsky.social</a></p>
</footer>

</body>
</html>`;
