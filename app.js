/* NYC misdemeanors & violations map. Vanilla JS + Leaflet + hand-rolled SVG charts. */
'use strict';

const HOT='#c8341f', COOL='#1f5f7a';
const GCOL = { proactive:HOT, victim:COOL, other:'#9a8f73' };
const GNAME = { proactive:'Enforcement-sensitive', victim:'Complaint-driven', other:'Other / mixed' };
const GROUP_DEF = {
  proactive:"<strong>Enforcement-sensitive</strong><br>Discretionary, officer-initiated offenses. An officer largely decides whether these become a record, so the counts rise and fall with proactive policing.<br><span style='opacity:.65'>e.g. drugs, criminal trespass, fare evasion, prostitution, disorderly conduct, weapon possession, DWI, traffic-law offenses.</span>",
  victim:"<strong>Complaint-driven</strong><br>Offenses usually reported by a victim or witness rather than initiated by an officer, so the counts mostly track what people experience and report.<br><span style='opacity:.65'>e.g. petit larceny, assault 3, harassment, criminal mischief, sex crimes, fraud, stolen property.</span>",
  other:"<strong>Other / mixed</strong><br>Administrative or ambiguous categories, plus offenses that arise from police contact itself (resisting, obstruction) and broad public-order codes.<br><span style='opacity:.65'>e.g. offenses against public administration, public order/sensibility, administrative code.</span>",
};
const BORO_COL = { 'Manhattan':'#c8341f','Brooklyn':'#243f6b','Queens':'#b08328','Bronx':'#1f7a6b','Staten Island':'#6e4a86' };
const BOROS = ['Manhattan','Brooklyn','Queens','Bronx','Staten Island'];
// luminous ember ramp for counts on the dark map
const RAMP = ['#33240f','#6e3411','#a8481a','#d2691e','#e89a3c','#f4c46a','#fae6b0'];
// diverging cool -> bone -> hot (enforcement-sensitive share: low=complaint areas, high=enforcement-heavy)
const RAMP_SHARE = ['#1f5f7a','#5f93a3','#a9b8a8','#d8c79a','#d27a3c','#c8341f'];
// diverging hot -> bone -> cool (complaint:arrest ratio: low=arrest-heavy, high=complaint-heavy)
const RAMP_RATIO = ['#c8341f','#d27a3c','#dac79a','#a9b8a8','#5f93a3','#1f5f7a'];
// cool luminous ramp for per-capita rates on the dark map (distinct from the warm count ramp)
const RAMP_RATE = ['#0e2a2f','#124a4a','#166b6b','#2a9d8f','#57c4b0','#9fe0d0','#e3f6ef'];
const NODATA='#241f17';

const EVENTS = [
  { year:2018, label:'NYPD ends most marijuana-possession arrests' },
  { year:2020, label:'COVID-19 pandemic; bail reform takes effect' },
  { year:2021, label:'New York legalizes cannabis (MRTA)' },
  { year:2022, label:'Mayor Adams takes office' },
];

const fmt = n => n.toLocaleString('en-US');
const pct1 = n => (n*100).toFixed(1) + '%';

const state = {
  lens: 'complaints',
  law: 'all',          // 'all' | 0 (misd) | 1 (viol)
  metric: 'count',     // 'count' | 'share'
  year: 2025,
  offsel: new Set(),   // selected offense ids
  precinct: null,
  zero: { group:true, compare:true, boro:true, trend:true },
  showEvents: true,
  trendOffense: 'all', // 'all' | 'g:<group>' | 'o:<oid>'
  trendCity: true,
  trendPlaces: [],     // up to 3 precinct numbers
  offSort: 'count',    // 'count' | 'name'
  collapsed: { proactive:false, victim:false, other:false },
  rankSort: 'count',   // 'count' | 'pct' | 'boro'
};

let DATA, geo, map, geoLayer, tip;
const byPctLayer = {};

fetch('data/data.json').then(r=>r.json()).then(d=>{
  DATA = d;
  return fetch('data/precincts.json').then(r=>r.json());
}).then(g=>{ geo = g; init(); }).catch(e=>{
  document.getElementById('map').innerHTML = '<p style="padding:20px">Could not load data: '+e+'</p>';
});

/* ---------- helpers over the row arrays [yr,pct,oid,lawcatIdx,n] ---------- */
const G = oid => DATA.offenses[oid].group;
function rows(){ return DATA[state.lens]; }
function passLaw(r){ return state.law==='all' || r[3]===state.law; }
function passSel(r){ return state.offsel.has(r[2]); }

/* ---------- population + neighborhood ---------- */
let RATE_EXCLUDE = new Set(), DAYTIME_FLAG = new Set(), DEFAULT_YEAR = null;
// residential population for a precinct in a year (varies by year); null if none
function popOf(pct, year){
  const arr = DATA.populations && DATA.populations[pct];
  if(!arr) return null;
  const i = DATA.years.indexOf(year); if(i<0) return null;
  const v = arr[i]; return (v==null) ? null : v;
}
function nbhOf(pct){ return (DATA.neighborhoods && DATA.neighborhoods[pct]) || ''; }
// "#75 · East New York" style label
function pctLabel(pct){ const n=nbhOf(pct); return n ? ('#'+pct+' · '+n) : ('#'+pct); }
// per-precinct incidents-per-1,000-residents for current selection in a year
function perPrecinctRate(year){
  const cnt = perPrecinct(year);
  const rate={}, pop={};
  for(const p in cnt){
    const pn=+p;
    if(RATE_EXCLUDE.has(pn)) continue;      // no meaningful residential denominator
    const pv = popOf(''+pn, year);
    if(!pv) continue;
    pop[p]=pv; rate[p]= cnt[p]/pv*1000;
  }
  let max=0; for(const p in rate) max=Math.max(max, rate[p]);
  return {rate, count:cnt, pop, max};
}

// total for current selection (lens+law+offense set) in a given year, optional pct
function totalFor(year, pct){
  let s=0; for(const r of rows()){
    if(r[0]!==year) continue; if(pct!=null && r[1]!==pct) continue;
    if(!passLaw(r) || !passSel(r)) continue; s+=r[4];
  } return s;
}
// per-precinct count for selection in year
function perPrecinct(year){
  const m={}; for(const r of rows()){
    if(r[0]!==year || !passLaw(r) || !passSel(r)) continue;
    m[r[1]]=(m[r[1]]||0)+r[4];
  } return m;
}
// per-precinct enforcement-sensitive share in year (ignores offense selection; respects lens+law)
function perPrecinctShare(year){
  const pro={}, tot={};
  for(const r of rows()){
    if(r[0]!==year || !passLaw(r)) continue;
    tot[r[1]]=(tot[r[1]]||0)+r[4];
    if(G(r[2])==='proactive') pro[r[1]]=(pro[r[1]]||0)+r[4];
  }
  const m={}; for(const p in tot){ m[p]= tot[p] ? (pro[p]||0)/tot[p] : 0; }
  return {share:m, tot};
}
// per-precinct complaint:arrest ratio in year (uses BOTH lenses; respects law + offense selection)
function perPrecinctRatio(year){
  const comp={}, arr={};
  for(const r of DATA.complaints){ if(r[0]!==year||!passLaw(r)||!passSel(r)) continue; comp[r[1]]=(comp[r[1]]||0)+r[4]; }
  for(const r of DATA.arrests){ if(r[0]!==year||!passLaw(r)||!passSel(r)) continue; arr[r[1]]=(arr[r[1]]||0)+r[4]; }
  const ratio={}, raw={};
  const pcts=new Set([...Object.keys(comp),...Object.keys(arr)]);
  pcts.forEach(p=>{ const c=comp[p]||0, a=arr[p]||0;
    raw[p]={c,a};
    if(c===0 && a===0) return;            // no data
    ratio[p] = a===0 ? 99 : (c/a);        // arrests=0 -> very complaint-heavy
  });
  return {ratio, raw, comp, arr};
}
// citywide series by group, per lens
function groupSeries(lens){
  const out={proactive:{},victim:{},other:{}};
  for(const r of DATA[lens]){ if(!passLaw(r)) continue;
    out[G(r[2])][r[0]]=(out[G(r[2])][r[0]]||0)+r[4]; }
  return out;
}
// citywide series for current offense selection, per lens
function selSeries(lens){
  const o={}; for(const r of DATA[lens]){ if(!passLaw(r)||!state.offsel.has(r[2])) continue;
    o[r[0]]=(o[r[0]]||0)+r[4]; } return o;
}
// borough series for current selection, current lens
function boroSeries(){
  const pb={}; DATA.precincts.forEach(p=>pb[p.pct]=p.boro);
  const out={}; BOROS.forEach(b=>out[b]={});
  for(const r of rows()){ if(!passLaw(r)||!passSel(r)) continue;
    const b=pb[r[1]]; if(!out[b]) continue; out[b][r[0]]=(out[b][r[0]]||0)+r[4]; }
  return out;
}
function offenseTotals(lens){ // total per oid across all years (for picker counts), respects law
  const m={}; for(const r of DATA[lens]){ if(!passLaw(r)) continue; m[r[2]]=(m[r[2]]||0)+r[4]; } return m;
}

/* ---------- init ---------- */
function init(){
  tip = document.getElementById('tip');
  // delegated hover tooltips for any [data-tip] element (definitions, help glyphs)
  ['mouseover','mousemove'].forEach(ev=>document.addEventListener(ev,e=>{
    const el=e.target.closest && e.target.closest('[data-tip]'); if(!el) return;
    if(ev==='mouseover'){ tip.innerHTML=el.getAttribute('data-tip'); tip.style.opacity=1; }
    moveTip(e);
  }));
  document.addEventListener('mouseout',e=>{ const el=e.target.closest && e.target.closest('[data-tip]');
    if(el && !el.contains(e.relatedTarget)) hideTip(); });
  // keyboard a11y: show tooltips on focus too
  document.addEventListener('focusin',e=>{ const el=e.target.closest && e.target.closest('[data-tip]'); if(!el) return;
    const r=el.getBoundingClientRect(); tip.innerHTML=el.getAttribute('data-tip'); tip.style.opacity=1;
    tip.style.left=(r.left+window.scrollX)+'px'; tip.style.top=(r.bottom+window.scrollY+6)+'px'; });
  document.addEventListener('focusout',e=>{ if(e.target.closest && e.target.closest('[data-tip]')) hideTip(); });
  document.getElementById('genDate').textContent = DATA.generated;
  ((DATA.popMeta&&DATA.popMeta.rateExclude)||[]).forEach(p=>RATE_EXCLUDE.add(+p));
  ((DATA.popMeta&&DATA.popMeta.daytimeFlag)||[]).forEach(p=>DAYTIME_FLAG.add(+p));
  DATA.offenses.forEach((o,i)=>state.offsel.add(i)); // default: all selected
  { const w=DATA.window||{}, last=DATA.years[DATA.years.length-1];
    const lc = w.partial ? ((w.partialYear||last)-1) : last;   // default to latest COMPLETE year
    DEFAULT_YEAR = DATA.years.includes(lc) ? lc : last; state.year = DEFAULT_YEAR; }
  fillDynamicLabels();
  applyHash();               // restore state from a shared link, if present
  document.getElementById('yearVal').textContent = yearLabel(state.year);

  // year-jump dropdown (in filter panel)
  const yj=document.getElementById('yearJump');
  yj.innerHTML = '<option value="" disabled>Jump to year…</option>' +
    DATA.years.map(y=>`<option value="${y}" ${y===state.year?'selected':''}>${yearLabel(y)}</option>`).join('');
  yj.addEventListener('change',()=>setYear(+yj.value));

  // year scrubber keyboard
  const yb=document.getElementById('yearBars');
  yb.addEventListener('keydown',e=>{ const i=DATA.years.indexOf(state.year);
    if(e.key==='ArrowRight'||e.key==='ArrowUp'){ e.preventDefault(); setYear(DATA.years[Math.min(DATA.years.length-1,i+1)]); }
    else if(e.key==='ArrowLeft'||e.key==='ArrowDown'){ e.preventDefault(); setYear(DATA.years[Math.max(0,i-1)]); }
    else if(e.key==='Home'){ e.preventDefault(); setYear(DATA.years[0]); }
    else if(e.key==='End'){ e.preventDefault(); setYear(DATA.years[DATA.years.length-1]); } });

  // segmented controls
  seg('lensSeg', v=>{ state.lens=v; buildPicker(); renderAll(); });
  seg('lawSeg', v=>{ state.law = v==='all'?'all':+v; buildPicker(); renderAll(); });
  seg('metricSeg', v=>{ state.metric=v; renderMap(); renderStateBar(); });

  // offense search (pure name filter)
  document.getElementById('offSearch').addEventListener('input', buildPicker);
  document.querySelectorAll('.pickbtns button').forEach(b=>b.addEventListener('click',()=>{
    const k=b.dataset.pick;
    if(k==='all') DATA.offenses.forEach((o,i)=>state.offsel.add(i));
    else if(k==='none') state.offsel.clear();
    else { state.offsel.clear(); DATA.offenses.forEach((o,i)=>{ if(o.group===k) state.offsel.add(i); }); }
    buildPicker(); renderAll();
  }));
  // sort toggle
  document.querySelectorAll('.offsort button').forEach(b=>b.addEventListener('click',()=>{
    state.offSort=b.dataset.sort;
    document.querySelectorAll('.offsort button').forEach(x=>x.setAttribute('aria-pressed', x===b));
    buildPicker();
  }));

  // mobile: expand/collapse the sticky control bar
  const cb=document.getElementById('controlbar');
  // toggles
  bindTog('zeroGroup','group',renderGroupTrend);
  bindTog('zeroCompare','compare',renderCompare);
  bindTog('zeroBoro','boro',renderBoro);
  document.getElementById('showEvents').addEventListener('change',e=>{ state.showEvents=e.target.checked; renderGroupTrend(); renderCompare(); renderBoro(); renderTrendExplorer(); if(state.precinct!=null) renderDetail(); });

  // dossier clear
  document.getElementById('detailClear').addEventListener('click', clearPrecinct);

  // share + export
  document.getElementById('copyLink').addEventListener('click', copyLink);
  document.getElementById('dlCsvBtn').addEventListener('click', exportCSV);
  const dv=document.getElementById('dlViewCsv'); if(dv) dv.addEventListener('click',e=>{ e.preventDefault(); exportCSV(); });
  window.addEventListener('hashchange', ()=>{ applyHash(); syncControls(); renderAll(); });

  // guided tour
  document.getElementById('tourBtn').addEventListener('click', toggleTour);

  // events list
  document.getElementById('eventList').innerHTML = EVENTS.map(e=>`<span class="pill"><b style="color:var(--gold)">${e.year}</b> ${e.label}</span>`).join('') +
    ' &mdash; these neutral reference lines appear on every time-series chart; hover a line to see the marker.';

  initMap();
  buildPicker();
  buildTrendControls();
  syncControls();       // reflect any state restored from the URL in the controls
  renderAll();
  initPlay();
}
function yearLabel(y){ const w=DATA&&DATA.window;
  if(w&&w.partial&&y===w.partialYear){ const q=((w.quarterLabel||'').split(' ')[0])||'Q1'; return y+' ('+q+')'; }
  return ''+y; }
function seg(id,cb){ const el=document.getElementById(id);
  el.addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return;
    [...el.children].forEach(c=>c.setAttribute('aria-checked', c===b)); cb(b.dataset.v); }); }
function bindTog(id,key,fn){ document.getElementById(id).addEventListener('change',e=>{ state.zero[key]=e.target.checked; fn(); }); }

/* ---------- year + state summary ---------- */
function setYear(yr){ if(yr==null||isNaN(yr)) return; state.year=yr;
  document.getElementById('yearVal').textContent=yearLabel(yr);
  const yj=document.getElementById('yearJump'); if(yj) yj.value=yr;
  renderYearDependent(); renderYearBars(); }
function lawShort(){ return state.law==='all'?'misdemeanors + violations':(state.law===0?'misdemeanors':'violations'); }
function offShort(){ const n=state.offsel.size, t=DATA.offenses.length;
  return n===t?'all offenses':(n===0?'no offenses':`${n} of ${t} offenses`); }
function selectionSummary(){ return `<b>${state.lens}</b> · <b>${lawShort()}</b> · <b>${offShort()}</b> · <b>${yearLabel(state.year)}</b>`; }
function renderStateBar(){ const el=document.getElementById('statebar'); if(!el) return;
  el.innerHTML = `<span class="lab">Showing</span> ${selectionSummary()}`
    + `<button class="adjust" onclick="document.getElementById('controlbar').classList.toggle('open')">Adjust ▾</button>`;
  writeHash(); }
function renderYearBars(){
  const el=document.getElementById('yearBars'); if(!el) return;
  // citywide total per year for current selection
  const tot={}; for(const r of rows()){ if(!passLaw(r)||!passSel(r)) continue; tot[r[0]]=(tot[r[0]]||0)+r[4]; }
  // 2026 is Q1 only; scale it up x4 for a fair visual bar height (marked separately)
  const disp=y=> y===2026 ? (tot[y]||0)*4 : (tot[y]||0);
  let max=0; DATA.years.forEach(y=>max=Math.max(max,disp(y)));
  el.setAttribute('aria-valuenow', state.year);
  el.setAttribute('aria-valuetext', yearLabel(state.year)+': '+fmt(tot[state.year]||0));
  el.innerHTML = DATA.years.map(y=>{
    const h=max? Math.max(6, Math.round(disp(y)/max*100)) : 6;
    const note = y===2026 ? ' (Q1, scaled ×4 for display)' : '';
    return `<span class="ybar ${y===state.year?'active':''}" data-y="${y}" style="height:${h}%"
      data-tip="<strong>${yearLabel(y)}</strong><br>${fmt(tot[y]||0)} incidents${note}<br><span style='opacity:.65'>click to view on the map</span>"></span>`;
  }).join('');
  el.querySelectorAll('.ybar').forEach(b=>b.addEventListener('click',()=>setYear(+b.dataset.y)));
}

/* ---------- offense picker ---------- */
function buildPicker(){
  const q=(document.getElementById('offSearch').value||'').trim().toLowerCase();
  const tot=offenseTotals(state.lens);
  const groups={proactive:[],victim:[],other:[]};
  DATA.offenses.forEach((o,i)=>{ if(q && !o.label.toLowerCase().includes(q)) return; groups[o.group].push(i); });
  const sortFn = state.offSort==='name'
    ? (a,b)=>DATA.offenses[a].label.localeCompare(DATA.offenses[b].label)
    : (a,b)=>(tot[b]||0)-(tot[a]||0);
  let html='';
  ['proactive','victim','other'].forEach(g=>{
    if(!groups[g].length) return;
    const ids=groups[g].sort(sortFn);
    const selN=ids.filter(i=>state.offsel.has(i)).length;
    const arrow = state.collapsed[g] ? '▸' : '▾';
    html+=`<div class="offgrp${state.collapsed[g]?' collapsed':''}" data-grp="${g}" role="button" tabindex="0" aria-expanded="${!state.collapsed[g]}">`
      +`<span class="arrow">${arrow}</span><span class="dot" style="background:${GCOL[g]}"></span>${GNAME[g]}`
      +`<span class="info" data-tip="${GROUP_DEF[g]}" tabindex="0">i</span>`
      +`<span class="gc">${selN}/${ids.length}</span></div>`;
    if(!state.collapsed[g]) ids.forEach(i=>{
      const o=DATA.offenses[i];
      html+=`<div class="offrow"><input type="checkbox" id="off${i}" data-oid="${i}" ${state.offsel.has(i)?'checked':''}>
        <label for="off${i}">${o.label}</label><span class="c">${fmt(tot[i]||0)}</span></div>`;
    });
  });
  const wrap=document.getElementById('offWrap'); wrap.innerHTML=html||'<div class="detailempty">No offenses match your search.</div>';
  wrap.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change',()=>{
    const i=+cb.dataset.oid; cb.checked?state.offsel.add(i):state.offsel.delete(i); renderAll();
  }));
  wrap.querySelectorAll('.offgrp').forEach(h=>{
    const toggle=()=>{ const g=h.dataset.grp; state.collapsed[g]=!state.collapsed[g]; buildPicker(); };
    h.addEventListener('click',e=>{ if(e.target.closest('.info')) return; toggle(); });
    h.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); } });
  });
  // persistent summary
  const sum=document.getElementById('offSummary');
  if(sum){ let inc=0; for(const r of rows()){ if(r[0]===state.year && passLaw(r) && passSel(r)) inc+=r[4]; }
    sum.innerHTML=`<b>${state.offsel.size}</b> of ${DATA.offenses.length} offenses · <b>${fmt(inc)}</b> incidents (${yearLabel(state.year)}, ${state.lens})`; }
}

/* ---------- map ---------- */
function initMap(){
  map = L.map('map',{scrollWheelZoom:true, zoomControl:true}).setView([40.705,-73.93],10);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png?key=cb1_2r82_1_ae4e70b6166057bc41b89638',{
    attribution:'&copy; OpenStreetMap &copy; CARTO', subdomains:'abcd', maxZoom:19
  }).addTo(map);
  geoLayer = L.geoJSON(geo,{
    style:f=>baseStyle(),
    onEachFeature:(f,layer)=>{
      const p=f.properties.pct; byPctLayer[p]=layer;
      layer.on({
        mouseover:e=>{ layer.setStyle({weight:2.2,color:'#f3e8c8'}); layer.bringToFront(); showPctTip(e,p); },
        mousemove:e=>moveTip(e),
        mouseout:e=>{ restyleOne(p); hideTip(); highlightSelected(); },
        click:()=>{ state.precinct=p; renderDetail(); highlightSelected(); syncControls(); writeHash(); }
      });
    }
  }).addTo(map);
}
function baseStyle(){ return {weight:0.6,color:'#4a4234',fillColor:NODATA,fillOpacity:0.9}; }

// returns {kind, vals, ...domain info}
function mapValues(){
  if(state.metric==='share'){ const {share}=perPrecinctShare(state.year); return {kind:'share', vals:share}; }
  if(state.metric==='ratio'){ const {ratio,comp,arr}=perPrecinctRatio(state.year);
    let tc=0,ta=0; for(const p in comp) tc+=comp[p]; for(const p in arr) ta+=arr[p];
    return {kind:'ratio', vals:ratio, center: ta? tc/ta : 1}; }
  if(state.metric==='rate'){ const {rate,count,pop,max}=perPrecinctRate(state.year);
    return {kind:'rate', vals:rate, count, pop, max}; }
  const vals=perPrecinct(state.year); let max=0; for(const p in vals) max=Math.max(max,vals[p]);
  return {kind:'count', vals, max};
}
let _scale={breaks:[]};
const LOGR=0.85; // log2 spread around the citywide ratio -> ≈1.8x either side of the norm
function colorFor(v,info){
  if(v==null || v===undefined) return NODATA;
  if(info.kind==='share'){ const idx=Math.min(RAMP_SHARE.length-1, Math.floor(v*RAMP_SHARE.length)); return RAMP_SHARE[idx]; }
  if(info.kind==='ratio'){ const center=info.center||1; let l=Math.log2(v)-Math.log2(center);
    l=Math.max(-LOGR,Math.min(LOGR,l));
    const t=(l+LOGR)/(2*LOGR); const idx=Math.min(RAMP_RATIO.length-1, Math.floor(t*RAMP_RATIO.length)); return RAMP_RATIO[idx]; }
  const ramp = info.kind==='rate' ? RAMP_RATE : RAMP;
  if(info.max<=0) return ramp[0];
  for(let i=0;i<_scale.breaks.length;i++){ if(v<=_scale.breaks[i]) return ramp[i]; }
  return ramp[ramp.length-1];
}
function computeBreaks(info){
  if(info.kind!=='count' && info.kind!=='rate'){ _scale={breaks:[]}; return; }
  const ramp = info.kind==='rate' ? RAMP_RATE : RAMP;
  const arr=Object.values(info.vals).filter(v=>v>0).sort((a,b)=>a-b);
  const breaks=[];
  for(let i=1;i<=ramp.length;i++){ const q=arr.length?arr[Math.min(arr.length-1,Math.floor(arr.length*i/ramp.length))]:0; breaks.push(q); }
  _scale={breaks,max:info.max};
}
function renderMap(){
  const info=mapValues(); computeBreaks(info); _mapInfo=info;
  for(const p in byPctLayer) restyleOne(p, info);
  document.getElementById('mapTitle').textContent =
    info.kind==='share' ? 'Enforcement-sensitive share of incidents, by precinct'
    : info.kind==='ratio' ? 'Complaint-to-arrest ratio, by precinct'
    : info.kind==='rate' ? 'Incidents per 1,000 residents, by precinct'
    : 'Incident count by precinct';
  document.getElementById('mapReadme').innerHTML = mapExplainer(info);
  document.getElementById('mapNote').innerHTML = mapNoteText(info);
  renderLegend(info);
  highlightSelected();
}
function mapExplainer(info){
  const lensW = state.lens==='complaints'?'complaints (crimes reported to police)':'arrests (people booked by police)';
  if(info.kind==='count')
    return `<b>How to read this</b>Darker precincts recorded <strong>more incidents</strong>. This shows ${lensW} for your selected offenses in ${yearLabel(state.year)} — raw totals, <em>not</em> adjusted for population, so larger and busier precincts tend to run higher. Hover a precinct for its number; click to open its dossier.`;
  if(info.kind==='rate')
    return `<b>How to read this</b>Each precinct is shaded by <strong>incidents per 1,000 residents</strong> — ${lensW} for your selected offenses in ${yearLabel(state.year)}, divided by the precinct's population. Population <em>varies by year</em> (2010 and 2020 censuses, interpolated). This adjusts for how many people live in each precinct, so a small dense precinct and a large one become comparable. <span style="opacity:.7">Central Park and the new 116th precinct are shown grey (no reliable residential base); Midtown precincts 14 and 18 run high because their daytime population dwarfs the residents counted here.</span>`;
  if(info.kind==='share')
    return `<b>How to read this</b>Each precinct is shaded by the <strong>share of its incidents that are enforcement-sensitive</strong> — proactively policed offenses like drugs, trespass and fare evasion, as opposed to victim-reported ones. <span style="color:var(--hot)"><strong>Red</strong></span> = a bigger slice is officer-initiated; <span style="color:var(--cool)"><strong>blue</strong></span> = more is victim-reported. A 40% precinct means 40 of every 100 recorded incidents were enforcement-sensitive.`;
  const c=(info.center||1).toFixed(1);
  return `<b>How to read this</b>Each precinct's <strong>complaints divided by its arrests</strong>, using both datasets at once (the lens toggle is ignored here). Citywide there are about <strong>${c} complaints for every arrest</strong>, so the color scale is centered on ${c}×, not on 1. <span style="color:var(--hot)"><strong>Redder</strong></span> precincts make more arrests relative to what residents report (enforcement-heavy); <span style="color:var(--cool)"><strong>bluer</strong></span> precincts report more than police act on. Example: a precinct at 4× logs four complaints for each arrest — more complaint-heavy than the city; one at 1.5× is more arrest-heavy.`;
}
let _mapInfo=null;
function restyleOne(p, info){ info=info||_mapInfo; if(!info||!byPctLayer[p]) return;
  const v=info.vals[p]; byPctLayer[p].setStyle({fillColor:colorFor(v,info), weight:0.6, color:'#4a4234', fillOpacity:0.9}); }
function highlightSelected(){ if(state.precinct!=null && byPctLayer[state.precinct]){
  const l=byPctLayer[state.precinct]; l.setStyle({weight:4,color:'#ffffff',fillOpacity:1}); l.bringToFront(); } }
function clearPrecinct(){ const p=state.precinct; state.precinct=null;
  if(p!=null) restyleOne(p);
  document.getElementById('detailClear').style.display='none';
  document.getElementById('detailTitle').textContent='Precinct detail';
  document.getElementById('detailBody').innerHTML='<div class="detailempty">Click any precinct on the map to open its dossier &mdash; trend and top offenses.</div>';
  writeHash(); }
function mapNoteText(info){
  const law = state.law==='all'?'misdemeanors + violations':(state.law===0?'misdemeanors only':'violations only');
  const sel = state.offsel.size===DATA.offenses.length?'all offenses':`${state.offsel.size} selected offense type(s)`;
  if(info.kind==='ratio') return `Both lenses · ${law} · ${sel} · ${yearLabel(state.year)}. <strong>Blue</strong> = more complaints than arrests (reporting outpaces enforcement); <strong style="color:var(--hot)">red</strong> = more arrests than complaints (enforcement-heavy). Lens toggle is ignored here.`;
  const lens = state.lens==='complaints'?'complaints (reported)':'arrests (enforcement)';
  if(info.kind==='share') return `${lens} · ${law} · share computed over all offenses · ${yearLabel(state.year)}`;
  if(info.kind==='rate') return `${lens} · ${law} · ${sel} · per 1,000 residents · ${yearLabel(state.year)}. Population from the 2010 &amp; 2020 censuses (varies by year); Central Park &amp; the 116th are excluded.`;
  return `${lens} · ${law} · ${sel} · ${yearLabel(state.year)}`;
}
function rampDiv(arr){ return arr.map(c=>`<span style="background:${c}"></span>`).join(''); }
function renderLegend(info){
  const el=document.getElementById('legend'); let cap,ramp,lbls;
  if(info.kind==='share'){ cap='Enforcement-sensitive share · % of incidents · linear 0–100%'; ramp=rampDiv(RAMP_SHARE);
    lbls='<span>0% · complaint areas</span><span>50%</span><span>100% · enforcement-heavy</span>'; }
  else if(info.kind==='ratio'){ const c=(info.center||1);
    cap=`Complaints per arrest · log scale, centered on city average (${c.toFixed(1)}×)`; ramp=rampDiv(RAMP_RATIO);
    lbls='<span>more arrest-heavy</span><span>city average</span><span>more complaint-heavy</span>'; }
  else if(info.kind==='rate'){ const b=_scale.breaks; const r1=n=>(n||0).toFixed(1);
    cap='Incidents per 1,000 residents in '+yearLabel(state.year)+' · quantile bins (equal precinct count)'; ramp=rampDiv(RAMP_RATE);
    lbls=`<span>0 (darkest)</span><span>${r1(b[Math.floor(b.length/2)])}</span><span>${r1(info.max)} (brightest)</span>`; }
  else { const b=_scale.breaks; cap='Incidents in '+yearLabel(state.year)+' · quantile bins (equal precinct count)'; ramp=rampDiv(RAMP);
    lbls=`<span>0 (darkest)</span><span>${fmt(b[Math.floor(b.length/2)]||0)}</span><span>${fmt(info.max||0)} (brightest)</span>`; }
  el.innerHTML=`<div class="cap">${cap}</div><div class="ramp">${ramp}</div><div class="lbls">${lbls}</div>`;
}
function showPctTip(e,p){
  const info=_mapInfo; const meta=DATA.precincts.find(x=>x.pct===p)||{boro:''};
  let body;
  if(info && info.kind==='share'){ const {share,tot}=perPrecinctShare(state.year);
    body=`${pct1(share[p]||0)} enforcement-sensitive<br>${fmt(tot[p]||0)} total incidents`; }
  else if(info && info.kind==='ratio'){ const {raw}=perPrecinctRatio(state.year); const d=raw[p]||{c:0,a:0};
    const r = d.a? (d.c/d.a) : (d.c?Infinity:0); const c=info.center||1;
    const ratioTxt = d.a? r.toFixed(1)+'× complaints per arrest' : (d.c?'arrests = 0':'no data');
    let rel=''; if(d.a){ rel = r>c*1.05 ? '<br><span style="color:#9cc">more complaint-heavy than city</span>'
      : r<c*0.95 ? '<br><span style="color:#e9a">more arrest-heavy than city</span>' : '<br>near city average'; }
    body=`${fmt(d.c)} complaints · ${fmt(d.a)} arrests<br>${ratioTxt}${rel}`; }
  else if(info && info.kind==='rate'){ const cnt=(info.count&&info.count[p])||0; const pop=info.pop&&info.pop[p];
    if(RATE_EXCLUDE.has(p) || !pop){ body=`${fmt(cnt)} incidents<br><span style="opacity:.7">no per-capita rate — ${RATE_EXCLUDE.has(p)?'non-residential / new precinct':'no population estimate'}</span>`; }
    else { const rt=cnt/pop*1000; const flag=DAYTIME_FLAG.has(p)?'<br><span style="color:#e9c">daytime population inflates this rate</span>':'';
      body=`<strong>${rt.toFixed(1)}</strong> per 1,000 residents<br>${fmt(cnt)} incidents · ${fmt(pop)} residents${flag}`; } }
  else { body=`${fmt((info&&info.vals[p])||0)} incidents`; }
  const hood=nbhOf(p); const head = hood ? `Precinct ${p} · ${hood}` : `Precinct ${p}`;
  tip.innerHTML=`<strong>${head}</strong> · ${meta.boro}<br>${body}<br><span style="opacity:.6">${yearLabel(state.year)} · click for detail</span>`;
  moveTip(e); tip.style.opacity=1;
}
function moveTip(e){ const ev=e.originalEvent||e; tip.style.left=(ev.pageX+14)+'px'; tip.style.top=(ev.pageY+12)+'px'; }
function hideTip(){ tip.style.opacity=0; }

/* ---------- KPIs ---------- */
function renderKPIs(){
  const yr=state.year, cur=totalFor(yr), prev=totalFor(yr-1);
  const pp=perPrecinct(yr); let topP=null,topV=-1; for(const p in pp){ if(pp[p]>topV){topV=pp[p];topP=p;} }
  const {share}=(()=>{ const pro={},tot={}; for(const r of rows()){ if(r[0]!==yr||!passLaw(r)) continue;
      tot.a=(tot.a||0)+r[4]; if(G(r[2])==='proactive') pro.a=(pro.a||0)+r[4]; }
      return {share: tot.a? pro.a/tot.a : 0}; })();
  let chg='';
  if(yr===2026){ chg=`<div class="meta">Q1 only — not comparable to full years</div>`; }
  else if(prev>0){ const d=(cur-prev)/prev; const cls=d>=0?'up':'down';
    chg=`<div class="meta ${cls}">${d>=0?'▲':'▼'} ${pct1(Math.abs(d))} vs ${yr-1}</div>`; }
  const boro=(DATA.precincts.find(x=>x.pct==topP)||{}).boro||'';
  const lensCol = state.lens==='complaints'?COOL:HOT;
  const ig = t => ` <span class="info" data-tip="${t}">i</span>`;
  const sel = state.offsel.size===DATA.offenses.length?'all offense types':state.offsel.size+' offense type(s)';
  document.getElementById('kpis').innerHTML = card('Incidents · '+yearLabel(yr)
        + ig(`<strong>Incidents</strong><br>Total ${state.lens} recorded for your selected offenses and offense level in ${yearLabel(yr)}. Raw totals, not adjusted for population.`),
      fmt(cur), sel, null, lensCol)
    + card('Change'
        + ig('<strong>Change</strong><br>Difference in this total from the prior full year. Left blank for 2026, which covers only the first quarter and is not comparable to a full year.'),
      yr===2026?'—':(cur>=prev?'+':'−')+fmt(Math.abs(cur-prev)), '', chg, yr===2026?'#9a8f73':(cur>=prev?HOT:'#2c7a4b'))
    + card('Enforcement-sensitive share'
        + ig(`<strong>Enforcement-sensitive share</strong><br>Of all ${state.lens} recorded this year (every offense, regardless of the filter), the percentage that are enforcement-sensitive — proactively policed offenses like drugs, trespass and fare evasion.`),
      pct1(share), 'of all '+(state.lens)+' this year', null, HOT)
    + card('Top precinct'
        + ig('<strong>Top precinct</strong><br>The precinct with the most recorded incidents for your current selection (lens, offense level and offenses), this year. Ranked by raw count, not population.'),
      topP?('#'+topP):'—', topP?((nbhOf(+topP)?nbhOf(+topP)+' · ':'')+boro+' · '+fmt(topV)+' incidents'):'', null, '#b08328');
}
function card(lab,val,meta,extra,color){ return `<div class="kpi"><span class="accent" style="background:${color||HOT}"></span>
  <div class="lab">${lab}</div><div class="val num">${val}</div>${extra||(meta?`<div class="meta">${meta}</div>`:'')}</div>`; }

/* ---------- SVG line chart ---------- */
function lineChart(elId, series, opt){
  opt=opt||{}; const el=document.getElementById(elId);
  const W=el.clientWidth||560, H=opt.height||250, m={t:14,r:14,b:26,l:52};
  const years=DATA.years, xmin=years[0], xmax=years[years.length-1];
  let ymax=0, ymin=Infinity;
  series.forEach(s=>s.values.forEach(v=>{ if(v.y>ymax)ymax=v.y; if(v.y<ymin)ymin=v.y; }));
  if(!isFinite(ymin)) ymin=0;
  const zero = opt.zero!==false; const lo = zero?0:Math.max(0, ymin*0.92); const hi = ymax*1.06||1;
  const X=y=>m.l+(y-xmin)/(xmax-xmin||1)*(W-m.l-m.r);
  const Y=v=>H-m.b-(v-lo)/(hi-lo||1)*(H-m.t-m.b);
  let s=`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-el="${elId}" role="img" aria-label="Time-series chart, 2015 to first quarter 2026. The final point (2026) reflects the first quarter only and is drawn as a dashed segment.">`;
  // y gridlines
  const ticks=4; for(let i=0;i<=ticks;i++){ const val=lo+(hi-lo)*i/ticks; const yy=Y(val);
    s+=`<line class="gridline" x1="${m.l}" x2="${W-m.r}" y1="${yy}" y2="${yy}"/>`;
    s+=`<text class="axislab" x="${m.l-6}" y="${yy+3}" text-anchor="end">${fmt(Math.round(val))}</text>`; }
  // x labels
  years.forEach(y=>{ if(y%2===1 && y!==xmax) return; s+=`<text class="axislab" x="${X(y)}" y="${H-8}" text-anchor="middle">${y===2026?"'26 Q1":"'"+String(y).slice(2)}</text>`; });
  // events
  if(state.showEvents && opt.events!==false){ EVENTS.forEach(e=>{ const xx=X(e.year);
    s+=`<line class="evline" x1="${xx}" x2="${xx}" y1="${m.t}" y2="${H-m.b}"/>`;
    s+=`<text class="evlab" x="${xx+3}" y="${m.t+9}">${e.year}</text>`;
    s+=`<rect x="${xx-7}" y="${m.t-3}" width="14" height="13" fill="transparent" style="cursor:help" data-tip="<strong>${e.year}</strong><br>${e.label}"/>`; }); }
  // lines (split solid 2015-2025, dashed 2025->2026 to flag partial)
  series.forEach(se=>{
    const pts=se.values.slice().sort((a,b)=>a.x-b.x);
    let dFull='', dPart='';
    for(let i=0;i<pts.length;i++){ const p=pts[i], cmd=(i===0?'M':'L')+X(p.x)+' '+Y(p.y);
      if(p.x<=2025) dFull+=cmd+' '; }
    const p25=pts.find(p=>p.x===2025), p26=pts.find(p=>p.x===2026);
    if(p25&&p26) dPart=`M${X(2025)} ${Y(p25.y)} L${X(2026)} ${Y(p26.y)}`;
    s+=`<path d="${dFull}" fill="none" stroke="${se.color}" stroke-width="2.2"/>`;
    if(dPart) s+=`<path d="${dPart}" fill="none" stroke="${se.color}" stroke-width="2.2" stroke-dasharray="4 3"/>`;
    pts.forEach(p=>{ s+=`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="3" fill="${se.color}"
      data-x="${p.x}" data-name="${se.name}" data-y="${p.y}"/>`; });
  });
  s+='</svg>';
  el.innerHTML=s;
  // hover
  el.querySelectorAll('circle').forEach(c=>{
    c.addEventListener('mouseenter',ev=>{ tip.innerHTML=`<strong>${c.dataset.name}</strong><br>${c.dataset.x==='2026'?'2026 Q1':c.dataset.x}: ${fmt(+c.dataset.y)}`;
      tip.style.opacity=1; moveTip(ev); });
    c.addEventListener('mousemove',moveTip);
    c.addEventListener('mouseleave',hideTip);
  });
}
function legendHtml(elId, items){ document.getElementById(elId).innerHTML =
  items.map(i=>{ const t=i.tip?` class="info" style="cursor:help;border:0;width:auto;height:auto;margin:0;opacity:1" data-tip="${i.tip}"`:'';
    return `<span${t}><i style="background:${i.color}"></i>${i.name}${i.tip?' <span class="info">i</span>':''}</span>`; }).join(''); }
function toSeries(obj,name,color){ return {name,color,values:DATA.years.map(y=>({x:y,y:obj[y]||0}))}; }

/* ---------- charts ---------- */
function renderGroupTrend(){
  const gs=groupSeries(state.lens);
  const series=['proactive','victim','other'].map(g=>{ const s=toSeries(gs[g],GNAME[g],GCOL[g]); s.tip=GROUP_DEF[g]; return s; });
  lineChart('groupTrend',series,{zero:state.zero.group,height:240});
  legendHtml('groupLegend',series);
  const n=document.getElementById('groupNote');
  if(n) n.innerHTML=`Citywide totals by offense family. Showing <b>${state.lens}</b> · <b>${lawShort()}</b> (the offense filter doesn't apply here).`;
}
function renderCompare(){
  const c=selSeries('complaints'), a=selSeries('arrests');
  const series=[ toSeries(c,'Complaints (reported)',COOL), toSeries(a,'Arrests (enforcement)',HOT) ];
  lineChart('compareChart',series,{zero:state.zero.compare,height:260});
  legendHtml('compareLegend',series);
  const lbl=document.getElementById('compareSelLabel');
  if(lbl){ const n=state.offsel.size, tot=DATA.offenses.length;
    lbl.textContent = n===tot ? 'all offenses' : (n===0 ? 'no offenses selected' : n+' selected offense type(s)'); }
}
function renderBoro(){
  const bs=boroSeries();
  const series=BOROS.map(b=>toSeries(bs[b],b,BORO_COL[b]));
  lineChart('boroChart',series,{zero:state.zero.boro,height:250});
  legendHtml('boroLegend',series);
  const n=document.getElementById('boroNote');
  if(n) n.innerHTML=`Your selection over time, by borough. Showing <b>${state.lens}</b> · <b>${lawShort()}</b> · <b>${offShort()}</b>.`;
}

/* ---------- trend explorer & precinct comparison ---------- */
function trendOffenseMatch(oid){ const t=state.trendOffense;
  if(t==='all') return true;
  if(t[0]==='g') return G(oid)===t.slice(2);
  if(t[0]==='o') return oid===+t.slice(2);
  return true; }
function trendValuesFor(place){ const o={};
  for(const r of rows()){ if(!passLaw(r)||!trendOffenseMatch(r[2])) continue;
    if(place!=='city' && r[1]!==place) continue; o[r[0]]=(o[r[0]]||0)+r[4]; }
  return o; }
function trendOffenseLabel(){ const t=state.trendOffense;
  if(t==='all') return 'all offenses';
  if(t[0]==='g') return GNAME[t.slice(2)]+' offenses';
  return DATA.offenses[+t.slice(2)].label; }
function lawLabel(){ return state.law==='all'?'misdemeanors + violations':(state.law===0?'misdemeanors':'violations'); }
const TREND_PAL=['#c8341f','#1f5f7a','#b08328'];
function renderTrendExplorer(){
  const pb={}; DATA.precincts.forEach(p=>pb[p.pct]=p.boro);
  const places=[]; if(state.trendCity) places.push('city'); state.trendPlaces.forEach(p=>places.push(p));
  let pi=0; const series=places.map(pl=>{
    const name = pl==='city'?'Citywide':('Precinct '+pl+' · '+(pb[pl]||''));
    const color = pl==='city'?'#16130c':TREND_PAL[pi++ % TREND_PAL.length];
    return toSeries(trendValuesFor(pl),name,color);
  });
  document.getElementById('trendNote').innerHTML =
    `<strong>${state.lens}</strong> · ${lawLabel()} · <strong>${trendOffenseLabel()}</strong>. Each line is one place; the dashed segment to 2026 is the first quarter only.`;
  if(!series.length){ document.getElementById('trendChart').innerHTML='<div class="detailempty">Turn on the Citywide line or add a precinct to see a trend.</div>';
    document.getElementById('trendLegend').innerHTML=''; }
  else { lineChart('trendChart',series,{zero:state.zero.trend,height:300}); legendHtml('trendLegend',series); }
  renderTrendChips();
}
function renderTrendChips(){
  const el=document.getElementById('trendChips'); if(!el) return;
  const pb={}; DATA.precincts.forEach(p=>pb[p.pct]=p.boro);
  el.innerHTML = state.trendPlaces.map(p=>`<span class="chip">#${p} · ${pb[p]||''}<button data-rm="${p}" title="remove">&times;</button></span>`).join('')
    + (state.trendPlaces.length>=3?'<span class="chiphint">max 3 — remove one to add another</span>':'');
  el.querySelectorAll('button[data-rm]').forEach(b=>b.addEventListener('click',()=>{
    state.trendPlaces=state.trendPlaces.filter(x=>x!==+b.dataset.rm); renderTrendExplorer(); }));
}
function buildTrendControls(){
  const sel=document.getElementById('trendOffense');
  let h='<option value="all">All offenses</option><optgroup label="By group">'
    +'<option value="g:proactive">Enforcement-sensitive (all)</option>'
    +'<option value="g:victim">Complaint-driven (all)</option>'
    +'<option value="g:other">Other / mixed (all)</option></optgroup>';
  ['proactive','victim','other'].forEach(g=>{ h+=`<optgroup label="${GNAME[g]}">`;
    DATA.offenses.forEach((o,i)=>{ if(o.group===g) h+=`<option value="o:${i}">${o.label}</option>`; }); h+='</optgroup>'; });
  sel.innerHTML=h; sel.value=state.trendOffense;
  sel.addEventListener('change',()=>{ state.trendOffense=sel.value; renderTrendExplorer(); });
  // typeahead precinct combobox
  const dl=document.getElementById('pctDatalist');
  dl.innerHTML=DATA.precincts.map(p=>`<option value="${p.pct} — ${p.boro}"></option>`).join('');
  const inp=document.getElementById('trendPctInput');
  const tryAdd=()=>{ const m=(inp.value||'').match(/\d+/); if(!m){ return; } const v=+m[0];
    if(DATA.precincts.some(p=>p.pct===v) && !state.trendPlaces.includes(v) && state.trendPlaces.length<3){
      state.trendPlaces.push(v); renderTrendExplorer(); }
    inp.value=''; };
  inp.addEventListener('change',tryAdd);
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); tryAdd(); } });
  inp.addEventListener('input',()=>{ if(DATA.precincts.some(p=>`${p.pct} — ${p.boro}`===inp.value)) tryAdd(); });
  document.getElementById('trendCity').addEventListener('change',e=>{ state.trendCity=e.target.checked; renderTrendExplorer(); });
  document.getElementById('zeroTrend').addEventListener('change',e=>{ state.zero.trend=e.target.checked; renderTrendExplorer(); });
}

/* ---------- ranking ---------- */
function renderRank(){
  const pp=perPrecinct(state.year); const pb={}; DATA.precincts.forEach(p=>pb[p.pct]=p.boro);
  let arr=Object.entries(pp).map(([p,v])=>({p:+p,v,boro:pb[p]}));
  const max=arr.length?Math.max(...arr.map(r=>r.v)):1;
  const s=state.rankSort;
  arr.sort((a,b)=> s==='pct' ? a.p-b.p : s==='boro' ? (a.boro.localeCompare(b.boro)||b.v-a.v) : b.v-a.v);
  document.getElementById('rankNote').innerHTML = `Showing <b>${state.lens}</b> · <b>${lawShort()}</b> · <b>${offShort()}</b> · <b>${yearLabel(state.year)}</b>. Top 15 of ${arr.length} precincts. Click a column to re-sort, or a row to open its dossier.`;
  const arrow=k=> s===k ? ' ▾' : '';
  let h=`<table class="rank"><tr><th>#</th><th class="sortable" data-sort="pct" style="cursor:pointer">Precinct${arrow('pct')}</th>`
    +`<th class="sortable" data-sort="boro" style="cursor:pointer">Borough${arrow('boro')}</th>`
    +`<th class="sortable" data-sort="count" style="text-align:right;cursor:pointer">Incidents${arrow('count')}</th><th></th></tr>`;
  arr.slice(0,15).forEach((r,i)=>{ h+=`<tr style="cursor:pointer" data-p="${r.p}"><td>${i+1}</td><td>#${r.p}<span class="hood">${nbhOf(r.p)}</span></td><td>${r.boro}</td>
    <td class="n">${fmt(r.v)}</td><td style="width:34%"><span class="bar" style="width:${Math.max(2,r.v/max*100)}%;background:${BORO_COL[r.boro]||'#c1432f'}"></span></td></tr>`; });
  h+='</table>';
  const t=document.getElementById('rankTable'); t.innerHTML=h;
  t.querySelectorAll('th.sortable').forEach(th=>th.addEventListener('click',()=>{ state.rankSort=th.dataset.sort; renderRank(); }));
  t.querySelectorAll('tr[data-p]').forEach(tr=>tr.addEventListener('click',()=>focusPrecinct(+tr.dataset.p)));
}
// select a precinct AND bring the map + dossier into view (used when clicking away from the map)
function focusPrecinct(p){
  state.precinct=p; renderDetail(); highlightSelected(); syncControls(); writeHash();
  if(byPctLayer[p]) map.fitBounds(byPctLayer[p].getBounds(),{maxZoom:13,padding:[40,40]});
  const panel=document.getElementById('map').closest('.panel');
  panel.scrollIntoView({behavior:'smooth',block:'start'});
  panel.classList.remove('flash'); void panel.offsetWidth; panel.classList.add('flash');
}

/* ---------- precinct detail ---------- */
function renderDetail(){
  const p=state.precinct; if(p==null) return;
  const meta=DATA.precincts.find(x=>x.pct===p)||{boro:''};
  document.getElementById('detailClear').style.display='inline-block';
  // trend for current selection at this precinct
  const ser={}; for(const r of rows()){ if(r[1]!==p||!passLaw(r)||!passSel(r)) continue; ser[r[0]]=(ser[r[0]]||0)+r[4]; }
  // top offenses this year at this precinct
  const yr=state.year; const off={};
  for(const r of rows()){ if(r[1]!==p||r[0]!==yr||!passLaw(r)) continue; off[r[2]]=(off[r[2]]||0)+r[4]; }
  const top=Object.entries(off).map(([o,v])=>({o:+o,v})).sort((a,b)=>b.v-a.v).slice(0,8);
  const tmax=top.length?top[0].v:1;
  // enforcement share at precinct this year
  let pro=0,tot=0; for(const r of rows()){ if(r[1]!==p||r[0]!==yr||!passLaw(r)) continue; tot+=r[4]; if(G(r[2])==='proactive') pro+=r[4]; }
  const hood=nbhOf(p);
  document.getElementById('detailTitle').textContent=`Precinct ${p}${hood?' · '+hood:''} · ${meta.boro} · ${fmt(tot)} incidents`;
  // per-capita rate for the current selection at this precinct/year
  const pop=popOf(''+p,yr);
  let rateLine='';
  if(RATE_EXCLUDE.has(p) || !pop){ rateLine = ` · <span style="opacity:.7">no per-capita rate (${RATE_EXCLUDE.has(p)?'non-residential / new precinct':'no population estimate'})</span>`; }
  else { const rt=tot/pop*1000; const flag=DAYTIME_FLAG.has(p)?' <span style="color:var(--hot)">(daytime population inflates this)</span>':'';
    rateLine = ` · <strong>${rt.toFixed(1)}</strong> per 1,000 residents (${fmt(pop)} residents, ${yearLabel(yr)})${flag}`; }
  let h=`<div class="note">Enforcement-sensitive share in ${yearLabel(yr)}: <strong>${pct1(tot?pro/tot:0)}</strong> · ${fmt(tot)} total incidents (${state.lens})${rateLine}</div>`;
  h+='<div id="detTrend"></div>';
  h+=`<h3 style="margin-top:10px;font-size:13px">Top offenses, ${yearLabel(yr)}</h3><table class="rank">`;
  top.forEach(t=>{ const o=DATA.offenses[t.o]; h+=`<tr><td><span class="pill" style="border-color:${GCOL[o.group]};color:${GCOL[o.group]};cursor:help" data-tip="${GROUP_DEF[o.group]}">${GNAME[o.group][0]}</span></td>`
    + `<td>${o.label}</td><td class="n">${fmt(t.v)}</td><td style="width:36%"><span class="bar" style="width:${Math.max(2,t.v/tmax*100)}%;background:${GCOL[o.group]}"></span></td></tr>`; });
  h+='</table>';
  const body=document.getElementById('detailBody'); body.innerHTML=h;
  lineChart('detTrend',[toSeries(ser,'Precinct '+p+' (current selection)','#1b1b1a')],{zero:true,height:170,events:true});
}

/* ---------- dynamic labels ---------- */
function millions(n){ return (n/1e6).toFixed(1)+' million'; }
function quarterPhrase(ql){ const m=(ql||'').match(/Q([1-4])\s+(\d{4})/); if(!m) return ql||'';
  return `the ${({1:'first',2:'second',3:'third',4:'fourth'})[m[1]]} quarter of ${m[2]}`; }
function prettyDate(iso){ const p=(iso||'').split('-'); if(p.length!==3) return iso||'';
  return `${['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1]]} ${+p[2]}`; }
function fillDynamicLabels(){
  const w=DATA.window||{}, ql=w.quarterLabel||'';
  const set=(id,txt)=>{ const el=document.getElementById(id); if(el) el.textContent=txt; };
  if(w.partial && ql){ set('dlWindow', ql); set('scrubEnd', ql); set('sfWindow', quarterPhrase(ql)); }
  set('sfComplaints', millions(DATA.complaints.reduce((s,r)=>s+r[4],0)));
  set('sfArrests',    millions(DATA.arrests.reduce((s,r)=>s+r[4],0)));
  if(w.partial && w.partialYear)
    set('ftWindow', `${w.partialYear} is partial (${ql}${w.end?', through '+prettyDate(w.end):''}).`);
  if(ql) document.title = `'Small' Crimes Up Close — New York City misdemeanors and violations, 2015 – ${ql}`;
}

/* ---------- shareable deep-link state ---------- */
function writeHash(){
  if(!DATA) return;
  const q=[];
  if(state.lens!=='complaints') q.push('l=a');
  if(state.law!=='all') q.push('w='+(state.law===0?'m':'v'));
  if(state.metric!=='count') q.push('m='+state.metric);
  if(state.year!==DEFAULT_YEAR) q.push('y='+state.year);
  if(state.precinct!=null) q.push('p='+state.precinct);
  if(state.offsel.size!==DATA.offenses.length) q.push('o='+[...state.offsel].sort((a,b)=>a-b).join('.'));
  const base=location.pathname+location.search;
  history.replaceState(null,'', q.length? base+'#'+q.join('&') : base);
}
function applyHash(){
  const h=location.hash.replace(/^#/,''); if(!h) return;
  const q={}; h.split('&').forEach(kv=>{ const i=kv.indexOf('='); if(i>0) q[kv.slice(0,i)]=kv.slice(i+1); });
  if(q.l==='a') state.lens='arrests';
  if(q.w==='m') state.law=0; else if(q.w==='v') state.law=1;
  if(q.m && ['count','rate','share','ratio'].includes(q.m)) state.metric=q.m;
  if(q.y!=null){ const y=+q.y; if(DATA.years.includes(y)) state.year=y; }
  if(q.p!=null){ const p=+q.p; if(DATA.precincts.some(x=>x.pct===p)) state.precinct=p; }
  if(q.o!=null){ state.offsel.clear();
    q.o.split('.').forEach(id=>{ const i=+id; if(i>=0&&i<DATA.offenses.length) state.offsel.add(i); });
    if(state.offsel.size===0) DATA.offenses.forEach((o,i)=>state.offsel.add(i)); }
}
function setSeg(id,v){ const el=document.getElementById(id); if(!el) return;
  [...el.children].forEach(c=>c.setAttribute('aria-checked', c.dataset.v===String(v))); }
function syncControls(){
  setSeg('lensSeg', state.lens);
  setSeg('lawSeg', state.law==='all'?'all':state.law);
  setSeg('metricSeg', state.metric);
  document.getElementById('yearVal').textContent=yearLabel(state.year);
  const yj=document.getElementById('yearJump'); if(yj) yj.value=state.year;
  const dc=document.getElementById('detailClear'); if(dc) dc.style.display = state.precinct!=null?'inline-block':'none';
}
function copyLink(){
  writeHash(); const url=location.href;
  const m=document.getElementById('copyMsg');
  const ok=()=>{ if(m){ m.textContent='Link copied'; m.classList.add('show'); setTimeout(()=>m.classList.remove('show'),1800); } };
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok).catch(()=>prompt('Copy this link:',url));
  else prompt('Copy this link:',url);
}

/* ---------- CSV export (current lens / offense level / offense selection) ---------- */
function exportCSV(){
  const lens=state.lens;
  const pb={}; DATA.precincts.forEach(p=>pb[p.pct]=p.boro);
  const lawTxt = state.law==='all'?'misdemeanor+violation':(state.law===0?'misdemeanor':'violation');
  const agg={}; for(const r of DATA[lens]){ if(!passLaw(r)||!passSel(r)) continue; const k=r[1]+'|'+r[0]; agg[k]=(agg[k]||0)+r[4]; }
  const q=s=>`"${String(s==null?'':s).replace(/"/g,'""')}"`;
  const lines=[['precinct','neighborhood','borough','year','lens','offense_level','incidents','population','per_1000_residents'].join(',')];
  DATA.precincts.map(p=>p.pct).sort((a,b)=>a-b).forEach(p=>{
    DATA.years.forEach(y=>{ const c=agg[p+'|'+y]||0; const pop=popOf(''+p,y);
      const rate=(RATE_EXCLUDE.has(p)||!pop)?'':(c/pop*1000).toFixed(2);
      lines.push([p,q(nbhOf(p)),q(pb[p]||''),y,lens,q(lawTxt),c,(pop==null?'':pop),rate].join(',')); });
  });
  const blob=new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=`small-crimes_${lens}_${lawTxt.replace(/\+/g,'-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/* ---------- orchestration ---------- */
function renderYearDependent(){ renderMap(); renderKPIs(); renderRank(); renderStateBar();
  document.querySelectorAll('#yearBars .ybar').forEach(b=>b.classList.toggle('active', +b.dataset.y===state.year));
  if(state.precinct!=null) renderDetail(); }
function renderAll(){
  renderMap(); renderKPIs(); renderRank(); renderStateBar(); renderYearBars();
  renderGroupTrend(); renderCompare(); renderBoro(); renderTrendExplorer();
  if(state.precinct!=null) renderDetail();
}
window.addEventListener('resize', ()=>{ renderGroupTrend(); renderCompare(); renderBoro(); renderTrendExplorer(); if(state.precinct!=null) renderDetail(); });

/* ---------- play ---------- */
let _playTimer=null;
function setPlayIcon(on){ document.getElementById('playBtn').innerHTML = on?'&#10073;&#10073;':'&#9658;'; }
function stopPlay(){ if(_playTimer){ clearInterval(_playTimer); _playTimer=null; setPlayIcon(false); } }
function initPlay(){
  document.getElementById('playBtn').addEventListener('click',()=>{
    if(_playTimer){ stopPlay(); return; }
    if(state.year===2026) setYear(DATA.years[0]);   // restart if at the end
    setPlayIcon(true);
    _playTimer=setInterval(()=>{ const i=DATA.years.indexOf(state.year);
      if(i>=DATA.years.length-1){ stopPlay(); return; }   // pause at the end
      setYear(DATA.years[i+1]);
    },1050);
  });
}

/* ---------- guided tour ---------- */
let _tour=null;
function toggleTour(){ if(_tour){ endTour(); return; } startTour(); }
function endTour(){ if(_tour){ clearInterval(_tour); _tour=null; }
  document.getElementById('tourCap').classList.remove('show');
  document.getElementById('tourBtn').textContent='Take the tour →'; }
function startTour(){
  stopPlay();
  document.getElementById('tourBtn').textContent='✕ Stop tour';
  // reset to a clean state for the narrative
  document.querySelector('#metricSeg button[data-v="count"]').click();
  document.getElementById('map').scrollIntoView({block:'center'});
  const cap=document.getElementById('tourCap');
  const evByYear={}; EVENTS.forEach(e=>evByYear[e.year]=e.label);
  const intro={2015:'2015 — the start of the record. Watch the precincts pulse as a decade of low-level enforcement plays out.'};
  setYear(DATA.years[0]);
  const show=txt=>{ cap.innerHTML=txt; cap.classList.add('show'); };
  show(intro[2015]);
  _tour=setInterval(()=>{
    const i=DATA.years.indexOf(state.year);
    if(i>=DATA.years.length-1){ show('2026 — first quarter only. Scrub the bars or pick a precinct to keep exploring.'); clearInterval(_tour); _tour='done'; setTimeout(()=>{ if(_tour==='done') endTour(); },4000); return; }
    const ny=DATA.years[i+1]; setYear(ny);
    if(evByYear[ny]) show(`<b>${ny}</b> — ${evByYear[ny]}.`);
    else cap.classList.remove('show');
  },1700);
}
