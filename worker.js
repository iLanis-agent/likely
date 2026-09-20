const MODEL = "~typesafe/jev-latest";
const COST_PER_TOKEN = 0.042 / 1e6; // $0.042/M input tokens, $0 output (jev pricing)
const OR_URL = "https://openrouter.ai/api/alpha/decisions";

const QUESTIONS = {
  likelihood: {type: "noul",
    instructions: "Will the event or claim in the state actually happen, or turn out to be true?",
    true: "It happens / is true", false: "It does not happen / is false"},
  confidence: {type: "score",
    instructions: "How much confidence should a careful forecaster have in this estimate, given how predictable the matter is?",
    criteria: ["Shaky", "Leaning", "Confident", "Very confident"]},
  driver: {type: "choice",
    instructions: "What dominates whether this happens?",
    criteria: {chance: "Mostly random luck", timing: "Timing and schedules", money: "Money and markets",
      people: "Decisions by people", nature: "Weather and nature", policy: "Politics and policy"}},
  influence: {type: "noul",
    instructions: "Can the person asking materially change this outcome through their own actions?",
    true: "Their actions matter", false: "Mostly out of their hands"}
};

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {"Content-Type": "application/json", "Access-Control-Allow-Origin": origin || "same-origin"}
  });
}

async function readBody(request) {
  try { return await request.json(); } catch (e) { return null; }
}

async function authed(body, env) {
  if (!body || typeof body.pass !== "string") return false;
  // constant-time-ish compare against the secret passphrase
  const a = body.pass, b = env.APP_PASSPHRASE || "";
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function handleAsk(request, env) {
  const body = await readBody(request);
  if (!(await authed(body, env))) return json({error: "wrong_pass"}, 401);
  const q = (body.question || "").trim();
  if (q.length < 5) return json({error: "too_short"}, 400);

  const today = new Date().toISOString().slice(0, 10);
  const state = "As of " + today + ", a user asks: \"" + q + "\"";
  const payload = {model: MODEL, state: state, questions: QUESTIONS};

  let resp;
  try {
    resp = await fetch(OR_URL, {
      method: "POST",
      headers: {"Authorization": "Bearer " + env.OPENROUTER_KEY, "Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return json({error: "upstream_unreachable"}, 502);
  }
  if (resp.status === 401 || resp.status === 403) return json({error: "bad_key"}, 502);
  if (resp.status === 402) return json({error: "no_credits"}, 502);
  if (resp.status === 429) return json({error: "rate_limited"}, 502);
  if (!resp.ok) return json({error: "upstream_" + resp.status}, 502);

  let data;
  try { data = await resp.json(); } catch (e) { return json({error: "bad_upstream_json"}, 502); }
  const answers = data.answers || {};
  const lik = answers.likelihood || {};
  if (typeof lik.noul !== "number") return json({error: "no_answer", raw: data}, 502);

  const conf = answers.confidence || {};
  const drv = answers.driver || {};
  const infl = answers.influence || {};
  const usage = data.usage || null;
  const inputTokens = usage && (usage.input_tokens || usage.prompt_tokens) ? (usage.input_tokens || usage.prompt_tokens) : estimateTokens(JSON.stringify(payload));
  const cost = usage && typeof usage.cost === "number" ? usage.cost : inputTokens * COST_PER_TOKEN;
  const estimated = !(usage && typeof usage.cost === "number");

  const row = {
    ts: new Date().toISOString(), question: q,
    prob: Math.round(lik.noul * 1000) / 10,
    confidence: conf.score !== undefined ? conf.score : null,
    driver: drv.choice || null, influence: infl.noul !== undefined ? Math.round(infl.noul * 1000) / 10 : null,
    input_tokens: inputTokens, cost: cost, estimated: estimated ? 1 : 0
  };
  await env.DB.prepare(
    "INSERT INTO asks (ts, question, prob, confidence, driver, influence, input_tokens, cost, estimated, raw) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(row.ts, row.question, row.prob, row.confidence, row.driver, row.influence,
    row.input_tokens, row.cost, row.estimated, JSON.stringify(data)).run();

  return json({ok: true, result: row});
}

async function handleHistory(request, env) {
  const body = await readBody(request);
  if (!(await authed(body, env))) return json({error: "wrong_pass"}, 401);
  const rs = await env.DB.prepare(
    "SELECT id, ts, question, prob, confidence, driver, influence, input_tokens, cost, estimated FROM asks ORDER BY id DESC LIMIT 50"
  ).all();
  return json({ok: true, items: rs.results || []});
}

async function handleCosts(request, env) {
  const body = await readBody(request);
  if (!(await authed(body, env))) return json({error: "wrong_pass"}, 401);
  const total = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(cost) AS cost, SUM(input_tokens) AS tokens FROM asks").first();
  const byDay = await env.DB.prepare(
    "SELECT substr(ts,1,10) AS day, COUNT(*) AS n, SUM(cost) AS cost FROM asks GROUP BY day ORDER BY day DESC LIMIT 14"
  ).all();
  return json({ok: true, total: total || {n: 0, cost: 0, tokens: 0}, byDay: byDay.results || []});
}

const PAGE = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Likely - AI Probability Oracle</title>\n<style>\n  * { margin:0; padding:0; box-sizing:border-box; }\n  body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:#0e0f1e; color:#ecedff; min-height:100vh; padding:22px 14px 60px; }\n  .wrap { max-width:680px; margin:0 auto; }\n  header { text-align:center; margin-bottom:16px; }\n  header h1 { font-size:27px; letter-spacing:-.5px; }\n  header .tag { color:#7d83c0; font-size:12px; }\n  .card { background:#151730; border:1px solid #252852; border-radius:14px; padding:18px; margin-bottom:12px; }\n  .lbl { font-size:11px; text-transform:uppercase; letter-spacing:1.5px; color:#7d83c0; margin-bottom:10px; }\n  input[type=password], textarea { width:100%; background:#0e0f1e; border:1.5px solid #252852; border-radius:10px; color:#ecedff; padding:12px 14px; font-size:15px; font-family:inherit; outline:none; }\n  input:focus, textarea:focus { border-color:#8b7cff; }\n  textarea { resize:vertical; min-height:70px; }\n  .btn { display:inline-block; border:none; background:#8b7cff; color:#0e0f1e; font-weight:700; font-size:15px; border-radius:999px; padding:12px 28px; cursor:pointer; }\n  .btn:disabled { opacity:.5; }\n  .btn.ghost { background:#1d2044; color:#aab0e8; font-weight:600; font-size:12px; padding:8px 16px; }\n  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }\n  .note { color:#7d83c0; font-size:12.5px; line-height:1.5; margin-top:10px; }\n  .hidden { display:none !important; }\n  #gaugeWrap { text-align:center; }\n  #bigP { font-size:46px; font-weight:800; margin-top:-58px; font-variant-numeric:tabular-nums; }\n  #verdict { font-size:14px; color:#aab0e8; margin-top:2px; }\n  .chips { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:14px; }\n  .chip2 { background:#1d2044; border:1px solid #2c3160; border-radius:999px; padding:7px 14px; font-size:12.5px; color:#aab0e8; }\n  .chip2 b { color:#ecedff; }\n  #meta { text-align:center; color:#5b5f96; font-size:11.5px; margin-top:14px; }\n  #err { background:#2b1420; border:1px solid #5c2140; color:#fda4c0; border-radius:10px; padding:12px 14px; font-size:13.5px; line-height:1.5; }\n  .hrow { display:flex; gap:10px; align-items:baseline; padding:9px 6px; border-radius:9px; font-size:13px; cursor:pointer; }\n  .hrow:nth-child(odd) { background:#191c3c; }\n  .hrow:hover { background:#1d2044; }\n  .hrow .p { font-weight:800; min-width:48px; font-variant-numeric:tabular-nums; }\n  .hrow .q { color:#aab0e8; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n  .hrow .c { color:#5b5f96; font-size:11px; font-variant-numeric:tabular-nums; }\n  #emptyHist { color:#4a4e85; font-size:13px; text-align:center; padding:6px; }\n  #spinner { text-align:center; color:#aab0e8; font-size:14px; padding:18px; }\n  .ctotal { text-align:center; margin-bottom:10px; }\n  .ctotal .big { font-size:30px; font-weight:800; font-variant-numeric:tabular-nums; }\n  .ctotal .sm { color:#7d83c0; font-size:12px; }\n  .drow { display:flex; justify-content:space-between; font-size:12.5px; color:#aab0e8; padding:5px 4px; border-radius:7px; font-variant-numeric:tabular-nums; }\n  .drow:nth-child(odd) { background:#191c3c; }\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <header><h1>&#128302; Likely</h1><div class=\"tag\">calibrated probabilities, powered by jev</div></header>\n\n  <div class=\"card\" id=\"gateCard\">\n    <div class=\"lbl\">Private app</div>\n    <p class=\"note\" style=\"margin-top:0;margin-bottom:12px\">Enter the passphrase to use Likely. Your questions and costs are stored on the server, not on this device.</p>\n    <input type=\"password\" id=\"passInput\" placeholder=\"passphrase\" autocomplete=\"off\">\n    <div class=\"row\" style=\"margin-top:12px\"><button class=\"btn\" id=\"unlock\">Unlock</button></div>\n    <div class=\"note\" id=\"gateErr\"></div>\n  </div>\n\n  <div id=\"mainUI\" class=\"hidden\">\n    <div class=\"card\">\n      <div class=\"lbl\">Ask anything</div>\n      <textarea id=\"q\" placeholder=\"Will it rain in Tel Aviv tomorrow? Will the shekel strengthen this month?\"></textarea>\n      <div class=\"row\" style=\"margin-top:12px\"><button class=\"btn\" id=\"ask\">Estimate</button></div>\n      <div class=\"note\">Answers are AI estimates, not guarantees - treat them as an informed starting point.</div>\n    </div>\n\n    <div class=\"card hidden\" id=\"spinnerCard\"><div id=\"spinner\">Thinking through the factors...</div></div>\n    <div class=\"card hidden\" id=\"errCard\"><div id=\"err\"></div></div>\n\n    <div class=\"card hidden\" id=\"resultCard\">\n      <div id=\"gaugeWrap\">\n        <svg width=\"220\" height=\"120\" viewBox=\"0 0 220 120\">\n          <path d=\"M 20 110 A 90 90 0 0 1 200 110\" fill=\"none\" stroke=\"#252852\" stroke-width=\"16\" stroke-linecap=\"round\"/>\n          <path id=\"arc\" d=\"M 20 110 A 90 90 0 0 1 200 110\" fill=\"none\" stroke=\"#8b7cff\" stroke-width=\"16\" stroke-linecap=\"round\" stroke-dasharray=\"283\" stroke-dashoffset=\"283\"/>\n        </svg>\n        <div id=\"bigP\">-%</div>\n        <div id=\"verdict\"></div>\n      </div>\n      <div class=\"chips\" id=\"chips\"></div>\n      <div id=\"meta\"></div>\n    </div>\n\n    <div class=\"card\">\n      <div class=\"lbl\">Cost tracker</div>\n      <div class=\"ctotal\"><div class=\"big\" id=\"costTotal\">$0.00000</div><div class=\"sm\" id=\"costMeta\">0 questions</div></div>\n      <div id=\"byDay\"></div>\n    </div>\n\n    <div class=\"card\">\n      <div class=\"lbl\">Past questions <span style=\"letter-spacing:0;text-transform:none\">(server-stored)</span></div>\n      <div id=\"hist\"><div id=\"emptyHist\">Nothing yet - ask your first question above.</div></div>\n      <div class=\"row\" style=\"margin-top:12px\"><button class=\"btn ghost\" id=\"lock\">Lock app</button></div>\n    </div>\n  </div>\n</div>\n\n<script>\nvar PASS_KEY='likely-pass';\nfunction $(id){return document.getElementById(id);}\nfunction getPass(){ try{return sessionStorage.getItem(PASS_KEY)||'';}catch(_){return '';} }\nfunction setPass(p){ try{sessionStorage.setItem(PASS_KEY,p);}catch(_){}}\nfunction verdictFor(p){\n  if(p<10) return 'Very unlikely';\n  if(p<30) return 'Unlikely';\n  if(p<45) return 'Probably not';\n  if(p<=55) return 'Toss-up';\n  if(p<70) return 'More likely than not';\n  if(p<90) return 'Likely';\n  return 'Very likely';\n}\nfunction fmtCost(c){ return '$'+(c<0.01?c.toFixed(5):c.toFixed(4)); }\nasync function api(path, extra){\n  var body={pass:getPass()}; if(extra) for(var k in extra) body[k]=extra[k];\n  var r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});\n  return {status:r.status, data:await r.json().catch(function(){return {};})};\n}\nfunction showGate(msg){\n  $('gateCard').classList.remove('hidden');\n  $('mainUI').classList.add('hidden');\n  if(msg) $('gateErr').textContent=msg;\n}\nasync function showMain(){\n  $('gateCard').classList.add('hidden');\n  $('mainUI').classList.remove('hidden');\n  loadHistory(); loadCosts();\n}\n$('unlock').onclick=async function(){\n  var p=$('passInput').value;\n  if(!p){ return; }\n  setPass(p); $('passInput').value='';\n  var r=await api('/api/costs');\n  if(r.status===401){ try{sessionStorage.removeItem(PASS_KEY);}catch(_){}\n    showGate('Wrong passphrase.'); return; }\n  showMain();\n};\n$('passInput').addEventListener('keydown',function(e){ if(e.key==='Enter') $('unlock').click(); });\n$('lock').onclick=function(){ try{sessionStorage.removeItem(PASS_KEY);}catch(_){} showGate('Locked.'); };\nfunction fail(msg){\n  $('spinnerCard').classList.add('hidden');\n  $('resultCard').classList.add('hidden');\n  $('err').textContent=msg;\n  $('errCard').classList.remove('hidden');\n}\nfunction renderResult(r){\n  $('errCard').classList.add('hidden');\n  var p=r.prob;\n  $('arc').setAttribute('stroke-dashoffset', String(283*(1-p/100)));\n  $('arc').setAttribute('stroke', p<35?'#fb7185':p<65?'#fbbf24':'#5eead4');\n  $('bigP').textContent=(Math.round(p*10)/10)+'%';\n  $('verdict').textContent=verdictFor(p);\n  var chips='';\n  if(r.confidence!==null&&r.confidence!==undefined){\n    var labels=['Shaky','Leaning','Confident','Very confident'];\n    var cl=(typeof r.confidence==='number')?labels[Math.max(0,Math.min(3,Math.round(r.confidence)))]:String(r.confidence);\n    chips+='<span class=\"chip2\">confidence: <b>'+cl+'</b></span>';\n  }\n  if(r.driver) chips+='<span class=\"chip2\">main driver: <b>'+r.driver+'</b></span>';\n  if(r.influence!==null&&r.influence!==undefined) chips+='<span class=\"chip2\">you can influence it: <b>'+(r.influence>=50?'yes ('+r.influence+'%)':'not much ('+r.influence+'%)')+'</b></span>';\n  $('chips').innerHTML=chips;\n  $('meta').textContent='model: jev-latest \u00b7 '+r.input_tokens+' input tokens \u00b7 '+fmtCost(r.cost)+(r.estimated?' (estimated)':'');\n  $('resultCard').classList.remove('hidden');\n}\n$('ask').onclick=async function(){\n  var q=$('q').value.trim();\n  if(q.length<5){ $('q').focus(); return; }\n  $('errCard').classList.add('hidden');\n  $('resultCard').classList.add('hidden');\n  $('spinnerCard').classList.remove('hidden');\n  $('ask').disabled=true;\n  try{\n    var r=await api('/api/ask',{question:q});\n    if(r.status===401){ showGate('Wrong passphrase - locked.'); return; }\n    if(r.data.error==='bad_key'){ fail('The server API key was rejected. Tell the admin.'); return; }\n    if(r.data.error==='no_credits'){ fail('The OpenRouter account is out of credits.'); return; }\n    if(r.data.error==='rate_limited'){ fail('Rate limited - give it a few seconds and try again.'); return; }\n    if(r.data.error||!r.data.ok){ fail('Something went wrong upstream ('+(r.data.error||r.status)+'). Try again.'); return; }\n    $('spinnerCard').classList.add('hidden');\n    renderResult(r.data.result);\n    loadHistory(); loadCosts();\n  }catch(e){\n    fail('Could not reach the server - check your connection.');\n  }finally{\n    $('ask').disabled=false;\n  }\n};\nasync function loadHistory(){\n  var r=await api('/api/history');\n  if(!r.data.ok) return;\n  var items=r.data.items||[];\n  if(!items.length){ $('hist').innerHTML='<div id=\"emptyHist\">Nothing yet - ask your first question above.</div>'; return; }\n  var s='';\n  items.forEach(function(it,i){\n    s+='<div class=\"hrow\" data-i=\"'+i+'\"><span class=\"p\">'+it.prob+'%</span><span class=\"q\"></span><span class=\"c\">'+fmtCost(it.cost)+'</span></div>';\n  });\n  $('hist').innerHTML=s;\n  document.querySelectorAll('#hist .hrow').forEach(function(row,i){\n    row.querySelector('.q').textContent=items[i].question;\n    row.onclick=function(){ renderResult(items[i]); window.scrollTo({top:0,behavior:'smooth'}); };\n  });\n}\nasync function loadCosts(){\n  var r=await api('/api/costs');\n  if(!r.data.ok) return;\n  var t=r.data.total||{n:0,cost:0,tokens:0};\n  $('costTotal').textContent=fmtCost(t.cost||0);\n  $('costMeta').textContent=t.n+' question'+(t.n===1?'':'s')+' \u00b7 '+(t.tokens||0)+' input tokens';\n  var s='';\n  (r.data.byDay||[]).forEach(function(d){\n    s+='<div class=\"drow\"><span>'+d.day+'</span><span>'+d.n+' asked \u00b7 '+fmtCost(d.cost)+'</span></div>';\n  });\n  $('byDay').innerHTML=s;\n}\nif(getPass()){ showMain(); } else { showGate(); }\n</script>\n</body>\n</html>\n";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(PAGE, {headers: {"Content-Type": "text/html; charset=utf-8"}});
    }
    if (request.method === "POST" && url.pathname === "/api/ask") return handleAsk(request, env);
    if (request.method === "POST" && url.pathname === "/api/history") return handleHistory(request, env);
    if (request.method === "POST" && url.pathname === "/api/costs") return handleCosts(request, env);
    if (request.method === "OPTIONS") return new Response(null, {status: 204});
    return json({error: "not_found"}, 404);
  }
};
