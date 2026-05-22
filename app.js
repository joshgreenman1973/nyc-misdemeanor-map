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
  zero: { group:true, compare:true, boro:true },
  showEvents: true,
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
  document.getElementById('genDate').textContent = DATA.generated;
  DATA.offenses.forEach((o,i)=>state.offsel.add(i)); // default: all selected

  // year slider
  const ys=document.getElementById('yearSlider');
  ys.min=0; ys.max=DATA.years.length-1;
  state.year = 2025; ys.value = DATA.years.indexOf(2025);
  ys.addEventListener('input',()=>{ state.year=DATA.years[+ys.value]; document.getElementById('yearVal').textContent=yearLabel(state.year); renderYearDependent(); });
  document.getElementById('yearVal').textContent = yearLabel(state.year);

  // segmented controls
  seg('lensSeg', v=>{ state.lens=v; buildPicker(); renderAll(); });
  seg('lawSeg', v=>{ state.law = v==='all'?'all':+v; buildPicker(); renderAll(); });
  seg('metricSeg', v=>{ state.metric=v; renderMap(); });

  // offense picker
  document.getElementById('offSearch').addEventListener('input', buildPicker);
  document.querySelectorAll('.pickbtns button').forEach(b=>b.addEventListener('click',()=>{
    const k=b.dataset.pick;
    if(k==='all') DATA.offenses.forEach((o,i)=>state.offsel.add(i));
    else if(k==='none') state.offsel.clear();
    else { state.offsel.clear(); DATA.offenses.forEach((o,i)=>{ if(o.group===k) state.offsel.add(i); }); }
    buildPicker(); renderAll();
  }));

  // toggles
  bindTog('zeroGroup','group',renderGroupTrend);
  bindTog('zeroCompare','compare',renderCompare);
  bindTog('zeroBoro','boro',renderBoro);
  document.getElementById('showEvents').addEventListener('change',e=>{ state.showEvents=e.target.checked; renderGroupTrend(); renderCompare(); renderBoro(); });

  // events list
  document.getElementById('eventList').innerHTML = EVENTS.map(e=>`<span class="pill">${e.year}: ${e.label}</span>`).join('') +
    ' &mdash; shown as neutral reference lines only.';

  initMap();
  buildPicker();
  renderAll();
  initPlay();
}
function yearLabel(y){ return y===2026 ? '2026 (Q1)' : ''+y; }
function seg(id,cb){ const el=document.getElementById(id);
  el.addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return;
    [...el.children].forEach(c=>c.setAttribute('aria-pressed', c===b)); cb(b.dataset.v); }); }
function bindTog(id,key,fn){ document.getElementById(id).addEventListener('change',e=>{ state.zero[key]=e.target.checked; fn(); }); }

/* ---------- offense picker ---------- */
function buildPicker(){
  const q=(document.getElementById('offSearch').value||'').toLowerCase();
  const tot=offenseTotals(state.lens);
  const groups={proactive:[],victim:[],other:[]};
  DATA.offenses.forEach((o,i)=>{ if(q && !o.label.toLowerCase().includes(q)) return; groups[o.group].push(i); });
  let html='';
  ['proactive','victim','other'].forEach(g=>{
    if(!groups[g].length) return;
    html+=`<div class="offgrp"><span class="dot" style="background:${GCOL[g]}"></span>${GNAME[g]}<span class="info" data-tip="${GROUP_DEF[g]}">i</span></div>`;
    groups[g].sort((a,b)=>(tot[b]||0)-(tot[a]||0)).forEach(i=>{
      const o=DATA.offenses[i];
      html+=`<div class="offrow"><input type="checkbox" data-oid="${i}" ${state.offsel.has(i)?'checked':''}>
        <label data-oid="${i}">${o.label}</label><span class="c">${fmt(tot[i]||0)}</span></div>`;
    });
  });
  const wrap=document.getElementById('offWrap'); wrap.innerHTML=html||'<div class="detailempty">No offenses match.</div>';
  wrap.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change',()=>{
    const i=+cb.dataset.oid; cb.checked?state.offsel.add(i):state.offsel.delete(i); renderAll();
  }));
  wrap.querySelectorAll('label[data-oid]').forEach(l=>l.addEventListener('click',()=>{
    const i=+l.dataset.oid; const cb=wrap.querySelector(`input[data-oid="${i}"]`); cb.checked=!cb.checked;
    cb.checked?state.offsel.add(i):state.offsel.delete(i); renderAll();
  }));
}

/* ---------- map ---------- */
function initMap(){
  map = L.map('map',{scrollWheelZoom:true, zoomControl:true}).setView([40.705,-73.93],10);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',{
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
        click:()=>{ state.precinct=p; renderDetail(); highlightSelected(); }
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
  if(info.max<=0) return RAMP[0];
  for(let i=0;i<_scale.breaks.length;i++){ if(v<=_scale.breaks[i]) return RAMP[i]; }
  return RAMP[RAMP.length-1];
}
function computeBreaks(info){
  if(info.kind!=='count'){ _scale={breaks:[]}; return; }
  const arr=Object.values(info.vals).filter(v=>v>0).sort((a,b)=>a-b);
  const breaks=[];
  for(let i=1;i<=RAMP.length;i++){ const q=arr.length?arr[Math.min(arr.length-1,Math.floor(arr.length*i/RAMP.length))]:0; breaks.push(q); }
  _scale={breaks,max:info.max};
}
function renderMap(){
  const info=mapValues(); computeBreaks(info); _mapInfo=info;
  for(const p in byPctLayer) restyleOne(p, info);
  document.getElementById('mapTitle').textContent =
    info.kind==='share' ? 'Enforcement-sensitive share of incidents, by precinct'
    : info.kind==='ratio' ? 'Complaint-to-arrest ratio, by precinct'
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
  if(info.kind==='share')
    return `<b>How to read this</b>Each precinct is shaded by the <strong>share of its incidents that are enforcement-sensitive</strong> — proactively policed offenses like drugs, trespass and fare evasion, as opposed to victim-reported ones. <span style="color:var(--hot)"><strong>Red</strong></span> = a bigger slice is officer-initiated; <span style="color:var(--cool)"><strong>blue</strong></span> = more is victim-reported. A 40% precinct means 40 of every 100 recorded incidents were enforcement-sensitive.`;
  const c=(info.center||1).toFixed(1);
  return `<b>How to read this</b>Each precinct's <strong>complaints divided by its arrests</strong>, using both datasets at once (the lens toggle is ignored here). Citywide there are about <strong>${c} complaints for every arrest</strong>, so the color scale is centered on ${c}×, not on 1. <span style="color:var(--hot)"><strong>Redder</strong></span> precincts make more arrests relative to what residents report (enforcement-heavy); <span style="color:var(--cool)"><strong>bluer</strong></span> precincts report more than police act on. Example: a precinct at 4× logs four complaints for each arrest — more complaint-heavy than the city; one at 1.5× is more arrest-heavy.`;
}
let _mapInfo=null;
function restyleOne(p, info){ info=info||_mapInfo; if(!info||!byPctLayer[p]) return;
  const v=info.vals[p]; byPctLayer[p].setStyle({fillColor:colorFor(v,info), weight:0.6, color:'#4a4234', fillOpacity:0.9}); }
function highlightSelected(){ if(state.precinct!=null && byPctLayer[state.precinct]){
  const l=byPctLayer[state.precinct]; l.setStyle({weight:2.6,color:'#fae6b0'}); l.bringToFront(); } }
function mapNoteText(info){
  const law = state.law==='all'?'misdemeanors + violations':(state.law===0?'misdemeanors only':'violations only');
  const sel = state.offsel.size===DATA.offenses.length?'all offenses':`${state.offsel.size} selected offense type(s)`;
  if(info.kind==='ratio') return `Both lenses · ${law} · ${sel} · ${yearLabel(state.year)}. <strong>Blue</strong> = more complaints than arrests (reporting outpaces enforcement); <strong style="color:var(--hot)">red</strong> = more arrests than complaints (enforcement-heavy). Lens toggle is ignored here.`;
  const lens = state.lens==='complaints'?'complaints (reported)':'arrests (enforcement)';
  if(info.kind==='share') return `${lens} · ${law} · share computed over all offenses · ${yearLabel(state.year)}`;
  return `${lens} · ${law} · ${sel} · ${yearLabel(state.year)}`;
}
function rampDiv(arr){ return arr.map(c=>`<span style="background:${c}"></span>`).join(''); }
function renderLegend(info){
  const el=document.getElementById('legend'); let cap,ramp,lbls;
  if(info.kind==='share'){ cap='Enforcement-sensitive share'; ramp=rampDiv(RAMP_SHARE);
    lbls='<span>0% · complaint areas</span><span>50%</span><span>100% · enforcement-heavy</span>'; }
  else if(info.kind==='ratio'){ const c=(info.center||1);
    cap=`Complaints per arrest · city average ${c.toFixed(1)}× (centered)`; ramp=rampDiv(RAMP_RATIO);
    lbls='<span>more arrest-heavy</span><span>city average</span><span>more complaint-heavy</span>'; }
  else { const b=_scale.breaks; cap='Incidents, '+yearLabel(state.year); ramp=rampDiv(RAMP);
    lbls=`<span>0</span><span>${fmt(b[Math.floor(b.length/2)]||0)}</span><span>${fmt(info.max||0)}</span>`; }
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
  else { body=`${fmt((info&&info.vals[p])||0)} incidents`; }
  tip.innerHTML=`<strong>Precinct ${p}</strong> · ${meta.boro}<br>${body}<br><span style="opacity:.6">${yearLabel(state.year)} · click for detail</span>`;
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
        + ig('<strong>Top precinct</strong><br>The precinct with the most recorded incidents for your current selection (lens, offense level and offenses), this year.'),
      topP?('#'+topP):'—', topP?(boro+' · '+fmt(topV)+' incidents'):'', null, '#b08328');
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
  let s=`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-el="${elId}">`;
  // y gridlines
  const ticks=4; for(let i=0;i<=ticks;i++){ const val=lo+(hi-lo)*i/ticks; const yy=Y(val);
    s+=`<line class="gridline" x1="${m.l}" x2="${W-m.r}" y1="${yy}" y2="${yy}"/>`;
    s+=`<text class="axislab" x="${m.l-6}" y="${yy+3}" text-anchor="end">${fmt(Math.round(val))}</text>`; }
  // x labels
  years.forEach(y=>{ if(y%2===1 && y!==xmax) return; s+=`<text class="axislab" x="${X(y)}" y="${H-8}" text-anchor="middle">${y===2026?"'26 Q1":"'"+String(y).slice(2)}</text>`; });
  // events
  if(state.showEvents && opt.events!==false){ EVENTS.forEach(e=>{ const xx=X(e.year);
    s+=`<line class="evline" x1="${xx}" x2="${xx}" y1="${m.t}" y2="${H-m.b}"/>`;
    s+=`<text class="evlab" x="${xx+3}" y="${m.t+9}" >${e.year}</text>`; }); }
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
}

/* ---------- ranking ---------- */
function renderRank(){
  const pp=perPrecinct(state.year); const pb={}; DATA.precincts.forEach(p=>pb[p.pct]=p.boro);
  const arr=Object.entries(pp).map(([p,v])=>({p:+p,v,boro:pb[p]})).sort((a,b)=>b.v-a.v);
  const max=arr.length?arr[0].v:1;
  document.getElementById('rankNote').textContent = `${state.lens}, ${yearLabel(state.year)} — top 15 of ${arr.length} precincts for the current selection.`;
  let h='<table class="rank"><tr><th>#</th><th>Precinct</th><th>Borough</th><th style="text-align:right">Incidents</th><th></th></tr>';
  arr.slice(0,15).forEach((r,i)=>{ h+=`<tr style="cursor:pointer" data-p="${r.p}"><td>${i+1}</td><td>#${r.p}</td><td>${r.boro}</td>
    <td class="n">${fmt(r.v)}</td><td style="width:34%"><span class="bar" style="width:${Math.max(2,r.v/max*100)}%;background:${BORO_COL[r.boro]||'#c1432f'}"></span></td></tr>`; });
  h+='</table>';
  const t=document.getElementById('rankTable'); t.innerHTML=h;
  t.querySelectorAll('tr[data-p]').forEach(tr=>tr.addEventListener('click',()=>{ state.precinct=+tr.dataset.p; renderDetail(); highlightSelected();
    if(byPctLayer[state.precinct]) map.fitBounds(byPctLayer[state.precinct].getBounds(),{maxZoom:13,padding:[40,40]}); }));
}

/* ---------- precinct detail ---------- */
function renderDetail(){
  const p=state.precinct; if(p==null) return;
  const meta=DATA.precincts.find(x=>x.pct===p)||{boro:''};
  document.getElementById('detailTitle').textContent=`Precinct ${p} · ${meta.boro}`;
  // trend for current selection at this precinct
  const ser={}; for(const r of rows()){ if(r[1]!==p||!passLaw(r)||!passSel(r)) continue; ser[r[0]]=(ser[r[0]]||0)+r[4]; }
  // top offenses this year at this precinct
  const yr=state.year; const off={};
  for(const r of rows()){ if(r[1]!==p||r[0]!==yr||!passLaw(r)) continue; off[r[2]]=(off[r[2]]||0)+r[4]; }
  const top=Object.entries(off).map(([o,v])=>({o:+o,v})).sort((a,b)=>b.v-a.v).slice(0,8);
  const tmax=top.length?top[0].v:1;
  // enforcement share at precinct this year
  let pro=0,tot=0; for(const r of rows()){ if(r[1]!==p||r[0]!==yr||!passLaw(r)) continue; tot+=r[4]; if(G(r[2])==='proactive') pro+=r[4]; }
  let h=`<div class="note">Enforcement-sensitive share in ${yearLabel(yr)}: <strong>${pct1(tot?pro/tot:0)}</strong> · ${fmt(tot)} total incidents (${state.lens})</div>`;
  h+='<div id="detTrend"></div>';
  h+=`<h3 style="margin-top:10px;font-size:13px">Top offenses, ${yearLabel(yr)}</h3><table class="rank">`;
  top.forEach(t=>{ const o=DATA.offenses[t.o]; h+=`<tr><td><span class="pill" style="border-color:${GCOL[o.group]};color:${GCOL[o.group]};cursor:help" data-tip="${GROUP_DEF[o.group]}">${GNAME[o.group][0]}</span></td>`
    + `<td>${o.label}</td><td class="n">${fmt(t.v)}</td><td style="width:36%"><span class="bar" style="width:${Math.max(2,t.v/tmax*100)}%;background:${GCOL[o.group]}"></span></td></tr>`; });
  h+='</table>';
  const body=document.getElementById('detailBody'); body.innerHTML=h;
  lineChart('detTrend',[toSeries(ser,'Precinct '+p+' (current selection)','#1b1b1a')],{zero:true,height:170,events:true});
}

/* ---------- orchestration ---------- */
function renderYearDependent(){ renderMap(); renderKPIs(); renderRank(); if(state.precinct!=null) renderDetail(); }
function renderAll(){
  renderMap(); renderKPIs(); renderRank();
  renderGroupTrend(); renderCompare(); renderBoro();
  if(state.precinct!=null) renderDetail();
}
window.addEventListener('resize', ()=>{ renderGroupTrend(); renderCompare(); renderBoro(); if(state.precinct!=null) renderDetail(); });

/* ---------- play ---------- */
function initPlay(){
  let timer=null; const btn=document.getElementById('playBtn'); const ys=document.getElementById('yearSlider');
  btn.addEventListener('click',()=>{
    if(timer){ clearInterval(timer); timer=null; btn.innerHTML='&#9658;'; return; }
    btn.innerHTML='&#10073;&#10073;';
    timer=setInterval(()=>{ let v=+ys.value+1; if(v>+ys.max) v=0; ys.value=v;
      state.year=DATA.years[v]; document.getElementById('yearVal').textContent=yearLabel(state.year); renderYearDependent();
    },1100);
  });
}
