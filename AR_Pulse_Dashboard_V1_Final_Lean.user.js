// ==UserScript==
// @name         AR Performance Dashboard V1
// @namespace    http://tampermonkey.net/
// @version      V1.1-night-shift-date-fix
// @description  AR Performance Dashboard V1.1: AR/WHD dashboard with night-shift two-date scan gap fix.
// @author       Jenish
// @match        https://fclm-portal.amazon.com/reports/timeOnTask*
// @require      https://ekarulf.corp.amazon.com/js/jquery-1.12.4.min.js
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      fcresearch-fe.aka.amazon.com
// @connect      www.amazon.com.au
// @connect      amazon.com.au
// @connect      badgephotos.corp.amazon.com
// @downloadURL https://raw.githubusercontent.com/jenishdhl/AR-Performance-DB/main/AR_Pulse_Dashboard_V1_Final_Lean.user.js
// @updateURL   https://raw.githubusercontent.com/jenishdhl/AR-Performance-DB/main/AR_Pulse_Dashboard_V1_Final_Lean.user.js
// ==/UserScript==

(function () {
  'use strict';
  const SHIFTS = {
    night: {
      label: 'Night Shift',
      shiftStart: '18:15', shiftEnd: '04:15',
      breaks: [
        { label: '1st', start: '20:45', end: '21:00' },
        { label: '2nd', start: '23:15', end: '23:45' },
        { label: '3rd', start: '02:15', end: '02:30' },
      ],
    },
    day: {
      label: 'Day Shift',
      shiftStart: '08:00', shiftEnd: '18:00',
      breaks: [
        { label: '1st', start: '10:30', end: '10:45' },
        { label: '2nd', start: '13:00', end: '13:30' },
        { label: '3rd', start: '16:00', end: '16:15' },
      ],
    },
  };

  const EARLY_TOL = 1;
  const LATE_TOL  = 4;
  const WHD = {
    PROCESS_ID:    '1002979',
    UPH_TARGET:     9.61,
    GAP_MIN:        7,
    STAGGER_MS:     300,
    FC_RESEARCH:   'https://fcresearch-fe.aka.amazon.com/AVV4/results',
  };

  let activeShift   = 'night';
  let whdModeActive = false;
  let _jphCache     = null;
  let _whdRollup    = null;  // Map: empId → { uph, units, hrs, smUph, mdUph, lgUph }
  let _pprWHDMetrics = null; // PPR Warehouse Deals Total: actual vs plan TPH + support hours
  const allRows     = [];
  let pendingRequests = 0;
  function detectShift() {
    const el = document.getElementById('startHourIntraday');
    const h  = el ? parseInt(el.value, 10)
                  : parseInt((location.search.match(/startHourIntraday=(\d+)/) || [])[1] || '18', 10);
    activeShift = (h >= 6 && h < 14) ? 'day' : 'night';
    return activeShift;
  }
  function abbreviate(title) {
    const parts = title.split('♦');
    const main = parts[0].trim(), sub = parts[1] ? parts[1].trim() : '';
    if (/c-?returns?/i.test(main)) {
      if (/lead|\/\s*pa/i.test(sub))               return 'PA';
      if (/prob.*solve|problem.*solv/i.test(sub))   return 'Problem Solve';
      if (/audit/i.test(sub))                       return 'Audit';
      if (/refurb/i.test(sub))                      return 'Refurbish';
      if (/unload|pit/i.test(sub))                  return 'PIT';
      if (/ambass/i.test(sub))                      return 'Learning Ambassador';
      if (/customer\s*returns?/i.test(sub))         return 'CRET';
      if (/water\s*spider/i.test(sub))              return 'CRET WSpider';
      if (/stow/i.test(sub))                        return 'CRET Stow';
      if (/training/i.test(sub))                    return 'CRET Training';
      if (/support/i.test(sub))                     return 'CRET Support';
      return sub ? `CRET ${sub}` : 'CRET';
    }
    if (/v-?returns?/i.test(main)) {
      if (/ambass/i.test(sub))          return 'Learning Ambassador';
      if (/water\s*spider/i.test(sub))  return 'VRET WSpider';
      if (/pick/i.test(sub))            return 'VRET Pick';
      if (/pack/i.test(sub))            return 'VRET Pack';
      if (/support/i.test(sub))         return 'VRET Support';
      return sub ? `VRET ${sub}` : 'VRET';
    }
    if (/whd\s*grading|wd\s*grading/i.test(main)) return 'AR';
    if (/admin\s*[\/\\]\s*hr|ops_?regional/i.test(main)) {
      if (/waste/i.test(sub))                            return 'Waste';
      if (/ops_?regional|regional.*project/i.test(sub)) return 'Global';
      if (/ops_?emp|emp.*engage|engagement/i.test(sub)) return 'Engagement';
      if (/ww_?huddle|working.*well/i.test(sub))        return 'Working Well Huddle';
      if (sub) return sub.replace(/^[A-Z0-9_]+[♦>]\s*/i, '').trim() || sub;
      return 'Admin';
    }
    if (/ic-?qa|icqa/i.test(main)) return 'ICQA';
    return (sub ? `${main} > ${sub}` : main).replace(/ambass\w*/gi, 'Learning Ambassador');
  }
  function toMin(hhmm) { const [h,m]=hhmm.split(':').map(Number); return h*60+m; }
  function parseSegTime(raw) {
    if (!raw) return null;
    const m = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    return m ? Number(m[1])*60 + Number(m[2]) + (Number(m[3]||0)/60) : null;
  }
  function parseSegDay(raw) {
    if (!raw) return null;
    const m = raw.match(/\d{2}\/(\d{2})/);
    return m ? Number(m[1]) : null;
  }
  function toAbsolute(minOfDay, day, baseDay) { return (day-baseDay)*1440 + minOfDay; }

  // WHD activity details can cover two dates on night shift, e.g. 18:15 on 05/12 to 04:15 on 05/13.
  // For quarter/gap logic we normalise by shift clock time, not by first scanned date.
  // Night shift times after midnight (00:00-04:15) must be treated as 24:00+ minutes.
  function scanTimeToShiftAbs(minOfDay) {
    const m = Number(minOfDay);
    if (!Number.isFinite(m)) return 0;
    if (activeShift === 'night' && m < 720) return m + 1440;
    return m;
  }

  function absToHHMM(absMin) {
    const m = ((Math.floor(absMin)%1440)+1440)%1440;
    return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
  }
  function fmtMins(mins) {
    mins = Math.round(mins);
    if (mins<60) return mins+'m';
    const h=Math.floor(mins/60), m=mins%60;
    return m>0 ? `${h}h ${m}m` : `${h}h`;
  }
  function calcIdleHours(doc) {
    let total=0, found=false;
    doc.querySelectorAll('tr').forEach(tr => {
      if (!tr.className.includes('function-seg')||!tr.className.includes('indirect')) return;
      const tds=tr.querySelectorAll('td'); if (tds.length<4) return;
      const title=tds[0]?.textContent?.trim()||'';
      if (/admin.*hr|hr.*it|ops_emp/i.test(title)) return;
      const raw=tds[3]?.textContent?.trim(); if (!raw) return;
      const parts=raw.split(':').map(Number);
      if (parts.length<2||isNaN(parts[0])||isNaN(parts[1])) return;
      total+=parts[0]*60+parts[1]; found=true;
    });
    return found ? parseFloat((total/3600).toFixed(2)) : null;
  }
  function fetchJPH(empPageUrl, cb) {
    const empIdMatch = empPageUrl.match(/employeeId=(\d+)/);
    if (!empIdMatch) { cb(null); return; }
    const empId=empIdMatch[1];
    const startDate=document.getElementById('startDateIntraday')?.value||'';
    const endDate=document.getElementById('endDateIntraday')?.value||'';
    const whId=document.getElementById('warehouseId')?.value||'AVV4';
    const startHour=document.getElementById('startHourIntraday')?.value||'18';
    const endHour=document.getElementById('endHourIntraday')?.value||'4';
    const minMap=['00','15','30','45'];
    const startMinVal=minMap[document.getElementById('startMinuteIntraday')?.selectedIndex??1]||'15';
    const endMinVal=minMap[document.getElementById('endMinuteIntraday')?.selectedIndex??1]||'15';
    const CRET_PROCESS_ID='1003026';
    const enc=encodeURIComponent;
    const rollupUrl=`https://fclm-portal.amazon.com/reports/functionRollup?warehouseId=${enc(whId)}&processId=${enc(CRET_PROCESS_ID)}&spanType=Intraday&startDateIntraday=${enc(startDate)}&startHourIntraday=${enc(startHour)}&startMinuteIntraday=${enc(startMinVal)}&endDateIntraday=${enc(endDate)}&endHourIntraday=${enc(endHour)}&endMinuteIntraday=${enc(endMinVal)}&reportFormat=HTML`;
    if (_jphCache && !_jphCache.fetching && _jphCache.url===rollupUrl) { cb(_jphCache.data.get(empId)||null); return; }
    if (_jphCache && _jphCache.fetching && _jphCache.url===rollupUrl) { _jphCache.pending.push({empId,cb}); return; }
    _jphCache={url:rollupUrl,fetching:true,data:new Map(),pending:[{empId,cb}]};
    GM_xmlhttpRequest({ method:'GET', url:rollupUrl,
      onload: res => {
        try {
          const doc=new DOMParser().parseFromString(res.responseText,'text/html');
          doc.querySelectorAll('table tr').forEach(tr => {
            const tds=[...tr.querySelectorAll('td')]; if (!tds.length) return;
            let rowId=null;
            for (const td of tds) {
              const txt=(td.querySelector('a')?.textContent||td.textContent).trim();
              if (/^\d{9,}$/.test(txt)){rowId=txt;break;}
            }
            if (!rowId) return;
            const cols=tds.map(td=>td.textContent.trim());
            _jphCache.data.set(rowId,{total:cols[10]||'—',uphS:cols[12]||'—',uphM:cols[14]||'—',uphL:cols[16]||'—'});
          });
        } catch(e){console.error('[BPC JPH]',e);}
        _jphCache.fetching=false;
        _jphCache.pending.forEach(({empId:eid,cb:c})=>c(_jphCache.data.get(eid)||null));
        _jphCache.pending=[];
      },
      onerror:()=>{_jphCache.fetching=false;_jphCache.pending.forEach(({cb:c})=>c(null));_jphCache.pending=[];}
    });
  }
  function fetchActivityDetails(empUrl, cb) {
    let actUrl=null;
    try {
      const u=new URL(empUrl);
      u.pathname=u.pathname.replace(/ppaTimeDetails/i,'activityDetails').replace(/timeDetails/i,'activityDetails');
      u.searchParams.set('reportFormat','HTML');
      actUrl=u.toString();
    } catch(e){cb(null);return;}
    GM_xmlhttpRequest({ method:'GET', url:actUrl,
      onload: res => {
        try {
          const doc=new DOMParser().parseFromString(res.responseText,'text/html');
          const counts={S:0,M:0,L:0};
          let rowsFound=0;
          doc.querySelectorAll('table tr').forEach(tr=>{
            const tds=tr.querySelectorAll('td'); if (tds.length<5) return;
            const tool=tds[0]?.textContent?.trim();
            const jobAction=tds[1]?.textContent?.trim();
            const size=tds[3]?.textContent?.trim();
            const qty=parseInt(tds[4]?.textContent?.trim(),10);
            rowsFound++;
            if (!/CReturn/i.test(tool)) return;
            if (!/shipment.*returned/i.test(jobAction)) return;
            if (isNaN(qty)) return;
            if (/small/i.test(size)) counts.S+=qty;
            if (/medium/i.test(size)) counts.M+=qty;
            if (/large/i.test(size)) counts.L+=qty;
          });
          counts._rowsFound=rowsFound;
          cb(counts);
        } catch(e){cb(null);}
      },
      onerror:()=>cb(null),
    });
  }

  function parseCSVLine(line) {
    const cols=[]; let cur='', inQ=false;
    for (let i=0;i<line.length;i++) {
      const ch=line[i];
      if (ch==='"' && line[i+1]==='"') { cur+='"'; i++; continue; }
      if (ch==='"') { inQ=!inQ; continue; }
      if (ch===',' && !inQ) { cols.push(cur.trim()); cur=''; continue; }
      cur+=ch;
    }
    cols.push(cur.trim());
    return cols;
  }

  function normText(v) { return String(v||'').replace(/"/g,'').trim(); }
  function normSize(v) {
    const s=normText(v).toLowerCase();
    if (/^(s|small)\b/.test(s)) return 'Small';
    if (/^(m|medium)\b/.test(s)) return 'Medium';
    if (/^(l|large)\b/.test(s)) return 'Large';
    if (/non.?sort|bulky|oversize|oversized|heavy/.test(s)) return 'Large';
    if (s.includes('total')) return 'Total';
    return normText(v);
  }

  function hydratePerfWithScans(perf, scans) {
    const out = Object.assign({uph:0,units:0,hrs:0,smUph:0,mdUph:0,lgUph:0,smU:0,mdU:0,lgU:0}, perf || {});
    const scanCounts = {Small:0, Medium:0, Large:0};
    (scans||[]).forEach(s => {
      const sz = normSize(s.size);
      const qty = Number(s.qty || 1) || 1;
      if (sz === 'Small') scanCounts.Small += qty;
      else if (sz === 'Medium') scanCounts.Medium += qty;
      else if (sz === 'Large') scanCounts.Large += qty;
    });
    if (!out.smU && scanCounts.Small) out.smU = scanCounts.Small;
    if (!out.mdU && scanCounts.Medium) out.mdU = scanCounts.Medium;
    if (!out.lgU && scanCounts.Large) out.lgU = scanCounts.Large;
    if (!out.units) out.units = (out.smU||0) + (out.mdU||0) + (out.lgU||0) || (scans||[]).filter(s=>s.asin).length;
    return out;
  }

  function getSizeCounts(d) {
    const perf = d?.perf || {};
    const counts = {small: Number(perf.smU||0), medium: Number(perf.mdU||0), large: Number(perf.lgU||0)};
    if (!counts.small && !counts.medium && !counts.large) {
      (d?.scanList||[]).forEach(s => {
        const qty = Number(s.qty||1)||1;
        const sz = normSize(s.size);
        if (sz === 'Small') counts.small += qty;
        else if (sz === 'Medium') counts.medium += qty;
        else if (sz === 'Large') counts.large += qty;
      });
    }
    return counts;
  }
  function fetchWHDRollup(cb) {
    if (_whdRollup) { cb(_whdRollup); return; }
    const p=new URLSearchParams(location.search), enc=encodeURIComponent;
    const wh=p.get('warehouseId')||'AVV4';
    const url=`https://fclm-portal.amazon.com/reports/functionRollup?reportFormat=CSV&warehouseId=${enc(wh)}&processId=${WHD.PROCESS_ID}&spanType=Intraday&startDateIntraday=${enc(p.get('startDateIntraday')||'')}&startHourIntraday=${enc(p.get('startHourIntraday')||'8')}&startMinuteIntraday=${enc(p.get('startMinuteIntraday')||'0')}&endDateIntraday=${enc(p.get('endDateIntraday')||'')}&endHourIntraday=${enc(p.get('endHourIntraday')||'18')}&endMinuteIntraday=${enc(p.get('endMinuteIntraday')||'0')}`;
    GM_xmlhttpRequest({ method:'GET', url,
      onload: res => {
        const map=new Map();
        if (res.status!==200){cb(map);return;}
        const lines=res.responseText.trim().split('\n');
        if (lines.length<2){cb(map);return;}
        const hdrs=lines[0].split(',').map(h=>h.replace(/"/g,'').trim().toLowerCase());
        const I={
          id:   hdrs.findIndex(h=>h.includes('employee id')),
          fn:   hdrs.findIndex(h=>h.includes('function name')),
          act:  hdrs.findIndex(h=>h.includes('job action')),
          size: hdrs.findIndex(h=>h==='size'),
          units:hdrs.findIndex(h=>h==='units'),
          uph:  hdrs.findIndex(h=>h==='uph'),
          jobs: hdrs.findIndex(h=>h==='jobs'),
          hrs:  hdrs.findIndex(h=>h.includes('paid hours')&&h.includes('total')),
        };
        lines.slice(1).forEach(line=>{
          const cols=parseCSVLine(line);
          const g=i=>(i>=0&&cols[i])?normText(cols[i]):'';
          const n=i=>{const v=parseFloat(g(i));return isNaN(v)?0:v;};
          if(!/WD\s*Grading/i.test(g(I.fn)))return;
          const id=g(I.id); if(!id)return;
          if(!map.has(id))map.set(id,{uph:0,units:0,hrs:0,smUph:0,mdUph:0,lgUph:0,smU:0,mdU:0,lgU:0});
          const d=map.get(id),act=g(I.act),sz=normSize(g(I.size));
          if(/ItemGraded/i.test(act)&&sz==='Total'){d.uph=n(I.uph);d.units=n(I.units);d.hrs=n(I.hrs);}
          if(/ItemGraded/i.test(act)&&sz==='Small') { d.smUph=n(I.uph); d.smU=n(I.units); }
          if(/ItemGraded/i.test(act)&&sz==='Medium'){ d.mdUph=n(I.uph); d.mdU=n(I.units); }
          if(/ItemGraded/i.test(act)&&sz==='Large') { d.lgUph=n(I.uph); d.lgU=n(I.units); }
        });
        _whdRollup=map; cb(map);
      },
      onerror:()=>cb(new Map()),
    });
  }
  function pprNum(v) {
    const raw = String(v ?? '').replace(/,/g, '').replace(/%/g, '').trim();
    if (!raw || raw === '—' || raw === '-') return 0;
    const m = raw.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }

  function pprNorm(v) {
    return String(v || '').replace(/\s+/g, ' ').trim();
  }

  function buildProcessPathRollupUrl() {
    const p = new URLSearchParams(location.search);
    const enc = encodeURIComponent;
    const wh = document.getElementById('warehouseId')?.value || p.get('warehouseId') || 'AVV4';
    const startDate = document.getElementById('startDateIntraday')?.value || p.get('startDateIntraday') || '';
    const endDate = document.getElementById('endDateIntraday')?.value || p.get('endDateIntraday') || startDate;
    const startHour = document.getElementById('startHourIntraday')?.value || p.get('startHourIntraday') || '18';
    const endHour = document.getElementById('endHourIntraday')?.value || p.get('endHourIntraday') || '4';
    const minMap = ['0','15','30','45'];
    const startMinute = p.get('startMinuteIntraday') || minMap[document.getElementById('startMinuteIntraday')?.selectedIndex ?? 1] || '15';
    const endMinute = p.get('endMinuteIntraday') || minMap[document.getElementById('endMinuteIntraday')?.selectedIndex ?? 1] || '15';
    return `https://fclm-portal.amazon.com/reports/processPathRollup?reportFormat=HTML&warehouseId=${enc(wh)}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${enc(startDate)}&startHourIntraday=${enc(startHour)}&startMinuteIntraday=${enc(startMinute)}&endDateIntraday=${enc(endDate)}&endHourIntraday=${enc(endHour)}&endMinuteIntraday=${enc(endMinute)}&adjustPlanHours=true&_adjustPlanHours=on&hideEmptyLineItems=true&_hideEmptyLineItems=on&_rememberViewForWarehouse=on&employmentType=AllEmployees&startHourIntraday1=0&startMinuteIntraday1=0&startHourIntraday2=0&startMinuteIntraday2=0&startHourIntraday3=0&startMinuteIntraday3=0&startHourIntraday4=0&startMinuteIntraday4=0`;
  }

  function parsePPRTable(doc) {
    const tables = [...doc.querySelectorAll('table')];
    let best = null;
    for (const table of tables) {
      const text = table.textContent || '';
      // Prefer the actual final PPR table that contains Warehouse Deals rows.
      if (/Warehouse\s+Deals/i.test(text) && /(Actual|Plan|Rate|TPH|Hours)/i.test(text)) { best = table; break; }
      if (!best && /Warehouse\s+Deals|WD\s+Grading|WHD\s+Grading/i.test(text)) best = table;
    }
    if (!best) return { headers: [], rows: [] };

    const trs = [...best.querySelectorAll('tr')];
    let headerIndex = trs.findIndex(tr => {
      const h = [...tr.querySelectorAll('th,td')].map(x => pprNorm(x.textContent).toLowerCase()).join(' | ');
      return /(process|path|function|name)/i.test(h) && /(actual|plan|rate|tph|hours)/i.test(h);
    });
    if (headerIndex < 0) headerIndex = trs.findIndex(tr => /actual|plan|rate|tph|hours|support/i.test(tr.textContent || ''));
    const headers = headerIndex >= 0 ? [...trs[headerIndex].querySelectorAll('th,td')].map(x => pprNorm(x.textContent).toLowerCase()) : [];
    const rows = [];
    trs.forEach((tr, idx) => {
      if (idx === headerIndex) return;
      const cells = [...tr.querySelectorAll('td,th')].map(td => pprNorm(td.textContent));
      if (cells.length < 2) return;
      const text = cells.join(' | ');
      if (!/Warehouse\s+Deals|WD\s+Grading|WHD\s+Grading|Support/i.test(text)) return;
      rows.push({ cells, text });
    });
    return { headers, rows };
  }

  function findPPRCol(headers, options) {
    const h = headers.map(x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g,' '));
    for (const opt of options) {
      const idx = h.findIndex(name => opt.every(re => re.test(name)));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function valueFromPPRRow(row, headers, options) {
    const idx = findPPRCol(headers, options);
    if (idx >= 0 && row.cells[idx] != null) return pprNum(row.cells[idx]);
    return 0;
  }

  function firstPPRRow(rows, patterns) {
    return rows.find(r => patterns.every(re => re.test(r.text))) || null;
  }

  function numsFromPPRRow(row) {
    return (row?.cells || [])
      .map(c => pprNum(c))
      .filter(n => Number.isFinite(n) && n !== 0);
  }

  function fallbackActualTPHFromFinalRow(row) {
    // Last-resort fallback only. PPR columns can change by site/view, but the final Warehouse Deals row
    // usually contains units/hours/rate values. Prefer a realistic rate-like value over units/hours.
    const nums = numsFromPPRRow(row);
    const plausibleRates = nums.filter(n => n > 0 && n < 500);
    return plausibleRates.length ? plausibleRates[plausibleRates.length - 1] : 0;
  }

  function fallbackHoursFromRow(row) {
    const nums = numsFromPPRRow(row);
    return nums.find(n => n > 0 && n < 1000) || 0;
  }

  function parsePPRWHDMetrics(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
    const num = v => {
      const m = clean(v).replace(/,/g, '').replace(/%/g, '').match(/-?\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : 0;
    };
    const cellText = (row, selector, fallbackIdx) => {
      const bySelector = selector ? row.querySelector(selector) : null;
      if (bySelector) return clean(bySelector.textContent);
      const cells = [...row.querySelectorAll('td,th')];
      return cells[fallbackIdx] ? clean(cells[fallbackIdx].textContent) : '';
    };
    const fail = (reason, extra={}) => ({
      ok:false, reason, url: buildProcessPathRollupUrl(),
      actualTPH:0, planTPH:0, tphGap:0,
      actualHours:0, planHours:0, actualUnits:0, planUnits:0,
      plannedSupportHours:0, actualSupportHours:0, supportGap:0,
      ratioToPlan:0, timeAtPlanRate:0, planVarianceHours:0,
      source:'PPR Warehouse Deals - Total exact row', ...extra
    });

    // Exact PPR row supplied by user. This is the official Warehouse Deals Total line.
    let row = doc.querySelector('tr#ppr\\.detail\\.reverseLogistics\\.whseDeals\\.whseDeals\\.total');
    if (!row) {
      row = [...doc.querySelectorAll('tr')].find(tr => /Warehouse\s+Deals\s*-\s*Total/i.test(clean(tr.textContent))) || null;
    }
    if (!row) return fail('Could not find exact Warehouse Deals - Total row in PPR.');

    // Column/class mapping from the PPR HTML row:
    // actualVolume=units, actualTimeSeconds=actual hours, actualProductivity=actual Rate,
    // planProductivity=planned Rate, timeAtPlanRateSeconds=planned/plan-rate hours,
    // planVarianceSeconds=hours difference, ratioToPlan=% to plan.
    const actualUnits = num(cellText(row, 'td.actualVolume', 2));
    const actualHours = num(cellText(row, 'td.actualTimeSeconds', 3));
    const actualTPH = num(cellText(row, 'td.actualProductivity', 4));
    const planTPH = num(cellText(row, 'td.planProductivity', 5));
    const planHours = num(cellText(row, 'td.timeAtPlanRateSeconds', 6));
    const planVarianceHours = num(cellText(row, 'td.planVarianceSeconds', 7));
    const ratioToPlan = num(cellText(row, 'td.ratioToPlan', 8));
    const planUnits = (planTPH && planHours) ? Math.round(planTPH * planHours) : 0;

    // In this PPR line, support/hours gap is effectively actual hours vs time at plan rate.
    // Positive means hours saved/ahead if PPR variance is positive; actual-plan can be negative.
    const supportGap = (actualHours || planHours) ? (actualHours - planHours) : 0;

    const ok = !!actualTPH;
    return {
      ok,
      reason: ok ? '' : 'Warehouse Deals - Total row found, but Actual Rate cell was blank/unreadable.',
      url: buildProcessPathRollupUrl(),
      actualTPH, planTPH,
      tphGap: (actualTPH && planTPH) ? actualTPH - planTPH : 0,
      actualHours, planHours, actualUnits, planUnits,
      plannedSupportHours: planHours,
      actualSupportHours: actualHours,
      supportGap,
      planVarianceHours,
      ratioToPlan,
      totalRowText: clean(row.textContent),
      source:'PPR Warehouse Deals - Total exact row'
    };
  }

  function fetchPPRWHDMetrics(cb) {
    if (_pprWHDMetrics) { cb(_pprWHDMetrics); return; }
    const url = buildProcessPathRollupUrl();
    GM_xmlhttpRequest({ method:'GET', url,
      onload: res => {
        try {
          _pprWHDMetrics = parsePPRWHDMetrics(res.responseText || '');
        } catch (e) {
          console.error('[BPC PPR parse]', e);
          _pprWHDMetrics = { ok:false, url, actualTPH:0, planTPH:0, plannedSupportHours:0, actualSupportHours:0, source:'PPR unavailable' };
        }
        cb(_pprWHDMetrics);
      },
      onerror: () => {
        _pprWHDMetrics = { ok:false, url, actualTPH:0, planTPH:0, plannedSupportHours:0, actualSupportHours:0, source:'PPR unavailable' };
        cb(_pprWHDMetrics);
      }
    });
  }

  function getPPRActualWHDTPH() { return Number(_pprWHDMetrics?.actualTPH || 0); }
  function getPPRPlanWHDTPH() { return Number(_pprWHDMetrics?.planTPH || 0); }
  function getPPRPlannedSupportHours() { return Number(_pprWHDMetrics?.plannedSupportHours || 0); }
  function getPPRActualSupportHours() { return Number(_pprWHDMetrics?.actualSupportHours || 0); }
  function fetchWHDScans(empUrl, cb) {
    let actUrl=null;
    try {
      const u=new URL(empUrl);
      u.pathname=u.pathname.replace(/ppaTimeDetails/i,'activityDetails').replace(/timeDetails/i,'activityDetails');
      u.searchParams.set('reportFormat','HTML');
      actUrl=u.toString();
    } catch(e){cb([]);return;}
    GM_xmlhttpRequest({ method:'GET', url:actUrl,
      onload: res => {
        try {
          const doc=new DOMParser().parseFromString(res.responseText,'text/html');
          const scans=[]; let baseDay=null;
          // Row format confirmed from console: [0]timestamp [1]ItemGraded [2]ASIN [3]EACH [4]Size [5]Qty [6]Service
          // Sub-row format:                   [0]ServiceName [1]ItemGraded [2]EACH [3]Size [4]Qty
          doc.querySelectorAll('table tr').forEach(tr=>{
            const tds=tr.querySelectorAll('td'); if(tds.length<4)return;
            const act=tds[1]?.textContent?.trim()||'';
            if(!/ItemGraded/i.test(act))return;

            const col0=tds[0]?.textContent?.trim()||'';

            // Skip sub-rows — service name in col[0] instead of a timestamp
            if(/Service|Async/i.test(col0)&&!/\d{4}\//.test(col0)) return;

            // Timestamp is in col[0]: "2026/05/01 19:37:31 AEST"
            const timeMatch=col0.match(/(\d{1,2}):(\d{2}):(\d{2})/);
            if(!timeMatch) return;
            const min=+timeMatch[1]*60 + +timeMatch[2] + +timeMatch[3]/60;

            // Day from col[0]: "2026/05/01" → 1
            const dayMatch=col0.match(/\d{4}\/\d{2}\/(\d{2})/);
            const day=dayMatch?+dayMatch[1]:null;
            if(baseDay===null&&day!==null)baseDay=day;

            // ASIN from col[2]: "B0CGQWVYQR"
            const asinRaw=tds[2]?.textContent?.trim()||'';
            const asin=/^B[A-Z0-9]{9}$/i.test(asinRaw)?asinRaw.toUpperCase():'';
            const size = normSize(tds[4]?.textContent?.trim() || '');
            const qtyRaw = parseInt((tds[5]?.textContent||'1').replace(/[^0-9]/g,''),10);
            const qty = isNaN(qtyRaw) ? 1 : Math.max(1, qtyRaw);

            scans.push({min,day,asin,size,qty});
          });
          if(!scans.length){cb([]);return;}
          if(baseDay===null)baseDay=scans[0].day||1;
          // Return objects with absolute time + asin, sorted by time
          const result=scans
            .map(s=>({
              // Night shift crosses two calendar dates. Use shift-normalised absolute minutes
              // so 00:30 on the next date becomes 1470, not 30.
              time: scanTimeToShiftAbs(s.min),
              asin:s.asin,
              size:s.size,
              qty:s.qty
            }))
            .sort((a,b)=>a.time-b.time);
          cb(result);
        } catch(e){cb([]);}
      },
      onerror:()=>cb([]),
    });
  }
  function analyseWHDGaps(scans) {
    // Gap belongs to the NEXT scanned item. Example: 18:10 item A, 18:30 item B => 20m gap before item B.
    const scanTimes = scans.map(s => s.time);
    const shift=SHIFTS[activeShift];
    const isN=activeShift==='night';
    const sMin=toMin(shift.shiftStart), eMin=toMin(shift.shiftEnd);
    const sAbs=isN&&sMin<720?sMin+1440:sMin;
    const eAbs=isN&&eMin<sMin?eMin+1440:eMin;
    const brks=shift.breaks.map(b=>{
      const bs=toMin(b.start),be=toMin(b.end);
      return{start:isN&&bs<720?bs+1440:bs,end:isN&&be<720?be+1440:be};
    });
    const quarters=[
      {label:'Q1',start:sAbs,       end:brks[0].start},
      {label:'Q2',start:brks[0].end,end:brks[1].start},
      {label:'Q3',start:brks[1].end,end:brks[2].start},
      {label:'Q4',start:brks[2].end,end:eAbs},
    ];
    // Break-aware gap calculation. Scheduled break time is NOT treated as a task gap.
    // If a gap crosses a break, the break window and the time from break end until the next scan
    // are treated as break-related, so the review gap is only the work-time before break start.
    function adjustedGap(prevTime, currTime) {
      const raw = Math.max(0, currTime - prevTime);

      for (const b of brks) {
        // Fully inside break => not a gap
        if (prevTime >= b.start && currTime <= b.end) {
          return { mins:0, rawMins:Math.round(raw), beforeBreakGap:0, afterBreakGap:0, breakAdjusted:true, breakLabel:b.label };
        }

        // Crosses the break window: count only work-time before break and after break.
        // Break itself is never counted.
        if (prevTime < b.end && currTime > b.start) {
          const beforeBreakGap = prevTime < b.start ? Math.max(0, b.start - prevTime) : 0;
          const afterBreakGap  = currTime > b.end ? Math.max(0, currTime - b.end) : 0;

          // Count all non-break idle around the break together.
          // Example: stopped 5m before break + started 5m after break = 10m effective gap.
          const total = beforeBreakGap + afterBreakGap;

          return {
            mins: Math.round(total),
            rawMins: Math.round(raw),
            beforeBreakGap: Math.round(beforeBreakGap),
            afterBreakGap: Math.round(afterBreakGap),
            breakAdjusted: true,
            breakLabel: b.label
          };
        }
      }

      return { mins:Math.round(raw), rawMins:Math.round(raw), beforeBreakGap:0, afterBreakGap:0, breakAdjusted:false, breakLabel:'' };
    }

    const allGaps=[];
    for(let i=1;i<scans.length;i++){
      const prev=scans[i-1], curr=scans[i];
      const adj = adjustedGap(prev.time, curr.time);
      const dur = adj.mins;
      if(dur<WHD.GAP_MIN)continue;
      allGaps.push({
        start: prev.time,
        end: curr.time,
        mins: Math.round(dur),
        rawMins: Math.round(adj.rawMins),
        breakAdjusted: !!adj.breakAdjusted,
        breakLabel: adj.breakLabel || '',
        beforeBreakGap: adj.beforeBreakGap || 0,
        afterBreakGap: adj.afterBreakGap || 0,
        asinBefore: prev.asin||'',
        asinAfter: curr.asin||'',
        gapAsin: curr.asin||'',
        bridgeAsin: curr.asin||'',
        bridgeSize: curr.size||'',
        bridgeQty: curr.qty||1,
        timeBefore: absToHHMM(prev.time),
        timeAfter: absToHHMM(curr.time),
        label: adj.breakAdjusted ? 'Break-adjusted gap before next scanned item' : 'Gap before next scanned item'
      });
    }

    const qResults=quarters.map(q=>{
      const qScans=scanTimes.filter(t=>t>=q.start&&t<q.end);
      const qGaps=allGaps.filter(g=>g.start>=q.start&&g.start<q.end);
      return{
        label:q.label, start:q.start, end:q.end, empty:qScans.length===0,
        firstScan:qScans.length?Math.min(...qScans):null,
        lastScan: qScans.length?Math.max(...qScans):null,
        gaps:qGaps, hasFlag:qGaps.length>0,
      };
    });
    return{qResults,totalGapMins:allGaps.reduce((s,g)=>s+g.mins,0),scans};
  }
  const whdPopupData = [];
  const asinTitleCache = new Map();
  const asinCategoryCache = new Map(); // ASIN -> {family,type,icon,cls,label,source,rawCategory,breadcrumb,title}
  const TECH_KW = [
    'sony','samsung','apple','lg','asus','acer','dell','hp','lenovo','logitech',
    'razer','corsair','steelseries','nintendo','playstation','xbox','bose','jbl',
    'anker','belkin','sennheiser','jabra','garmin','fitbit','gopro','nikon','canon',
    'panasonic','philips','8bitdo','amd','intel','nvidia','crucial','dyson','tp-link',
    'monitor','keyboard','mouse','controller','headphone','earphone','earbud','airpod',
    'speaker','webcam','microphone','laptop','tablet','ipad','smartphone','smart watch',
    'television','projector','printer','scanner','router','modem','amplifier','subwoofer',
    'processor','cpu','gpu','ram','ssd','hdd','memory card','sd card','usb hub',
    'charger','power bank','hdmi','bluetooth','wifi','wireless adapter','usb adapter',
    'gaming','console','ps4','ps5','gamepad','joystick','numpad','mechanical keyboard',
    'camera','lens','tripod','smartwatch','fitness tracker','earbuds','tws',
    'receiver','tuner','tv ','4k','oled','qled','smart tv','streaming',
    'hard drive','solid state','flash drive','thumb drive','microsd',
    'graphic card','video card','motherboard','pc components','cooling fan',
    'electric','battery','rechargeable','solar panel','inverter','voltage',
    'plug','adapter','converter','transformer','power supply',
  ];

  function categoryRet(family, type, icon, cls, source, rawCategory, breadcrumb) {
    return { family, type, icon, cls, label: family, source: source || 'keyword', rawCategory: rawCategory || '', breadcrumb: breadcrumb || '' };
  }

  function mapAmazonCategoryToGroup(rawCategory, title) {
    const raw = String(rawCategory || '').replace(/\s+/g, ' ').trim();
    const text = `${raw} ${title || ''}`.toLowerCase();
    const cat = raw.toLowerCase();
    const has = (rx) => rx.test(text);
    const catHas = (rx) => rx.test(cat);

    // 1) Strong Amazon department/category signals first. This avoids cases like
    //    "Kitchen appliance" accidentally becoming Clothing because a title contains "bag" etc.
    if (catHas(/clothing|shoes?|fashion|jewellery|jewelry|watches|apparel|handbags?|luggage/))
      return categoryRet('Clothing / Fashion', 'Clothing', '👕', 'clothing', 'amazon-category', raw, raw);
    if (catHas(/tools?|home\s*improvement|hardware|power\s*tools?|hand\s*tools?|building\s*supplies|paint|electrical|plumbing/))
      return categoryRet('Tools / Home Improvement', 'Tools', '🛠', 'tools', 'amazon-category', raw, raw);
    if (catHas(/video\s*games?|gaming|playstation|xbox|nintendo/))
      return categoryRet('Gaming', 'Gaming', '🎮', 'gaming', 'amazon-category', raw, raw);
    if (catHas(/electronics|computers?|office\s*electronics|camera|photo|television|audio|headphones?|mobile\s*phones?|cell\s*phones?|networking|printers?|monitors?/))
      return categoryRet('Tech / Electronics', 'Tech', '💻', 'tech', 'amazon-category', raw, raw);
    if (catHas(/beauty|health|personal\s*care|skin\s*care|hair\s*care|makeup|fragrance|medical/))
      return categoryRet('Health / Beauty', 'Health', '💄', 'health', 'amazon-category', raw, raw);
    if (catHas(/toys?|games|baby\s*&?\s*toddler|baby\s*products|nursery/)) {
      if (catHas(/baby|toddler|nursery/)) return categoryRet('Baby', 'Baby', '👶', 'baby', 'amazon-category', raw, raw);
      return categoryRet('Toys', 'Toys', '🧸', 'toys', 'amazon-category', raw, raw);
    }
    if (catHas(/sports?|outdoors?|camping|fitness|exercise|cycling|hiking|fishing/))
      return categoryRet('Sports / Outdoors', 'Sports', '🏋️', 'sports', 'amazon-category', raw, raw);
    if (catHas(/pet\s*supplies|dogs?|cats?|aquarium|pet/))
      return categoryRet('Pet Supplies', 'Pets', '🐾', 'pet', 'amazon-category', raw, raw);
    if (catHas(/books?|kindle|stationery|office\s*products|school\s*supplies/))
      return categoryRet('Books / Office', 'Books', '📚', 'books', 'amazon-category', raw, raw);
    if (catHas(/garden|gardening|patio|lawn|outdoor\s*décor|outdoor\s*decor/))
      return categoryRet('Garden / Outdoor', 'Garden', '🌱', 'garden', 'amazon-category', raw, raw);
    if (catHas(/automotive|car\s*care|motorcycle|vehicle|car\s*accessor|auto\s*parts|tools\s*&\s*equipment/))
      return categoryRet('Automotive', 'Automotive', '🚗', 'automotive', 'amazon-category', raw, raw);
    if (catHas(/industrial|scientific|janitorial|safety\s*supplies|test\s*&\s*measurement|lab\s*supplies/))
      return categoryRet('Industrial / Scientific', 'Industrial', '🏭', 'industrial', 'amazon-category', raw, raw);
    if (catHas(/grocery|pantry|food|beverages?|snacks?|household\s*supplies/))
      return categoryRet('Grocery / Pantry', 'Grocery', '🛒', 'grocery', 'amazon-category', raw, raw);
    if (catHas(/music|musical\s*instruments|guitars?|keyboards?|drums?|recording/))
      return categoryRet('Music / Instruments', 'Music', '🎵', 'music', 'amazon-category', raw, raw);

    // 2) Home & Kitchen is too broad, so split it using lower breadcrumb + title.
    if (catHas(/home\s*&\s*kitchen|kitchen\s*&\s*dining|home|kitchen|furniture|appliances/)) {
      if (has(/\b(air\s*fryer|microwave|toaster|kettle|blender|mixer|food\s*processor|coffee\s*(machine|maker|grinder)|espresso|vacuum|robot\s*vacuum|iron|steam\s*iron|heater|fan\s*heater|dehumidifier|humidifier|rice\s*cooker|pressure\s*cooker|slow\s*cooker|bread\s*maker|oven|dishwasher|washing\s*machine|dryer|fridge|refrigerator|freezer|juicer|sandwich\s*press|grill|appliance|appliances)\b/) || catHas(/small\s*kitchen\s*appliances|appliances|vacuums?|floor\s*care/))
        return categoryRet('Appliances', 'Appliance', '⚡', 'appliances', 'amazon-category', raw, raw);
      if (has(/\b(cookware|frying\s*pan|saucepan|pot|wok|baking|bakeware|knife\s*set|cutlery|utensils?|dish\s*rack|dinnerware|glassware|chopping\s*board|food\s*storage|plate|bowl|mug|cup|spoon|fork|grater|peeler|colander|strainer)\b/) || catHas(/kitchen\s*&\s*dining|cookware|dining|bakeware|storage\s*&\s*organisation/))
        return categoryRet('Kitchen', 'Kitchen', '🍳', 'kitchen', 'amazon-category', raw, raw);
      if (has(/\b(chair|table|desk|cabinet|shelf|shelves|bookcase|sofa|stool|drawer|wardrobe|bed\s*frame|mattress|office\s*chair|furniture|ottoman|sideboard)\b/) || catHas(/furniture|mattresses|office\s*furniture/))
        return categoryRet('Furniture', 'Furniture', '🪑', 'furniture', 'amazon-category', raw, raw);
      return categoryRet('Home', 'Home', '🏠', 'home', 'amazon-category', raw, raw);
    }

    return null;
  }

  function classifyItem(title) {
    return classifyItemDetailed(title).cls;
  }

  function classifyItemDetailed(title, amazonCategory) {
    const catGroup = mapAmazonCategoryToGroup(amazonCategory || '', title || '');
    if (catGroup) return catGroup;

    const raw = String(title || '').replace(/\s+/g, ' ').trim();
    const t = raw.toLowerCase();
    if (!raw) return { family:'Loading category', type:'Loading', icon:'⏳', cls:'unknown', label:'Loading category', source:'loading' };
    const re = (pattern) => new RegExp(pattern, 'i').test(t);
    const ret = (family,type,icon,cls) => categoryRet(family,type,icon,cls,'title-keyword','', '');
    if (re('\\b(air\\s*fryer|microwave|toaster|kettle|blender|mixer|food\\s*processor|coffee\\s*(machine|maker|grinder)|espresso|vacuum|robot\\s*vacuum|iron|steam\\s*iron|heater|fan\\s*heater|dehumidifier|humidifier|rice\\s*cooker|pressure\\s*cooker|slow\\s*cooker|bread\\s*maker|oven|dishwasher|washing\\s*machine|dryer|fridge|refrigerator|freezer|juicer|sandwich\\s*press|grill|appliance|appliances)\\b')) return ret('Appliances','Appliance','⚡','appliances');
    if (re('\\b(cookware|frying\\s*pan|saucepan|pot|wok|baking|bakeware|kitchen|knife\\s*set|cutlery|utensil|utensils|dish\\s*rack|dinnerware|glassware|chopping\\s*board|food\\s*storage|plate|bowl|mug|cup|spoon|fork|grater|peeler|colander|strainer)\\b')) return ret('Kitchen','Kitchen','🍳','kitchen');
    if (re('\\b(drill|hammer|screwdriver|wrench|pliers?|saw|tool\\s*box|toolbox|socket\\s*set|spanner|sander|grinder|level|tape\\s*measure|hardware|screws?|nails?|bolts?|diy|workbench|clamp|ladder|paint\\s*sprayer)\\b')) return ret('Tools / Home Improvement','Tools','🛠','tools');
    if (re('\\b(iphone|smartphone|mobile\\s*phone|galaxy|tablet|ipad|macbook|laptop|computer|desktop|monitor|keyboard|mouse|headphones?|earphones?|earbuds?|speaker|camera|router|modem|printer|scanner|webcam|microphone|charger|power\\s*bank|hdmi|bluetooth|wi\\-?fi|usb|adapter|cable|dock|hub|projector|television|smart\\s*tv|oled|qled|ssd|hdd|hard\\s*drive|memory\\s*card|sd\\s*card|microsd|flash\\s*drive|nvme|sata|graphics?\\s*card|gpu|cpu|motherboard|ram)\\b')) return ret('Tech / Electronics','Tech','💻','tech');
    if (re('\\b(playstation|ps5|ps4|xbox|nintendo|switch|controller|gamepad|gaming|joystick|console|vr\\s*headset)\\b')) return ret('Gaming','Gaming','🎮','gaming');
    if (re('\\b(bedding|pillow|blanket|duvet|sheet|curtain|rug|mat|towel|bath|laundry|hanger|storage\\s*(box|bag|basket|container)|organiser|organizer|home\\s*decor|lamp|lighting|cushion|trash\\s*can|rubbish\\s*bin|bin|blind|shade)\\b')) return ret('Home','Home','🏠','home');
    if (re('\\b(chair|table|desk|cabinet|shelf|shelves|bookcase|sofa|stool|drawer|wardrobe|bed\\s*frame|mattress|office\\s*chair|furniture|ottoman|sideboard)\\b')) return ret('Furniture','Furniture','🪑','furniture');
    if (re('\\b(t\\-?shirt|shirt|hoodie|jacket|pants|trousers|jeans|socks|shoes?|sneakers?|dress|bra|underwear|shorts|skirt|coat|jumper|sweater|beanie|cap|fashion|apparel|clothing)\\b') || re('\\b(handbag|shoulder\\s*bag|crossbody\\s*bag|wallet|sunglasses|wrist\\s*watch)\\b')) return ret('Clothing / Fashion','Clothing','👕','clothing');
    if (re('\\b(shampoo|conditioner|skincare|skin\\s*care|cream|makeup|perfume|beauty|lotion|serum|cleanser|soap|hair\\s*dryer|straightener|water\\s*flosser|toothbrush|personal\\s*care|razor|trimmer)\\b')) return ret('Health / Beauty','Health','💄','health');
    if (re('\\b(toy|lego|doll|plush|puzzle|board\\s*game|kids?\\s*toy|action\\s*figure|rc\\s*car)\\b')) return ret('Toys','Toys','🧸','toys');
    if (re('\\b(gym|fitness|sports?|camping|hiking|bike|bicycle|yoga|dumbbell|outdoor|fishing|swimming|football|basketball|cricket|treadmill)\\b')) return ret('Sports / Outdoors','Sports','🏋️','sports');
    if (re('\\b(book|notebook|pen|paper|folder|stationery|journal|diary|dvd|blu\\-?ray|magazine|textbook|office\\s*supplies)\\b')) return ret('Books / Office','Books','📚','books');
    if (re('\\b(dog|cat|pet\\s*food|leash|collar|aquarium|bird\\s*cage|cat\\s*litter|pet)\\b')) return ret('Pet Supplies','Pets','🐾','pet');
    if (re('\\b(diaper|nappy|wipes|baby\\s*bottle|stroller|baby|toddler|car\\s*seat|pacifier)\\b')) return ret('Baby','Baby','👶','baby');
    if (re('\\b(garden|gardening|hose|plant|planter|lawn|patio|greenhouse)\\b')) return ret('Garden / Outdoor','Garden','🌱','garden');
    return ret('Misc / Other','Misc','📦','misc');
  }

  function classifyAsinItem(asin, title) {
    const meta = asin ? (asinCategoryCache.get(String(asin).toUpperCase()) || {}) : {};
    const cat = meta.rawCategory || meta.breadcrumb || '';
    const ttl = title || meta.title || (asin ? asinTitleCache.get(String(asin).toUpperCase()) : '') || '';
    return classifyItemDetailed(ttl, cat);
  }

  // Fetch product title from FC Research
  function cleanProductTitle(title, asin) {
    let t = String(title || '').replace(/\s+/g,' ').trim();
    t = t.replace(/\s*[:|\-]?\s*Amazon\.com\.au.*$/i,'').trim();
    t = t.replace(/^Amazon\.com\.au\s*:\s*/i,'').trim();
    t = t.replace(/^FC Research\s*[:|-]?\s*/i,'').trim();
    if (!t || /^Amazon\.com\.au$/i.test(t) || /^FC Research/i.test(t) || t === asin) return '';
    return t;
  }

  function fcResearchUrl(asin) {
    const q = encodeURIComponent(String(asin || '').trim().toUpperCase());
    if (!q) return WHD.FC_RESEARCH;
    // Direct FC Research ASIN search. Keep this simple because extra query keys can stop FC Research from searching cleanly.
    return `${WHD.FC_RESEARCH}?s=${q}`;
  }

  function extractTitleFromDoc(doc, asin) {
    const selectors = ['#productTitle','span#productTitle','meta[property="og:title"]','meta[name="title"]','h1','[data-feature-name="title"]','.product-title','.a-size-large.product-title-word-break'];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const val = el ? (el.content || el.getAttribute('content') || el.textContent || '') : '';
      const cleaned = cleanProductTitle(val, asin);
      if (cleaned) return cleaned;
    }
    for (const tr of doc.querySelectorAll('tr')) {
      const cells=[...tr.querySelectorAll('th,td')].map(x=>x.textContent.trim());
      if (cells.length>=2 && /title/i.test(cells[0])) {
        const cleaned=cleanProductTitle(cells.slice(1).join(' '), asin);
        if (cleaned) return cleaned;
      }
    }
    return cleanProductTitle(doc.title || '', asin);
  }

  // Fetch product title using the older working idea: FC Research product/results first, then Amazon AU fallback.
  // This keeps ASIN title beside the ASIN and supports FC Research pages that store titles in tables.
  function cleanAmazonCategory(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .replace(/›|»|\/|\\/g, ' > ')
      .replace(/\s*>\s*/g, ' > ')
      .replace(/^(Amazon\.com\.au|Departments?)\s*[:>\-]*/i, '')
      .trim();
  }

  function parseCategoryFromDoc(doc, html) {
    const candidates = [];
    const push = v => {
      const c = cleanAmazonCategory(v);
      if (c && c.length > 2 && !/robot check|captcha|sign in|page not found/i.test(c)) candidates.push(c);
    };

    // Amazon product breadcrumb: this is the most accurate category source when available.
    [
      '#wayfinding-breadcrumbs_feature_div a',
      '#wayfinding-breadcrumbs_container a',
      '.a-breadcrumb a',
      '[data-feature-name="wayfinding-breadcrumbs"] a',
      '#nav-subnav a.nav-a',
      'a.a-link-normal.a-color-tertiary'
    ].forEach(sel => {
      const vals = [...doc.querySelectorAll(sel)].map(a => a.textContent.trim()).filter(Boolean);
      if (vals.length) push(vals.join(' > '));
    });

    // Meta and structured data category fields.
    ['meta[name="category"]','meta[property="product:category"]','meta[name="keywords"]'].forEach(sel => {
      const el = doc.querySelector(sel);
      if (el) push(el.getAttribute('content') || el.content || '');
    });

    // FC Research table patterns / Amazon details tables.
    doc.querySelectorAll('tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('th,td')].map(x => (x.textContent || '').replace(/\s+/g,' ').trim()).filter(Boolean);
      if (cells.length >= 2 && /category|product\s*group|product\s*type|binding|department|browse\s*node|gl\s*product\s*group/i.test(cells[0])) {
        push(cells.slice(1).join(' > '));
      }
    });

    // Embedded JSON commonly includes productGroup/category/categoryName/breadcrumbs.
    const text = String(html || '');
    [
      /"productGroup"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/ig,
      /"category"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/ig,
      /"categoryName"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/ig,
      /"department"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/ig,
      /"browseNodeName"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/ig,
      /"breadcrumb"[^\[]*\[([^\]]+)\]/ig
    ].forEach(rx => {
      let m; while ((m = rx.exec(text))) {
        let val = m[1] || '';
        val = val.replace(/\\u003e/g, '>').replace(/\\\//g, '/').replace(/"/g, '').replace(/[{}\[\]]/g, ' ');
        push(val);
      }
    });

    // Prefer the longest breadcrumb-like category because it contains the most detail.
    return candidates.sort((a,b) => b.length - a.length)[0] || '';
  }

  function fetchAsinMeta(asin, cb) {
    if (!asin) { cb({title:'', rawCategory:'', source:'none'}); return; }
    asin = String(asin).trim().toUpperCase();
    if (asinTitleCache.has(asin) && asinCategoryCache.has(asin)) {
      cb(Object.assign({title: asinTitleCache.get(asin) || ''}, asinCategoryCache.get(asin) || {}));
      return;
    }
    try {
      const cached = JSON.parse(localStorage.getItem('whd_asin_meta_' + asin) || 'null');
      if (cached && (cached.title || cached.rawCategory)) {
        asinTitleCache.set(asin, cached.title || '');
        asinCategoryCache.set(asin, cached);
        cb(Object.assign({title: cached.title || ''}, cached));
        return;
      }
    } catch (_) {}

    const TIMEOUT_MS = 4200;
    const cleanTitle = (title) => {
      let t = String(title || '').replace(/\s+/g, ' ').trim();
      t = t.replace(/^Amazon\.com\.au\s*[:|-]\s*/i, '');
      t = t.replace(/\s*[:|\-]\s*Amazon\.com\.au.*$/i, '');
      t = t.replace(/^FC Research\s*[:|-]?\s*/i, '');
      t = t.replace(/\b(ASIN|Title|Description|Product Name|Item Description)\b\s*[:|-]\s*/i, '').trim();
      t = t.replace(new RegExp('\\b' + asin + '\\b', 'ig'), '').replace(/\s+/g, ' ').trim();
      if (!t || /^B[A-Z0-9]{9}$/i.test(t)) return '';
      if (/^(FC Research|Results|Amazon Sign-In|Robot Check|Page Not Found|Search|Sorry|Enter the characters)$/i.test(t)) return '';
      if (/robot check|captcha|sign in|automated access|type the characters/i.test(t)) return '';
      if (t.length < 4) return '';
      if (t.length > 160) t = t.substring(0, 157) + '…';
      return t;
    };

    const parseMeta = (html, url) => {
      const doc = new DOMParser().parseFromString(html || '', 'text/html');
      const candidates = [];
      const push = v => { const c = cleanTitle(v); if (c) candidates.push(c); };

      ['#productTitle','span#productTitle','#title','h1','h2','meta[property="og:title"]','meta[name="title"]','meta[name="description"]','.product-title','.a-size-large.product-title-word-break'].forEach(sel => {
        const el = doc.querySelector(sel);
        if (el) push(el.content || el.getAttribute?.('content') || el.textContent);
      });

      doc.querySelectorAll('tr').forEach(tr => {
        const cells = [...tr.querySelectorAll('th,td')].map(x => (x.textContent || '').replace(/\s+/g,' ').trim()).filter(Boolean);
        if (cells.length >= 2 && /title|product\s*name|description|item\s*name|item\s*description/i.test(cells[0])) push(cells.slice(1).join(' '));
        if (cells.length >= 2 && cells.some(c => new RegExp(asin, 'i').test(c))) {
          cells.forEach(c => { if (!/^B[A-Z0-9]{9}$/i.test(c) && c.length > 12) push(c); });
        }
      });

      const text = html || '';
      [
        /"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/ig,
        /"productTitle"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/ig,
        /"item_name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/ig,
        /<title[^>]*>([^<]+)<\/title>/ig
      ].forEach(rx => {
        let m; while ((m = rx.exec(text))) {
          try { push(JSON.parse('"' + m[1].replace(/"/g,'\\"') + '"')); } catch (_) { push(m[1]); }
        }
      });

      const title = candidates.sort((a,b)=>b.length-a.length)[0] || '';
      const rawCategory = parseCategoryFromDoc(doc, html || '');
      return { title, rawCategory, source:url };
    };

    const finish = (meta) => {
      const title = cleanTitle(meta?.title || '');
      const rawCategory = cleanAmazonCategory(meta?.rawCategory || '');
      asinTitleCache.set(asin, title);
      asinCategoryCache.set(asin, {
        title,
        rawCategory,
        breadcrumb: rawCategory,
        source: rawCategory ? 'amazon-category' : (title ? 'title-keyword' : 'unknown')
      });
      try {
        if (title || rawCategory) localStorage.setItem('whd_asin_meta_' + asin, JSON.stringify(asinCategoryCache.get(asin)));
      } catch (_) {}
      cb(Object.assign({title, rawCategory}, asinCategoryCache.get(asin)));
    };

    const urls = [
      // FC Research first because Amazon AU can return robot-check pages; Amazon is fallback only.
      `${WHD.FC_RESEARCH}/product?s=${encodeURIComponent(asin)}`,
      `${WHD.FC_RESEARCH}?s=${encodeURIComponent(asin)}`,
      `https://www.amazon.com.au/dp/${encodeURIComponent(asin)}`,
      `https://www.amazon.com.au/gp/product/${encodeURIComponent(asin)}`
    ];
    let i = 0;
    let best = {title:'', rawCategory:'', source:''};
    const next = () => {
      if (i >= urls.length) { finish(best); return; }
      let completed = false;
      const url = urls[i++];
      const done = (meta) => {
        if (completed) return;
        completed = true;
        if (meta?.title && !best.title) best.title = meta.title;
        if (meta?.rawCategory && !best.rawCategory) best.rawCategory = meta.rawCategory;
        if (best.rawCategory && best.title) finish(best); else next();
      };
      const timer = setTimeout(() => done({}), TIMEOUT_MS);
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: TIMEOUT_MS,
        onload: res => { clearTimeout(timer); done(parseMeta(res.responseText || '', url)); },
        ontimeout: () => { clearTimeout(timer); done({}); },
        onerror: () => { clearTimeout(timer); done({}); },
      });
    };
    next();
  }

  function fetchAsinTitle(asin, cb) {
    fetchAsinMeta(asin, meta => cb(meta?.title || ''));
  }

  function asinLink(asin) {
    if (!asin) return `<span style="color:#adb5bd;font-size:11px">?</span>`;
    const url = fcResearchUrl(asin);
    return `<span style="display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap">
      <a href="${url}" target="_blank" data-asin="${asin}"
        style="color:#1971c2;font-family:monospace;font-size:11px;font-weight:700;
               background:#e7f5ff;padding:2px 7px;border-radius:12px;text-decoration:none"
        title="Open in FC Research">${asin}</a>
      <span data-asin-title="${asin}"
        style="color:#868e96;font-size:11px;font-style:italic;max-width:260px;
               white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Loading title…</span>
    </span>`;
  }

  function updateAsinTitleAndTypeInPopup(popupEl, asin, title) {
    const hasTitle = !!(title && title.trim());
    const displayTitle = hasTitle ? title.trim() : `Unknown item (${asin})`;
    const amazonUrl = `https://www.amazon.com.au/dp/${encodeURIComponent(asin)}`;
    const fcUrl = fcResearchUrl(asin);

    popupEl.querySelectorAll(`[data-asin-title="${asin}"]`).forEach(el => {
      el.innerHTML = hasTitle
        ? `<a href="${amazonUrl}" target="_blank" style="color:#495057;font-size:11px;font-weight:600;text-decoration:underline;text-decoration-color:#ced4da;text-underline-offset:2px" title="Open Amazon product page">${displayTitle}</a>`
        : `<a href="${fcUrl}" target="_blank" style="color:#868e96;font-size:11px;font-weight:600;text-decoration:underline;text-decoration-color:#ced4da;text-underline-offset:2px" title="Open FC Research">${displayTitle}</a>`;
    });

    popupEl.querySelectorAll(`[data-asin-classify="${asin}"]`).forEach(el => {
      const meta = asinCategoryCache.get(String(asin).toUpperCase()) || {};
      const d = classifyAsinItem(asin, hasTitle ? title : '');
      const colours = {
        tech: ['#e0ecff','#1d4ed8'], gaming: ['#f3e8ff','#7c3aed'], appliances: ['#e0f2fe','#0369a1'],
        clothing: ['#fdf2f8','#be185d'], tools: ['#f1f5f9','#475569'], kitchen: ['#fff7ed','#c2410c'],
        home: ['#ecfdf5','#047857'], furniture: ['#fffbeb','#92400e'], health: ['#faf5ff','#7e22ce'],
        toys: ['#fef9c3','#854d0e'], sports: ['#ecfdf5','#047857'], books: ['#eff6ff','#1d4ed8'],
        pet: ['#ecfeff','#0e7490'], baby: ['#f0f9ff','#0369a1'], garden: ['#f7fee7','#4d7c0f'],
        misc: ['#f8fafc','#334155'], general: ['#f8fafc','#334155'], unknown: ['#f1f5f9','#64748b']
      };
      const c = colours[d.cls] || colours.unknown;
      el.textContent = `${d.icon} ${d.family}${d.type ? ' | '+d.type : ''}${d.source === 'amazon-category' ? ' ✓' : ''}`;
      el.style.background = c[0];
      el.style.color = c[1];
      el.title = `${d.family}${d.type ? ' | '+d.type : ''}${meta.rawCategory ? ' | Amazon category: ' + meta.rawCategory : ''}`;
    });
  }

function loadAsinTitlesInPopup(popupEl) {
    const seen = new Set();
    const asins = [];
    popupEl.querySelectorAll('[data-asin-title],[data-asin-classify]').forEach(el => {
      const asin = (el.getAttribute('data-asin-title') || el.getAttribute('data-asin-classify') || '').trim().toUpperCase();
      if (!asin || seen.has(asin)) return;
      seen.add(asin);
      asins.push(asin);
      // Immediate display so the popup never looks blank.
      updateAsinTitleAndTypeInPopup(popupEl, asin, asinTitleCache.get(asin) || '');
    });

    // Fast queue: load several ASINs in parallel, FC Research first, Amazon fallback inside fetchAsinMeta.
    let idx = 0;
    let active = 0;
    const CONCURRENCY = 5;
    const pump = () => {
      while (active < CONCURRENCY && idx < asins.length) {
        const asin = asins[idx++];
        active++;
        fetchAsinMeta(asin, meta => {
          try {
            updateAsinTitleAndTypeInPopup(popupEl, asin, meta?.title || '');
            if (typeof refreshOverallQuarterBridge === 'function') refreshOverallQuarterBridge(popupEl);
            if (typeof refreshWHDVisuals === 'function') refreshWHDVisuals(popupEl);
          } finally {
            active--;
            pump();
          }
        });
      }
    };
    pump();
  }

  // Classify all gaps from whdPopupData using cached titles
  function getGapClassifications() {
    const result = []; // {name, gapMins, asin, title, classification, detailUrl}
    whdPopupData.forEach(d => {
      if (!d.qResults) return;
      d.qResults.forEach(q => {
        q.gaps.forEach(g => {
          const titleB = asinTitleCache.get(g.asinBefore) || '';
          const titleA = asinTitleCache.get(g.asinAfter) || '';
          const bestTitle = titleB || titleA;
          const cls = classifyItem(bestTitle);
          result.push({
            name: d.name, gapMins: g.mins,
            asinBefore: g.asinBefore, asinAfter: g.asinAfter,
            timeBefore: g.timeBefore, timeAfter: g.timeAfter,
            titleBefore: titleB, titleAfter: titleA,
            bestTitle, classification: cls,
            quarter: q.label, detailUrl: d.detailUrl,
          });
        });
      });
    });
    return result;
  }

  // Generate colour-coded suggestions
  // Removed duplicate earlier buildSuggestions() definition. Final clean definition is near bottom.

  // Removed duplicate earlier refreshSuggestions() definition. Final clean definition is near bottom.
  const REASONS = [
    { value: '',            label: 'Select reason…',      urgency: null },
    { value: 'tech',        label: 'Tech items',           urgency: 'blue' },
    { value: 'nontech',     label: 'Non-Tech items',       urgency: 'red'  },
    { value: 'large',       label: 'Large/bulky items',    urgency: 'amber'},
    { value: 'mixed',       label: 'Mixed item types',     urgency: 'amber'},
    { value: 'newhire',     label: 'New hire / training',  urgency: 'amber'},
    { value: 'away',        label: 'Away from station',    urgency: 'red'  },
    { value: 'system',      label: 'System / scan issue',  urgency: 'amber'},
    { value: 'ontarget',    label: 'On target — no issue', urgency: 'green'},
    { value: 'other',       label: 'Other (see note)',     urgency: 'amber'},
  ];

  const REASON_MSG = {
    tech:     (name, uph, target) => uph < target
                ? `${name} is on tech items — lower UPH expected. Not a coaching concern.`
                : `${name} is on tech items and still hitting target. Strong performance.`,
    nontech:  (name, uph, target) => uph < target
                ? `${name} is on non-tech items but below target. Coaching conversation needed — check what's causing the gap.`
                : `${name} on non-tech items and on target.`,
    large:    (name, uph)         => `${name} processing large/bulky items — handling time is impacting UPH. Monitor but expected.`,
    mixed:    (name, uph, target) => `${name} on mixed item types — UPH variation is expected. Watch overall pace.`,
    newhire:  (name)              => `${name} is a new hire/in training — lower performance is expected. Focus on quality over speed.`,
    away:     (name)              => `${name} was away from station — clarify reason and document if needed.`,
    system:   (name)              => `${name} had a system or scanning issue — flag for L4/AM attention if recurring.`,
    ontarget: (name)              => `${name} is on target — no action needed.`,
    other:    (name)              => `${name} — see note for context.`,
  };

  const URGENCY_STYLE = {
    red:   { bg:'#fff5f5', border:'#fa5252', icon:'#c92a2a', label:'Action Needed' },
    amber: { bg:'#fffbeb', border:'#fd7e14', icon:'#e67700', label:'Monitor'       },
    green: { bg:'#f4fce3', border:'#40c057', icon:'#2b8a3e', label:'On Track'      },
    blue:  { bg:'#f0f4ff', border:'#748ffc', icon:'#3b5bdb', label:'Expected'      },
  };

  function reasonKey(name) {
    const date = (new URLSearchParams(location.search).get('startDateIntraday')||'today').replace(/\//g,'-');
    return `whd_reason_${date}_${name}`;
  }

  function saveReason(name, reason, note) {
    try { localStorage.setItem(reasonKey(name), JSON.stringify({reason, note})); } catch(_){}
  }

  function loadReason(name) {
    try {
      const v = localStorage.getItem(reasonKey(name));
      return v ? JSON.parse(v) : {reason:'', note:''};
    } catch(_){ return {reason:'', note:''}; }
  }

    function autoReason(d) {
    if (!d.perf) return '';
    const hasGap = d.totalGapMins > 0;
    const belowTarget = d.uph > 0 && d.uph < WHD.UPH_TARGET;
    // Mostly large items
    const totalItems = d.perf.units || 0;
    const largeRatio = totalItems > 0 ? (d.perf.lgU||0) / totalItems : 0;
    if (largeRatio > 0.5) return 'large';
    // Check asin title cache for tech keywords
    if (d.qResults) {
      let techHits = 0, totalAsins = 0;
      d.qResults.forEach(q => q.gaps.forEach(g => {
        [g.asinBefore, g.asinAfter].forEach(asin => {
          if (!asin) return;
          totalAsins++;
          const title = asinTitleCache.get(asin) || '';
          if (classifyItem(title) === 'tech' || classifyItem(title) === 'tech-adjacent') techHits++;
        });
      }));
      if (totalAsins > 0 && techHits / totalAsins > 0.5) return 'tech';
    }
    return '';
  }

  // Removed duplicate earlier buildSuggestions() definition. Final clean definition is near bottom.

  // Removed duplicate earlier refreshSuggestions() definition. Final clean definition is near bottom.

  function getAllPopupAsins() {
    const seen = new Set();
    const items = [];
    whdPopupData.forEach(d => {
      (d.scanList || []).forEach(s => {
        if (s.asin && !seen.has(s.asin)) { seen.add(s.asin); items.push({asin:s.asin, name:d.name}); }
      });
      if (d.qResults) d.qResults.forEach(q => q.gaps.forEach(g => {
        [g.asinBefore, g.asinAfter].forEach(a => {
          if (a && !seen.has(a)) { seen.add(a); items.push({asin:a, name:d.name}); }
        });
      }));
    });
    return items;
  }

  function addMixCount(counts, det, qty) {
    const key = (det && det.cls) || 'misc';
    if (key === 'unknown') counts.unknown += qty;
    else if (counts[key] !== undefined) counts[key] += qty;
    else counts.misc += qty;
  }

  function getItemMixCounts() {
    // Pie chart is item category only. Large/Bulky is intentionally excluded.
    // Size still appears in the separate S/M/L bar and in productivity bridge, not in this category mix.
    const counts = {
      tech:0, gaming:0, appliances:0, clothing:0, tools:0, kitchen:0, home:0,
      furniture:0, health:0, toys:0, sports:0, books:0, pet:0, baby:0, garden:0,
      automotive:0, industrial:0, grocery:0, music:0,
      misc:0, unknown:0
    };
    let totalUnits = 0;

    whdPopupData.forEach(d => {
      (d.scanList || []).forEach(s => {
        const qty = Math.max(1, Number(s.qty || 1) || 1);
        if (!s.asin) return;
        totalUnits += qty;
        const title = asinTitleCache.get(s.asin) || '';
        if (!title) { counts.unknown += qty; return; }
        addMixCount(counts, classifyAsinItem(s.asin, title), qty);
      });
    });

    // Fallback from gap ASINs if scanList has not populated yet.
    if (!totalUnits) {
      getAllPopupAsins().forEach(item => {
        const title = asinTitleCache.get(item.asin) || '';
        if (!title) { counts.unknown++; return; }
        addMixCount(counts, classifyAsinItem(item.asin, title), 1);
      });
    }
    return counts;
  }

  function donutChartHtml(counts) {
    const rawParts = [
      {key:'tech', label:'Tech / Electronics', val:Number(counts.tech||0), color:'#2563eb'},
      {key:'gaming', label:'Gaming', val:Number(counts.gaming||0), color:'#7c3aed'},
      {key:'appliances', label:'Appliances', val:Number(counts.appliances||0), color:'#0ea5e9'},
      {key:'clothing', label:'Clothing / Fashion', val:Number(counts.clothing||0), color:'#be185d'},
      {key:'tools', label:'Tools / DIY', val:Number(counts.tools||0), color:'#475569'},
      {key:'kitchen', label:'Kitchen', val:Number(counts.kitchen||0), color:'#f97316'},
      {key:'home', label:'Home', val:Number(counts.home||0), color:'#059669'},
      {key:'furniture', label:'Furniture', val:Number(counts.furniture||0), color:'#92400e'},
      {key:'health', label:'Health / Beauty', val:Number(counts.health||0), color:'#a855f7'},
      {key:'toys', label:'Toys', val:Number(counts.toys||0), color:'#ca8a04'},
      {key:'sports', label:'Sports / Outdoors', val:Number(counts.sports||0), color:'#16a34a'},
      {key:'books', label:'Books / Office', val:Number(counts.books||0), color:'#0284c7'},
      {key:'pet', label:'Pet Supplies', val:Number(counts.pet||0), color:'#0e7490'},
      {key:'baby', label:'Baby', val:Number(counts.baby||0), color:'#0369a1'},
      {key:'garden', label:'Garden / Outdoor', val:Number(counts.garden||0), color:'#65a30d'},
      {key:'automotive', label:'Automotive', val:Number(counts.automotive||0), color:'#334155'},
      {key:'industrial', label:'Industrial / Scientific', val:Number(counts.industrial||0), color:'#52525b'},
      {key:'grocery', label:'Grocery / Pantry', val:Number(counts.grocery||0), color:'#84cc16'},
      {key:'music', label:'Music / Instruments', val:Number(counts.music||0), color:'#db2777'},
      {key:'misc', label:'Misc / Other', val:Number(counts.misc||counts.general||0), color:'#64748b'},
      {key:'unknown', label:'Loading category', val:Number(counts.unknown||0), color:'#cbd5e1'},
    ];
    const total = rawParts.reduce((a,p)=>a+p.val,0);
    const parts = rawParts.filter(p => p.val > 0);
    if (!total || !parts.length) {
      return `<div id="whd-pie-chart" class="whd-mix-wrap">
        <div class="whd-donut" style="background:conic-gradient(#e2e8f0 0% 100%)"><div><b>0</b><span>items</span></div></div>
        <div class="whd-mix-empty">No item mix available yet. Wait for scan/title data to load.</div>
      </div>`;
    }
    const topParts = parts.filter(p => p.key !== 'unknown').sort((a,b)=>b.val-a.val).slice(0,5);
    let acc = 0;
    const stops = parts.map(p => {
      const a = acc;
      const b = acc + (p.val / total * 100);
      acc = b;
      return `${p.color} ${a.toFixed(2)}% ${b.toFixed(2)}%`;
    }).join(', ');
    return `<div id="whd-pie-chart" class="whd-mix-wrap">
      <div title="Processed item mix" class="whd-donut" style="background:conic-gradient(${stops})">
        <div><b>${total}</b><span>items</span></div>
      </div>
      <div class="whd-mix-legend">
        <div style="grid-column:1/-1;font-size:11px;font-weight:950;color:#475569;margin-bottom:2px">Top categories: ${topParts.map(p=>`${p.label} ${((p.val/total)*100).toFixed(0)}%`).join(' • ') || '—'}</div>
        ${parts.map(p=>{ const pct=(p.val/total*100).toFixed(1); return `<div class="whd-mix-row">
          <span class="whd-mix-dot" style="background:${p.color}"></span>
          <span class="whd-mix-label">${p.label}</span>
          <b>${p.val}</b>
          <span class="whd-mix-pct">${pct}%</span>
        </div>`;}).join('')}
      </div>
    </div>`;
  }

  function sizeBarGraphHtml(small, med, large) {
    const max = Math.max(small, med, large, 1);
    const rows = [
      {label:'Small', val:small, color:'#0c8599'},
      {label:'Medium', val:med, color:'#e67700'},
      {label:'Large', val:large, color:'#c92a2a'},
    ];
    return `<div id="whd-size-graph" style="display:flex;flex-direction:column;gap:8px">
      ${rows.map(r=>`<div style="display:grid;grid-template-columns:64px 1fr 42px;gap:8px;align-items:center">
        <span style="font-size:12px;color:#495057;font-weight:600">${r.label}</span>
        <div style="height:13px;background:#f1f3f5;border-radius:20px;overflow:hidden">
          <div style="height:100%;width:${Math.max(3, Math.round(r.val/max*100))}%;background:${r.color};border-radius:20px"></div>
        </div>
        <span style="font-size:12px;color:#212529;font-weight:700;text-align:right">${r.val}</span>
      </div>`).join('')}
    </div>`;
  }

  function refreshWHDVisuals(popupEl) {
    const pie = popupEl.querySelector('#whd-pie-chart-wrap');
    if (pie) pie.innerHTML = donutChartHtml(getItemMixCounts());

    popupEl.querySelectorAll('[data-assoc-explain]').forEach(el => {
      const name = el.getAttribute('data-assoc-explain');
      const d = whdPopupData.find(x => x.name === name);
      if (!d) return;
      el.textContent = buildAssociateExplanation(d);
    });
  }

  function buildAssociateExplanation(d) {
    const units = getAssociateUnits(d);
    const uph = d.uph ? d.uph.toFixed(1) : '0.0';
    const reasons = [];
    const total = units || 1;
    if (getSizeCounts(d).large / total > 0.35) reasons.push('large/bulky item mix');
    if (d.totalGapMins > 0) reasons.push(`${d.totalGapMins}m scan gap`);
    let techDetected = false;
    (d.scanList || []).forEach(s => {
      const title = asinTitleCache.get(s.asin) || '';
      const det = classifyAsinItem(s.asin, title);
      if (det.cls === 'tech') techDetected = true;
    });
    if (!techDetected && d.qResults) d.qResults.forEach(q => q.gaps.forEach(g => {
      [g.asinBefore, g.asinAfter].forEach(a => {
        const det = classifyAsinItem(a, asinTitleCache.get(a) || '');
        if (det.cls === 'tech') techDetected = true;
      });
    }));
    if (techDetected) reasons.push('tech/testing items');
    if (!reasons.length) reasons.push('normal workload / no major delay detected');
    const extra = techDetected ? ' Tech items such as mobiles, SSDs, HDDs, memory cards and tablets may require testing or Blancco checks, so lower UPH can be expected.' : '';
    return `${d.name} processed ${units} items at ${uph} UPH. Performance may be impacted by ${reasons.join(', ')}.${extra}`;
  }

  function esc(v) {
    return String(v ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
  }

  function getAssociateUnits(d) {
    return d?.perf?.units || (d?.scanList || []).reduce((sum,s)=>sum+(s.asin?(Number(s.qty||1)||1):0),0) || 0;
  }

  function itemBadgeHtml(det) {
    det = det || {family:'Loading', type:'Title', icon:'⏳', cls:'unknown'};
    const label = `${det.family || 'Unknown'}${det.type ? ' | '+det.type : ''}`;
    const palette = {
      tech:['#e0ecff','#1d4ed8'], 'tech-adjacent':['#e0f2fe','#0369a1'],
      clothing:['#fdf2f8','#be185d'], home:['#ecfdf5','#047857'], beauty:['#faf5ff','#7e22ce'], toys:['#fef9c3','#854d0e'],
      books:['#eff6ff','#1d4ed8'], tools:['#f1f5f9','#475569'], pet:['#ecfeff','#0e7490'], baby:['#f0f9ff','#0369a1'],
      sports:['#ecfdf5','#047857'], automotive:['#fff7ed','#c2410c'], general:['#f8fafc','#334155'],
      'non-tech':['#f8fafc','#334155'], large:['#fff1e6','#c2410c'], unknown:['#f1f5f9','#64748b']
    };
    const st = palette[det.cls] || palette.unknown;
    return `<span style="display:inline-block;background:${st[0]};color:${st[1]};font-size:10px;font-weight:800;padding:3px 8px;border-radius:999px;white-space:nowrap" title="${esc(label)}">${det.icon || '•'} ${esc(label)}</span>`;
  }

  function associateItems(d) {
    const seen = new Set();
    return (d.scanList || []).filter(s => s.asin).map((s, idx) => {
      const key = `${s.asin}_${Math.round(s.time*100)}_${idx}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const title = asinTitleCache.get(s.asin) || '';
      return { asin:s.asin, time:absToHHMM(s.time), title, det:classifyAsinItem(s.asin, title) };
    }).filter(Boolean);
  }

  function processedItemsTableHtml(d) {
    const items = associateItems(d);
    if (!items.length) return `<div style="font-size:12px;color:#868e96;padding:10px;background:white;border:1px solid #e9ecef;border-radius:10px">No item-level ASIN scan list found for this AA.</div>`;
    return `<div style="margin-top:9px;border:1px solid #e9ecef;border-radius:10px;background:white;overflow:hidden">
      <div style="max-height:300px;overflow:auto">
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead style="position:sticky;top:0;background:#f8f9fa;z-index:1">
            <tr>
              <th style="text-align:left;padding:7px 8px;color:#868e96">Time</th>
              <th style="text-align:left;padding:7px 8px;color:#868e96">ASIN</th>
              <th style="text-align:left;padding:7px 8px;color:#868e96">Title</th>
              <th style="text-align:left;padding:7px 8px;color:#868e96">Category</th>
            </tr>
          </thead>
          <tbody>
          ${items.map(it => `<tr style="border-top:1px solid #f1f3f5">
            <td style="padding:7px 8px;color:#495057;font-weight:700;white-space:nowrap">${esc(it.time)}</td>
            <td style="padding:7px 8px;white-space:nowrap"><a href="${fcResearchUrl(it.asin)}" target="_blank" style="font-family:monospace;color:#1971c2;font-weight:800;text-decoration:none">${esc(it.asin)}</a></td>
            <td style="padding:7px 8px;max-width:330px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span data-asin-title="${esc(it.asin)}">${it.title ? `<a href="https://www.amazon.com.au/dp/${encodeURIComponent(it.asin)}" target="_blank" style="color:#495057;text-decoration:underline;text-decoration-color:#ced4da">${esc(it.title)}</a>` : 'Loading title…'}</span></td>
            <td style="padding:7px 8px"><span data-asin-classify="${esc(it.asin)}">${itemBadgeHtml(it.det)}</span></td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  function gapSummaryHtml() {
    const rows = [];
    whdPopupData.forEach(d => (d.qResults || []).forEach(q => (q.gaps || []).forEach(g => {
      const title = asinTitleCache.get(g.asinAfter) || asinTitleCache.get(g.asinBefore) || '';
      const det = classifyAsinItem(g.asinAfter || g.asinBefore, title);
      let review = 'Review';
      if (det.cls === 'tech' || det.cls === 'tech-adjacent') review = 'Expected tech/testing delay';
      else if (det.cls === 'large') review = 'Expected large/bulky delay';
      else if (det.simple) review = 'Possible coaching if unexplained';
      rows.push({name:d.name, q:q.label, mins:g.mins, start:g.timeBefore, end:g.timeAfter, asin:g.asinAfter || g.asinBefore, det, review});
    })));
    if (!rows.length) return `<div style="padding:10px;color:#2b8a3e;font-size:12px;font-weight:700">No long scan gaps found.</div>`;
    return `<div style="max-height:260px;overflow:auto;border:1px solid #e9ecef;border-radius:10px;background:white">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead style="position:sticky;top:0;background:#f8f9fa;z-index:1"><tr>
          ${['AA','Q','Gap','Time','ASIN','Type','Action'].map(h=>`<th style="text-align:left;padding:7px 8px;color:#868e96">${h}</th>`).join('')}
        </tr></thead><tbody>
        ${rows.map(r=>`<tr style="border-top:1px solid #f1f3f5">
          <td style="padding:7px 8px;font-weight:800;color:#212529">${esc(r.name)}</td>
          <td style="padding:7px 8px">${esc(r.q)}</td>
          <td style="padding:7px 8px;font-weight:900;color:${r.mins>=15?'#c92a2a':'#e67700'}">${r.mins}m</td>
          <td style="padding:7px 8px;white-space:nowrap">${esc(r.start)} → ${esc(r.end)}</td>
          <td style="padding:7px 8px"><a href="${fcResearchUrl(r.asin||'')}" target="_blank" style="font-family:monospace;color:#1971c2;font-weight:800;text-decoration:none">${esc(r.asin || '—')}</a></td>
          <td style="padding:7px 8px">${itemBadgeHtml(r.det)}</td>
          <td style="padding:7px 8px;color:#495057">${esc(r.review)}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>`;
  }

  function getAAEmployeeId(d) {
    const candidates = [d?.employeeId, d?.empId, d?.id, d?.employeeID, d?.detailUrl, d?.url, d?.profileUrl, d?.name].filter(Boolean).map(String);
    for (const v of candidates) {
      const m = v.match(/(?:employeeId|employeeid|employeeID)=([0-9]{5,})/i) || v.match(/\b([0-9]{7,12})\b/);
      if (m) return m[1];
    }
    return '';
  }

  function aaInitials(name) {
    const parts = String(name || 'AA').replace(/[,]+/g,' ').trim().split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] || 'A';
    const second = (parts.length > 1 ? parts[1][0] : (parts[0]?.[1] || 'A')) || 'A';
    return (first + second).toUpperCase();
  }

  function aaPhotoUrlFromId(empId) {
    return empId ? `https://badgephotos.corp.amazon.com/?employeeid=${encodeURIComponent(empId)}` : '';
  }

  function aaAvatarHtml(d, size = 42) {
    const empId = getAAEmployeeId(d);
    const name = d?.name || 'AA';
    const initials = aaInitials(name);
    const src = aaPhotoUrlFromId(empId);
    const safeName = esc(name);
    const fallbackStyle = `width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1d4ed8,#0f172a);color:white;font-size:${Math.max(11, Math.round(size/3))}px;font-weight:950;flex:0 0 ${size}px;border:2px solid rgba(255,255,255,.75);box-shadow:0 8px 18px rgba(15,23,42,.16)`;
    if (!src) return `<span class="aa-avatar-fallback" style="${fallbackStyle}" title="${safeName}">${esc(initials)}</span>`;
    return `<img class="aa-avatar" src="${src}" alt="${safeName}" title="${safeName}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex:0 0 ${size}px;border:2px solid rgba(255,255,255,.85);box-shadow:0 8px 18px rgba(15,23,42,.16);background:#e2e8f0" onerror="this.outerHTML='<span class=&quot;aa-avatar-fallback&quot; style=&quot;${fallbackStyle.replace(/"/g,'&quot;')}&quot; title=&quot;${safeName}&quot;>${esc(initials)}</span>'">`;
  }

  function exportWHDProcessedCSV() {
    const lines = [['AA Name','ASIN','Title','Category','Time','UPH','Total Processed','Small','Medium','Large'].map(x=>`"${x}"`).join(',')];
    whdPopupData.forEach(d => {
      const items = associateItems(d);
      if (!items.length) {
        lines.push([d.name,'','','', '', d.uph||0, getAssociateUnits(d), getSizeCounts(d).small, getSizeCounts(d).medium, getSizeCounts(d).large].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
      } else {
        items.forEach(it => lines.push([d.name,it.asin,it.title,it.det.label,it.time,d.uph||0,getAssociateUnits(d),d.perf?.smU||0,d.perf?.mdU||0,d.perf?.lgU||0].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')));
      }
    });
    const blob = new Blob([lines.join('\n')], {type:'text/csv'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `whd_processed_items_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1500);
  }

  function openWHDFullPage() {
    const dateStr = (new URLSearchParams(location.search).get('startDateIntraday') || '').replace(/\//g,'-');
    const data = whdPopupData.map(d => ({
      name: d.name || '',
      empId: getAAEmployeeId(d),
      photoUrl: aaPhotoUrlFromId(getAAEmployeeId(d)),
      initials: aaInitials(d.name || 'AA'),
      uph: getAssociateAvgTPH(d),
      units: getAssociateUnits(d),
      small: getSizeCounts(d).small,
      medium: getSizeCounts(d).medium,
      large: getSizeCounts(d).large,
      gaps: d.totalGapMins || 0,
      firstScan: (d.scanList && d.scanList.length) ? absToHHMM(d.scanList[0].time) : '—',
      lastScan: (d.scanList && d.scanList.length) ? absToHHMM(d.scanList[d.scanList.length-1].time) : '—',
      detailUrl: d.detailUrl || '',
      items: associateItems(d).map(it => ({
        time: it.time,
        asin: it.asin,
        title: asinTitleCache.get(it.asin) || it.title || '',
        cls: classifyAsinItem(it.asin, asinTitleCache.get(it.asin) || it.title || '').cls || 'unknown',
        fcUrl: fcResearchUrl(it.asin),
        amazonUrl: `https://www.amazon.com.au/dp/${encodeURIComponent(it.asin)}`
      })),
      gapRows: (d.qResults || []).flatMap(q => (q.gaps || []).map(g => ({
        quarter: q.label,
        mins: g.mins,
        before: g.asinBefore || '',
        after: g.asinAfter || '',
        timeBefore: g.timeBefore || '',
        timeAfter: g.timeAfter || '',
        beforeUrl: fcResearchUrl(g.asinBefore || ''),
        afterUrl: fcResearchUrl(g.asinAfter || '')
      })))
    }));
    const mix = getItemMixCounts();
    const mixTotal = Object.values(mix).reduce((a,b)=>a+Number(b||0),0) || 0;
    const mixParts = [
      ['tech','Tech / Electronics','#6366f1'], ['gaming','Gaming','#7c3aed'], ['appliances','Appliances','#0ea5e9'],
      ['clothing','Clothing / Fashion','#ec4899'], ['tools','Tools / DIY','#64748b'], ['kitchen','Kitchen','#f97316'],
      ['home','Home','#14b8a6'], ['furniture','Furniture','#92400e'], ['health','Health / Beauty','#a855f7'],
      ['toys','Toys','#eab308'], ['sports','Sports / Outdoors','#16a34a'], ['books','Books / Office','#0ea5e9'],
      ['pet','Pet Supplies','#0e7490'], ['baby','Baby','#0369a1'], ['garden','Garden / Outdoor','#65a30d'],
      ['misc','Misc / Other','#64748b'], ['unknown','Loading category','#94a3b8']
    ].map(([key,label,color])=>({key,label,color,val:Number(mix[key]||0),pct:mixTotal?Math.round(Number(mix[key]||0)/mixTotal*100):0})).filter(p=>p.val>0);
    const summary = {
      totalUnits: data.reduce((s,d)=>s+d.units,0),
      avgTph: getTeamAverageTPH(),
      expected: getExpectedTPHValue(),
      pprActualTPH: getPPRActualWHDTPH(),
      pprPlanTPH: getPPRPlanWHDTPH(),
      supportActual: getPPRActualSupportHours(),
      supportPlan: getPPRPlannedSupportHours(),
      target: getTargetValue(),
      dateStr,
      associates: data.length,
      gaps: data.filter(d=>d.gaps>0).length,
      mixTotal,
      mixParts,
      bridge: [getCurrentOverallBridgeData()].filter(Boolean)
    };
    const w = window.open('', '_blank');
    if (!w) { alert('Popup blocked. Allow popups for this page to open the full AR (WHD) Performance DB.'); return; }
    const payload = JSON.stringify({summary, data}).replace(/<\//g, '<\\/');
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>AR Performance Dashboard</title>
      <style>
        :root{--bg:#f6f8fc;--panel:#ffffff;--panel2:#f1f5f9;--soft:#f8fafc;--card:#ffffff;--text:#111827;--muted:#475569;--line:#dbe3ef;--blue:#1d4ed8;--green:#15803d;--red:#dc2626;--amber:#b45309;--shadow:0 18px 50px rgba(15,23,42,.12)}

        *{box-sizing:border-box}body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:radial-gradient(circle at top left,rgba(37,99,235,.12),transparent 34%),var(--bg);color:var(--text);margin:0;padding:22px 30px;transition:.2s background,.2s color}
        .shell{max-width:1440px;margin:0 auto}.hero{position:sticky;top:14px;background:rgba(255,255,255,.92);backdrop-filter:blur(14px);border:1px solid var(--line);border-radius:24px;padding:18px;box-shadow:var(--shadow);z-index:5}
        .heroTop{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap}.title{font-size:25px;font-weight:950;letter-spacing:-.04em}.sub{font-size:12px;color:var(--muted);font-weight:750;margin-top:4px}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:12px;padding:9px 12px;font-weight:900;cursor:pointer}.btn.primary{background:var(--blue);border-color:var(--blue);color:white}
        .kpis{display:grid;grid-template-columns:repeat(6,minmax(130px,1fr));gap:10px;margin-top:14px}.kpi{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:9px}.kpi .v{font-size:24px;font-weight:950}.kpi .l{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:900;margin-top:3px}
        .bridge{margin-top:12px;display:block}.bridge .q{font-size:12px;font-weight:900;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.q{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:10px 12px}.q.miss{border-color:rgba(217,119,6,.45);background:linear-gradient(180deg,rgba(251,191,36,.14),var(--panel))}.q.hit{border-color:rgba(22,163,74,.35)}.qtop{display:flex;justify-content:space-between;font-size:12px;font-weight:950}.qnum{font-size:22px;font-weight:950;margin-top:7px}.bar{height:8px;background:var(--panel2);border-radius:99px;overflow:hidden;margin:10px 0}.fill{height:100%;border-radius:99px;background:var(--blue)}.qtxt{font-size:11px;color:var(--muted);font-weight:800;line-height:1.45}.chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}.chip{font-size:10px;font-weight:950;border-radius:999px;padding:3px 7px;background:var(--panel2);border:1px solid var(--line);color:var(--muted)}
        .section{display:grid;grid-template-columns:1.05fr .95fr;gap:14px;margin-top:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:10px;box-shadow:0 10px 30px rgba(15,23,42,.05)}.panel h3{margin:0 0 12px;font-size:15px}.pieWrap{display:flex;align-items:center;gap:18px;flex-wrap:wrap}.pie{width:150px;height:150px;border-radius:50%;position:relative;box-shadow:inset 0 0 0 1px var(--line),0 14px 30px rgba(15,23,42,.10)}.pie:after{content:attr(data-total) ' ASINs';position:absolute;inset:38px;border-radius:50%;background:var(--panel);display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;font-weight:950;color:var(--text);box-shadow:0 0 0 1px var(--line)}.legend{display:grid;grid-template-columns:repeat(2,minmax(165px,1fr));gap:8px;flex:1}.leg{display:flex;align-items:center;gap:8px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:8px;font-size:12px;font-weight:850}.dot{width:11px;height:11px;border-radius:50%}.pct{margin-left:auto;color:var(--muted);font-weight:950}
        .tools{display:flex;gap:10px;align-items:center;margin-top:16px;flex-wrap:wrap}.search{flex:1;min-width:260px;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:14px;padding:12px 14px;font-size:14px;font-weight:800}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(390px,1fr));gap:14px;margin-top:14px}.card{background:var(--panel);border:1px solid var(--line);border-left:6px solid var(--green);border-radius:20px;padding:15px;box-shadow:0 10px 26px rgba(15,23,42,.05)}.card.low{border-left-color:var(--amber)}.card.gap{border-left-color:var(--red)}.aaTitle{display:flex;align-items:center;gap:10px;min-width:0}.aaPhoto{width:48px;height:48px;border-radius:50%;object-fit:cover;flex:0 0 48px;border:2px solid var(--panel);box-shadow:0 8px 18px rgba(15,23,42,.16);background:var(--panel2)}.aaInitial{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--blue),#0f172a);color:white;font-weight:950;flex:0 0 48px;border:2px solid var(--panel);box-shadow:0 8px 18px rgba(15,23,42,.16)}.name{font-size:16px;font-weight:950;min-width:0}.name a{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metrics{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.m{background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:5px 9px;font-size:11px;font-weight:950;color:var(--muted)}details{margin-top:10px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--panel2)}summary{cursor:pointer;padding:10px 12px;font-weight:950;font-size:12px}table{width:100%;border-collapse:collapse;font-size:11px;background:var(--panel)}th,td{border-top:1px solid var(--line);text-align:left;padding:8px;vertical-align:top}th{color:var(--muted);background:var(--panel2);position:sticky;top:0}a{color:var(--blue);text-decoration:none;font-weight:900}.asin{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.tag{border-radius:999px;padding:3px 8px;font-size:10px;font-weight:950;background:var(--panel2);border:1px solid var(--line);color:var(--muted)}@media(max-width:900px){.kpis,.bridge,.section{grid-template-columns:1fr}.grid{grid-template-columns:1fr}}

      .webTableWrap{width:100%;max-width:100%;overflow:hidden}.web-aa-table{width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse}.web-aa-table th,.web-aa-table td{padding:8px 7px;border-bottom:1px solid var(--line);vertical-align:top;overflow:hidden}.web-aa-table th{font-size:10px;color:var(--muted);text-transform:uppercase;background:var(--soft);font-weight:950}.web-aa-table .aaName{display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.web-aa-table .before{max-width:100%;overflow:hidden}.web-aa-table .whd-title{display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden!important;max-width:100%!important;line-height:1.22!important;font-size:11px!important}.web-aa-table .whd-cat-pill{max-width:100%;white-space:nowrap!important;overflow:hidden;text-overflow:ellipsis}.web-aa-table .sizePill{display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.web-aa-table button{border:0;border-radius:10px;padding:7px 10px;background:var(--blue);color:white;font-weight:950;cursor:pointer}@media(max-width:1100px){.web-aa-table{font-size:11px}.web-aa-table th,.web-aa-table td{padding:6px 5px}.web-aa-table .whd-title{font-size:10px!important}.web-aa-table .aaName{font-size:12px}}
      .web-card-summary{display:flex;justify-content:space-between;gap:10px;align-items:center;background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin-bottom:10px;color:var(--muted);font-size:12px;font-weight:950;flex-wrap:wrap}.web-card-summary b{background:var(--blue);color:white;border-radius:999px;padding:3px 9px;margin-left:5px}.aaCardsWeb{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:10px;width:100%;max-width:100%;overflow:hidden}.aaCardsWeb .aaCard{display:grid!important;grid-template-columns:1fr 86px!important;gap:10px!important;align-items:start!important;border:1px solid var(--line)!important;border-radius:16px!important;padding:12px!important;background:var(--card)!important;box-shadow:0 8px 20px rgba(15,23,42,.06);min-width:0!important;overflow:hidden!important}.aaCardsWeb .aaCard.review{background:#fff7ed!important}.aaCardsWeb .aaCell{min-width:0!important;overflow:hidden!important}.aaCardsWeb .aaCell label{display:block!important;font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:950;margin-bottom:3px}.aaCardsWeb .associate{grid-column:1/2}.aaCardsWeb .tph{grid-column:2/3;text-align:right}.aaCardsWeb .gap{grid-column:1/2}.aaCardsWeb .before{grid-column:1/-1!important;background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:8px}.aaCardsWeb .items{grid-column:1/2;text-align:left!important}.aaCardsWeb .gaps{grid-column:2/3;text-align:center!important}.aaCardsWeb .cardDetail{grid-column:1/-1!important;max-width:100%;overflow:auto}.aaCardsWeb .whd-title{display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden!important;white-space:normal!important;line-height:1.25!important;max-width:100%!important}.aaCardsWeb .whd-cat-pill{display:inline-block;max-width:100%;white-space:nowrap!important;overflow:hidden;text-overflow:ellipsis}.aaCardsWeb button{border:0;border-radius:10px;padding:7px 11px;background:var(--blue);color:white;font-weight:950;cursor:pointer;margin-top:5px}.aaCardsWeb .aaName{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:15px;font-weight:950}.aaCardsWeb table{table-layout:fixed;width:100%;font-size:11px}.aaCardsWeb td,.aaCardsWeb th{word-break:break-word}.aaCardsWeb .box{max-height:360px;overflow:auto}@media(max-width:800px){.aaCardsWeb{grid-template-columns:1fr}.aaCardsWeb .aaCard{grid-template-columns:1fr!important}.aaCardsWeb .tph,.aaCardsWeb .gaps{grid-column:1/-1;text-align:left!important}.kpis{grid-template-columns:1fr 1fr}.quarters{grid-template-columns:1fr 1fr}.whd-cat-viz{grid-template-columns:1fr}.whd-cat-pie{margin:auto}}

        .status.review,
        .

        .quarters .q{overflow:hidden}.quarters .q div{align-items:center}.quarters .q strong{display:block;font-size:clamp(22px,2.3vw,31px)!important;line-height:1!important;white-space:nowrap!important;letter-spacing:-.03em;overflow-wrap:normal!important;word-break:keep-all!important}.quarters .q em,.quarters .q small{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}.quarters .q span{white-space:nowrap!important}.reviewBtn,.cardActions button{display:inline-flex!important;align-items:center!important;justify-content:center!important;min-width:72px!important;max-width:92px!important;height:34px!important;line-height:1!important;white-space:nowrap!important;flex:0 0 auto!important}.reviewBtn.small{min-width:62px!important;max-width:70px!important;height:28px!important;padding:0 8px!important}.warnCard .reviewBtn{width:76px!important}
        .shiftDetails summary{display:inline-flex!important;align-items:center!important;min-height:38px!important;max-width:100%!important;line-height:1.1!important}

        @media(max-width:800px){body{padding-left:14px!important;padding-right:14px!important}}

    </style></head><body><div class="shell">
      <div class="hero"><div class="heroTop"><div><div class="title">⚡ AR (WHD) Performance DB</div><div class="sub">${summary.dateStr || 'Current report'} • Search filters associate names only • Full-page standard view</div></div><div class="actions"><button class="btn primary" onclick="window.print()">Print / Save PDF</button></div></div>
      <div class="kpis"><div class="kpi"><div class="v">${summary.associates}</div><div class="l">Associates</div></div><div class="kpi"><div class="v">${summary.totalUnits}</div><div class="l">Units Graded</div></div><div class="kpi"><div class="v">${summary.avgTph.toFixed(1)}</div><div class="l">Team Avg TPH</div></div><div class="kpi"><div class="v">${summary.expected.toFixed(2)}</div><div class="l">Expected TPH</div></div><div class="kpi"><div class="v">${summary.target || '—'}</div><div class="l">Daily Target</div></div><div class="kpi"><div class="v">${summary.gaps}</div><div class="l">AAs With Gaps</div></div></div>
      <div id="bridge" class="bridge"></div></div>
      <div class="section"><div class="panel"><h3>🥧 Processed Item Mix</h3><div id="mix"></div></div><div class="panel"><h3>🧠 Shift Bridge Summary</h3><div id="bridgeText" style="font-size:13px;line-height:1.6;color:var(--muted);font-weight:800"></div></div></div>
      <div class="tools"><input id="search" class="search" placeholder="Search AA name only..."><button class="btn" id="clear">Clear</button></div><div id="grid" class="grid"></div>
      </div><script>const payload=${payload};
        const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\\"':'&quot;','"':'&quot;'}[c]||c));function renderBridge(){const b=document.getElementById('bridge');const r=(payload.summary.bridge||[])[0];if(!r){b.innerHTML='<div class="q">No bridge data yet</div>';return;}const tech=(r.unknownPct>=35&&r.techPct===0)?'tech/electric items being processed':'tech/electric '+r.techPct+'%';const mix=tech+' • large/bulky '+r.largePct+'%';const impact='TPH rate and target pace may be affected because tech/electric and large items usually need more inspection, testing, or handling.';let txt='';if(r.status==='miss'){txt='🌉 '+r.label+' Bridge: '+r.actual+'/'+r.target+' units, short '+r.miss+'. '+mix+'. '+impact;}else if(r.status==='hit'){txt='🌉 '+r.label+' Bridge: on target '+r.actual+'/'+r.target+'. '+mix+'. Item mix is being monitored.';}else{txt='🌉 '+r.label+' Bridge: set daily target to calculate target bridge. Current actual '+r.actual+' units • '+mix+'. '+impact;}const cls=r.status==='miss'?'miss':(r.status==='hit'?'hit':'');b.innerHTML='<div class="q '+cls+'">'+esc(txt)+'</div>';document.getElementById('bridgeText').textContent=txt}
        function renderMix(){let acc=0;const parts=payload.summary.mixParts;const stops=parts.map(p=>{const a=acc,b=acc+p.pct;acc=b;return \`\${p.color} \${a}% \${b}%\`}).join(', ');document.getElementById('mix').innerHTML=\`<div class="pieWrap"><div class="pie" data-total="\${payload.summary.mixTotal}" style="background:conic-gradient(\${stops||'#e2e8f0 0% 100%'})"></div><div class="legend">\${parts.map(p=>\`<div class="leg"><span class="dot" style="background:\${p.color}"></span><span>\${esc(p.label)}</span><b>\${p.val}</b><span class="pct">\${p.pct}%</span></div>\`).join('')||'<div class="leg">No item mix yet</div>'}</div></div>\`}
        function renderCards(){const q=document.getElementById('search').value.toLowerCase().trim();const grid=document.getElementById('grid');grid.innerHTML='';payload.data.filter(d=>!q||d.name.toLowerCase().includes(q)).forEach(d=>{const cls=d.gaps>0?'gap':(d.uph>0&&d.uph<payload.summary.expected?'low':'');const div=document.createElement('div');div.className='card '+cls;div.innerHTML=\`<div class="aaTitle"><img class="aaPhoto" src="\${esc(d.photoUrl||'')}" alt="\${esc(d.name)}" data-initials="\${esc(d.initials||'AA')}" onerror="this.outerHTML='<span class=&quot;aaInitial&quot;>'+(this.getAttribute('data-initials')||'AA')+'</span>'"><div class="name"><a href="\${esc(d.detailUrl)}" target="_blank">\${esc(d.name)} ↗</a><span class="m">ID \${esc(d.empId||'—')}</span></div></div><div class="metrics"><span class="m">TPH \${Number(d.uph||0).toFixed(1)}</span><span class="m">Units \${d.units}</span><span class="m">S \${d.small}</span><span class="m">M \${d.medium}</span><span class="m">L \${d.large}</span><span class="m">Gaps \${d.gaps}m</span><span class="m">Scan \${d.firstScan} → \${d.lastScan}</span></div><details><summary>Processed ASINs (FC Research direct search)</summary><table><thead><tr><th>Time</th><th>ASIN</th><th>Title</th><th>Type</th></tr></thead><tbody>\${d.items.map(it=>\`<tr><td>\${esc(it.time)}</td><td><a class="asin" href="\${esc(it.fcUrl)}" target="_blank">\${esc(it.asin)}</a></td><td><a href="\${esc(it.amazonUrl)}" target="_blank">\${esc(it.title||'Unknown item')}</a></td><td><span class="tag">\${esc(it.cls)}</span></td></tr>\`).join('')||'<tr><td colspan="4">No item level scan list found</td></tr>'}</tbody></table></details><details><summary>Scan gaps</summary><table><thead><tr><th>Q</th><th>Gap</th><th>Before</th><th>After</th></tr></thead><tbody>\${d.gapRows.map(g=>\`<tr><td>\${esc(g.quarter)}</td><td>\${g.mins}m<br><span style="color:var(--muted)">\${esc(g.timeBefore)} → \${esc(g.timeAfter)}</span></td><td><a class="asin" href="\${esc(g.beforeUrl)}" target="_blank">\${esc(g.before||'—')}</a></td><td><a class="asin" href="\${esc(g.afterUrl)}" target="_blank">\${esc(g.after||'—')}</a></td></tr>\`).join('')||'<tr><td colspan="4">No gaps</td></tr>'}</tbody></table></details>\`;grid.appendChild(div);});}
        document.getElementById('search').addEventListener('input',renderCards);document.getElementById('clear').onclick=()=>{document.getElementById('search').value='';renderCards();};renderBridge();renderMix();renderCards();<\/script></body></html>`);
    w.document.close();
  }

  function setupWHDPopupControls(overlay) {
    const toggle = (btnSel, bodySel, showText, hideText) => {
      const btn = overlay.querySelector(btnSel), body = overlay.querySelector(bodySel);
      if (!btn || !body) return;
      btn.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : (bodySel === '#whd-visuals-body' ? 'grid' : 'block');
        btn.textContent = open ? showText : hideText;
      });
    };
    toggle('#whd-toggle-visuals', '#whd-visuals-body', 'Show Visual Insights', 'Hide Visual Insights');
    toggle('#whd-toggle-gaps', '#whd-gap-body', 'Show Gap Summary', 'Hide Gap Summary');
    toggle('#whd-toggle-analysis', '#whd-analysis-body', 'Show Analysis', 'Hide Analysis');

    const applyFilters = () => {
      const q = (overlay.querySelector('#whd-aa-search')?.value || '').toLowerCase().trim();
      overlay.querySelectorAll('[data-card-name]').forEach(card => {
        const name = (card.getAttribute('data-card-name') || '').toLowerCase();
        card.style.display = (!q || name.includes(q)) ? '' : 'none';
      });
    };
    overlay.querySelector('#whd-aa-search')?.addEventListener('input', applyFilters);
    overlay.querySelector('#whd-download-csv')?.addEventListener('click', exportWHDProcessedCSV);
    overlay.querySelector('#whd-open-page')?.addEventListener('click', openWHDFullPage);
    overlay.querySelector('#whd-theme-toggle')?.addEventListener('click', () => {
      const next = popup?.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      popup?.setAttribute('data-theme', next);
      localStorage.setItem('ar_whd_theme', next);
      const btn = overlay.querySelector('#whd-theme-toggle');
      if (btn) btn.textContent = next === 'dark' ? '☀️ Bright' : '🌙 Dark';
    });
  }

  function getExpectedTPH() {
    return Number(WHD.UPH_TARGET || 0);
  }

  function safeNum(v, fallback=0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function getAssociateProcessed(d) {
    return safeNum(d?.perf?.units, 0) || (d?.scanList ? d.scanList.filter(s => s.asin).length : 0) || (d?.scans ? d.scans.filter(s => s.asin).length : 0);
  }

  // Removed duplicate earlier getAssociateTPH() definition. Final clean definition is near bottom.

  function getTeamAvgTPH(data) {
    const vals = (data || []).map(getAssociateTPH).filter(v => v > 0);
    return vals.length ? vals.reduce((a,b)=>a+b,0) / vals.length : 0;
  }

  function getTargetValue() {
    return parseInt(localStorage.getItem('whd_daily_target') || '0', 10) || 0;
  }

  function setTargetValue(v) {
    localStorage.setItem('whd_daily_target', String(parseInt(v || '0', 10) || 0));
  }

  function emergencyWHDLauncher(message) {
    const existing = document.getElementById('whd-popup-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'whd-popup-overlay';
    overlay.innerHTML = `
      <div id="whd-popup-backdrop" style="position:fixed;inset:0;background:rgba(15,23,42,.52);z-index:999998"></div>
      <div id="whd-popup" style="position:fixed;z-index:999999;top:7vh;left:50%;transform:translateX(-50%);width:min(760px,94vw);background:#ffffff;color:#0f172a;border-radius:20px;border:1px solid #dbe3ec;box-shadow:0 30px 90px rgba(15,23,42,.35);font-family:Arial,sans-serif;overflow:hidden">
        <div style="padding:18px 20px;background:linear-gradient(135deg,#0f172a,#1d4ed8);color:white;display:flex;justify-content:space-between;gap:12px;align-items:center">
          <div><div style="font-size:18px;font-weight:900">WHD Popup View</div><div style="font-size:12px;opacity:.85">Popup loaded first. Full dashboard can open from here.</div></div>
          <button id="whd-popup-close" style="border:0;background:rgba(255,255,255,.16);color:white;border-radius:10px;padding:8px 10px;cursor:pointer">✕</button>
        </div>
        <div style="padding:20px">
          <div style="background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:14px;padding:14px;font-weight:800">${esc(message || 'Loading WHD associate data…')}</div>
          <p style="font-size:13px;color:#475569;line-height:1.45;margin:14px 0 18px">Keep this popup open while WHD rollup, PPR Rate, ASIN titles and Amazon categories load. If the full control-room UI fails for any reason, this fallback still lets you open the web page view.</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button id="whd-open-page" style="background:#2563eb;color:white;border:0;border-radius:12px;padding:11px 15px;font-weight:900;cursor:pointer">🌐 Open Web Page View</button>
            <button id="whd-retry-popup" style="background:#f8fafc;color:#0f172a;border:1px solid #cbd5e1;border-radius:12px;padding:11px 15px;font-weight:900;cursor:pointer">↻ Reload Popup</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#whd-open-page')?.addEventListener('click', openWHDFullPage);
    overlay.querySelector('#whd-retry-popup')?.addEventListener('click', () => safeShowWHDPopup('Retrying full popup view…'));
    overlay.querySelector('#whd-popup-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#whd-popup-backdrop')?.addEventListener('click', () => overlay.remove());
  }

  function refreshWHDDataKeepOpen() {
    const btn = document.getElementById('whd-refresh-all');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }

    // Full operational refresh without closing the dashboard:
    // - clear PPR metrics
    // - clear WHD function rollup
    // - clear current AA popup data
    // - force AR (WHD) mode to run again even if it was already active
    // ASIN title/category cache is intentionally kept so item titles reload fast.
    _pprWHDMetrics = null;
    _whdRollup = null;
    _jphCache = null;
    whdPopupData.length = 0;
    whdModeActive = false;
    window.__whdLoadingNow = true;

    try { runWHDMode(); }
    catch(e) {
      console.error('[WHD refresh failed]', e);
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
      safeShowWHDPopup('Refresh failed. Showing last available popup view.');
    }
  }

  function openGapReviewModal(btn) {
    const overlay = document.getElementById('whd-popup-overlay');
    const aa = btn.getAttribute('data-review-aa') || '—';
    const asin = btn.getAttribute('data-review-asin') || '';
    let gap = {};
    try { gap = JSON.parse((btn.getAttribute('data-review-gap') || '{}').replace(/&quot;/g,'"')); } catch(_){ gap = {}; }
    const fromAsin = (gap.asinBefore || '').toUpperCase();
    const toAsin = (gap.bridgeAsin || gap.asinAfter || asin || '').toUpperCase();
    const fromMeta = fromAsin ? (asinCategoryCache.get(fromAsin) || {}) : {};
    const toMeta = toAsin ? (asinCategoryCache.get(toAsin) || {}) : {};
    const fromTitle = fromMeta.title || (fromAsin ? asinTitleCache.get(fromAsin) : '') || 'Loading title…';
    const toTitle = toMeta.title || (toAsin ? asinTitleCache.get(toAsin) : '') || 'Loading title…';
    const fromCat = fromAsin ? classifyAsinItem(fromAsin, fromTitle) : {family:'—', icon:''};
    const toCat = toAsin ? classifyAsinItem(toAsin, toTitle) : {family:'—', icon:''};
    const modal = document.createElement('div');
    modal.className = 'whd-review-modal';
    modal.innerHTML = `<div class="whd-review-box">
      <h2>Gap Review</h2>
      <div class="row"><b>Associate:</b> ${esc(aa)}</div>
      <div class="row"><b>Gap:</b> ${esc(gap.mins || '—')} mins • ${esc(gap.timeBefore || '—')} → ${esc(gap.timeAfter || '—')} ${gap.q ? '• '+esc(gap.q) : ''}</div>
      <div class="row"><b>From item already processed:</b> ${fromAsin ? asinLink(fromAsin) : '—'}</div>
      <div class="row"><b>From title:</b> <span data-asin-title="${esc(fromAsin)}">${esc(fromTitle)}</span></div>
      <div class="row"><b>From category:</b> <span data-asin-classify="${esc(fromAsin)}">${esc((fromCat.icon||'') + ' ' + (fromCat.family||'—'))}</span></div>
      <hr style="border:0;border-top:1px solid #e2e8f0;margin:12px 0">
      <div class="row"><b>To / next scanned item:</b> ${toAsin ? asinLink(toAsin) : '—'}</div>
      <div class="row"><b>To title:</b> <span data-asin-title="${esc(toAsin)}">${esc(toTitle)}</span></div>
      <div class="row"><b>To category:</b> <span data-asin-classify="${esc(toAsin)}">${esc((toCat.icon||'') + ' ' + (toCat.family||'—'))}</span></div>
      <div class="row"><b>Note:</b><textarea placeholder="Add bridge note / context if needed"></textarea></div>
      <div class="actions"><button class="whd-review-close">Close</button><button class="whd-review-save">Save Note</button></div>
    </div>`;
    (overlay || document.body).appendChild(modal);
    loadAsinTitlesInPopup(modal);
    modal.querySelector('.whd-review-close').onclick = () => modal.remove();
    modal.querySelector('.whd-review-save').onclick = () => { modal.remove(); };
  }

  function safeShowWHDPopup(message) {
    try {
      showWHDPopup();
      const btn = document.getElementById('whd-open-page');
      if (btn) btn.textContent = '🌐 Open Web Page View';
    } catch (e) {
      console.error('[AR (WHD) popup failed]', e);
      emergencyWHDLauncher((message || 'Popup could not fully render yet.') + ' Error: ' + (e && e.message ? e.message : e));
    }
  }

  function refreshWHDPopup() {
    const existing = document.getElementById('whd-popup-overlay');
    if (existing) existing.remove();
    safeShowWHDPopup('Refreshing AR (WHD) popup…');
  }

  function csvEscape(v) {
    v = (v ?? '').toString().replace(/"/g, '""');
    return `"${v}"`;
  }

  function downloadWHDCSV() {
    const rows = [['AA Name','Time','ASIN','Title','Category','AA TPH','Total Processed']];
    whdPopupData.forEach(d => {
      const aaTph = getAssociateTPH(d).toFixed(1);
      const total = getAssociateProcessed(d);
      const scans = d.scanList || d.scans || [];
      scans.forEach(s => {
        if (!s.asin) return;
        const title = asinTitleCache.get(s.asin) || '';
        const cat = classifyAsinItem(s.asin, title);
        rows.push([d.name, absToHHMM(s.time), s.asin, title, `${cat.family || ''}${cat.type ? ' | '+cat.type : ''}`, aaTph, total]);
      });
      if (!scans.length) rows.push([d.name, '', '', '', '', aaTph, total]);
    });
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `whd_processed_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function activeWorkMinutesBetween(startAbs, endAbs) {
    if (!Number.isFinite(startAbs) || !Number.isFinite(endAbs) || endAbs <= startAbs) return 0;
    const shift = SHIFTS[activeShift] || SHIFTS.night;
    const isN = activeShift === 'night';
    let mins = endAbs - startAbs;
    shift.breaks.forEach(b => {
      let bs = toMin(b.start), be = toMin(b.end);
      if (isN && bs < 720) bs += 1440;
      if (isN && be < 720) be += 1440;
      const overlap = Math.max(0, Math.min(endAbs, be) - Math.max(startAbs, bs));
      mins -= overlap;
    });
    return Math.max(0, mins);
  }

  function getAssociateAvgTPH(d) {
    // 1) Preferred: WHD function rollup UPH from FCLM.
    let v = Number(d?.uph || d?.perf?.uph || 0);
    if (Number.isFinite(v) && v > 0) return v;

    // 2) Fallback: units / paid hours from rollup if UPH column is blank.
    const units = Number(d?.perf?.units || getAssociateUnits(d) || 0);
    const hrs = Number(d?.perf?.hrs || 0);
    if (units > 0 && hrs > 0) return units / hrs;

    // 3) Last fallback: use ItemGraded scan window excluding breaks so TPH still displays.
    const scans = (d?.scanList || d?.scans || []).filter(s => Number.isFinite(Number(s.time)));
    if (units > 0 && scans.length >= 2) {
      const times = scans.map(s => Number(s.time)).sort((a,b)=>a-b);
      const workMins = activeWorkMinutesBetween(times[0], times[times.length-1]);
      if (workMins > 0) return units / (workMins / 60);
    }
    return 0;
  }

  function getOverallWHDTPH() {
    // Preferred overall WHD TPH: ProcessPathRollup → Warehouse Deals Total → Actual TPH.
    // Per-AA TPH still comes from functionRollup/activityDetails; only overall WHD TPH is changed to PPR.
    const pprActual = getPPRActualWHDTPH();
    if (pprActual > 0) return pprActual;

    // Fallback: total WHD units / total WHD paid hours from function rollup.
    const units = whdPopupData.reduce((s,d)=>s + Number(d?.perf?.units || getAssociateUnits(d) || 0), 0);
    const hrs = whdPopupData.reduce((s,d)=>s + Number(d?.perf?.hrs || 0), 0);
    if (units > 0 && hrs > 0) return units / hrs;

    const vals = whdPopupData.map(getAssociateAvgTPH).filter(v => Number.isFinite(v) && v > 0);
    return vals.length ? vals.reduce((s,v)=>s+v,0) / vals.length : 0;
  }

  function getTeamAverageTPH() {
    // Team average for AA view comes from WHD function rollup, not PPR.
    return getTeamAvgTPH(whdPopupData);
  }

  function getExpectedTPHValue() {
    // Final agreed expected/planned WHD rate for associate comparison.
    return 9.61;
  }

  function getProcessedCount(d) {
    const rollup = Number(d?.perf?.units || 0);
    if (Number.isFinite(rollup) && rollup > 0) return rollup;
    return d?.scanList ? d.scanList.filter(s => s.asin).length : (d?.scans ? d.scans.filter(s => s.asin).length : 0);
  }

function typeBadgeHtml(title, asin) {
    const d = classifyAsinItem(asin, title || '');
    const colours = {
      tech: ['#dbe4ff','#3b5bdb'],
      'tech-adjacent': ['#fff3cd','#856404'],
      'non-tech': ['#e6fcf5','#087f5b'],
      large: ['#ffe3e3','#c92a2a'],
      unknown: ['#f1f3f5','#868e96']
    };
    const c = colours[d.cls] || colours.unknown;
    return `<span data-asin-classify="${asin||''}"
      style="font-size:10px;font-weight:800;padding:2px 7px;border-radius:12px;background:${c[0]};color:${c[1]};white-space:nowrap"
      title="${d.family}${d.type ? ' | '+d.type : ''}">${d.icon} ${d.family}${d.type ? ' | '+d.type : ''}</span>`;
  }

  function quarterBridgeData(d, q) {
    const expected = getExpectedTPHValue ? getExpectedTPHValue() : WHD.UPH_TARGET;
    const start = Number.isFinite(q.start) ? q.start : q.firstScan;
    const end = Number.isFinite(q.end) ? q.end : q.lastScan;
    const hrs = (Number.isFinite(start) && Number.isFinite(end) && end > start) ? (end - start) / 60 : 0;
    const expectedUnits = hrs > 0 ? Math.round(expected * hrs) : 0;
    const scans = (d.scanList || []).filter(s => {
      if (!Number.isFinite(s.time)) return false;
      if (Number.isFinite(q.start) && Number.isFinite(q.end)) return s.time >= q.start && s.time < q.end;
      if (Number.isFinite(q.firstScan) && Number.isFinite(q.lastScan)) return s.time >= q.firstScan && s.time <= q.lastScan;
      return false;
    });
    const actualUnits = scans.reduce((sum, s) => sum + (Number(s.qty || 1) || 1), 0);
    let techUnits = 0, largeUnits = 0, unknownUnits = 0;
    scans.forEach(s => {
      const qty = Number(s.qty || 1) || 1;
      const title = asinTitleCache.get(s.asin) || '';
      const det = classifyAsinItem(s.asin, title);
      const size = normSize(s.size || '');
      if (det.cls === 'tech' || det.cls === 'tech-adjacent') techUnits += qty;
      if (det.cls === 'large' || size === 'Large') largeUnits += qty;
      if (!title) unknownUnits += qty;
    });
    const gapMins = (q.gaps || []).reduce((sum, g) => sum + (Number(g.mins) || 0), 0);
    const miss = expectedUnits > 0 ? Math.max(0, expectedUnits - actualUnits) : 0;
    const pct = (n) => actualUnits > 0 ? Math.round((n / actualUnits) * 100) : 0;
    return {
      expected, hrs, expectedUnits, actualUnits, miss,
      techUnits, largeUnits, unknownUnits, gapMins,
      techPct: pct(techUnits), largePct: pct(largeUnits), unknownPct: pct(unknownUnits),
    };
  }

  function getShiftQuarterWindows() {
    const shift = SHIFTS[activeShift] || SHIFTS.night;
    const isN = activeShift === 'night';
    const sMin = toMin(shift.shiftStart), eMin = toMin(shift.shiftEnd);
    const sAbs = isN && sMin < 720 ? sMin + 1440 : sMin;
    const eAbs = isN && eMin < sMin ? eMin + 1440 : eMin;
    const brks = shift.breaks.map(b => {
      const bs = toMin(b.start), be = toMin(b.end);
      return { start: isN && bs < 720 ? bs + 1440 : bs, end: isN && be < 720 ? be + 1440 : be };
    });
    return [
      {label:'Q1', start:sAbs,       end:brks[0].start},
      {label:'Q2', start:brks[0].end,end:brks[1].start},
      {label:'Q3', start:brks[1].end,end:brks[2].start},
      {label:'Q4', start:brks[2].end,end:eAbs},
    ].map(q => ({...q, mins: Math.max(0, q.end - q.start)}));
  }

  function getOverallQuarterBridgeData() {
    const target = getTargetValue ? getTargetValue() : parseInt(localStorage.getItem('whd_daily_target') || '0', 10) || 0;
    const expected = getExpectedTPHValue ? getExpectedTPHValue() : Number(WHD.UPH_TARGET || 0);
    const quarters = getShiftQuarterWindows();
    const totalQMinutes = quarters.reduce((s,q)=>s+q.mins,0) || 1;
    const allScans = [];
    whdPopupData.forEach(d => (d.scanList || []).forEach(s => allScans.push({...s, aa:d.name})));
    return quarters.map(q => {
      const scans = allScans.filter(s => Number.isFinite(Number(s.time)) && Number(s.time) >= q.start && Number(s.time) < q.end);
      const actualUnits = scans.reduce((sum,s)=>sum+(Number(s.qty||1)||1),0);
      const qTarget = target > 0 ? Math.round(target * (q.mins / totalQMinutes)) : 0;
      let techUnits = 0, largeUnits = 0, unknownUnits = 0;
      scans.forEach(s => {
        const qty = Number(s.qty || 1) || 1;
        const title = asinTitleCache.get(s.asin) || '';
        const det = classifyAsinItem(s.asin, title);
        const size = normSize(s.size || '');
        if (!title) { unknownUnits += qty; }
        if (det.cls === 'tech') techUnits += qty;
        // Bridge can use FCLM size because large handling affects TPH/target pace, but the pie chart remains item-type only.
        if (det.cls === 'large' || size === 'Large') largeUnits += qty;
      });
      let gapMins = 0;
      whdPopupData.forEach(d => (d.qResults || []).forEach(qr => {
        if (qr.label === q.label) gapMins += (qr.gaps || []).reduce((s,g)=>s+(Number(g.mins)||0),0);
      }));
      const pct = n => actualUnits > 0 ? Math.round(n / actualUnits * 100) : 0;
      const miss = qTarget > 0 ? Math.max(0, qTarget - actualUnits) : 0;
      const reasons = [];
      if (pct(techUnits) >= 20) reasons.push(`${pct(techUnits)}% tech/testing`);
      if (pct(largeUnits) >= 20) reasons.push(`${pct(largeUnits)}% large`);
      if (pct(unknownUnits) >= 30) reasons.push(`${pct(unknownUnits)}% titles loading`);
      return {
        ...q, target:qTarget, actual:actualUnits, miss,
        techUnits, largeUnits, unknownUnits, gapMins,
        techPct:pct(techUnits), largePct:pct(largeUnits), unknownPct:pct(unknownUnits),
        reasons, status: qTarget > 0 ? (actualUnits >= qTarget ? 'hit' : 'miss') : 'no-target',
        expectedUnitsFromTPH: Math.round(expected * (q.mins / 60) * Math.max(1, whdPopupData.length || 1))
      };
    });
  }

  function getCurrentOverallBridgeData() {
    const rows = getOverallQuarterBridgeData();
    if (!rows.length) return null;

    const now = new Date();
    let nowMin = now.getHours() * 60 + now.getMinutes();
    if (activeShift === 'night' && nowMin < 12 * 60) nowMin += 1440;

    let current = rows.find(r => nowMin >= r.start && nowMin < r.end);
    if (!current) {
      // For old reports or outside shift time, show the latest quarter with work; otherwise Q1.
      current = [...rows].reverse().find(r => Number(r.actual || 0) > 0) || rows[0];
    }
    return current;
  }

  function overallQuarterBridgeHtml() {
    const r = getCurrentOverallBridgeData();
    const target = getTargetValue ? getTargetValue() : 0;
    if (!r) return `<div id="whd-overall-bridge" class="whd-bridge-line">Bridge: no quarter data available yet.</div>`;

    const pacePct = r.target > 0 ? Math.round((r.actual / Math.max(1, r.target)) * 100) : 0;
    const techText = (r.unknownPct >= 35 && r.techPct === 0)
      ? 'tech/electric items being processed'
      : `tech/electric ${r.techPct}%`;
    const largeText = r.actual > 0 ? `large/bulky ${r.largePct}%` : 'large/bulky items being processed';
    const mixText = `${techText} • ${largeText}`;
    const pprActual = getPPRActualWHDTPH();
    const pprPlan = getPPRPlanWHDTPH();
    const actualSupport = getPPRActualSupportHours();
    const plannedSupport = getPPRPlannedSupportHours();
    const pprText = (pprActual > 0 && pprPlan > 0)
      ? `PPR Actual TPH ${pprActual.toFixed(2)} vs Plan ${pprPlan.toFixed(2)}.`
      : `PPR Actual/Plan TPH loading or unavailable.`;
    const supportText = (actualSupport || plannedSupport)
      ? `Support hrs ${actualSupport.toFixed(1)} actual vs ${plannedSupport.toFixed(1)} planned.`
      : `Support hrs unavailable from PPR.`;
    const impactText = `${pprText} ${supportText} Tech/electric and large items can affect grading pace.`;

    let msg;
    if (!target || r.status === 'no-target') {
      msg = `${r.label} Bridge: ${r.actual} units processed • ${mixText}. ${impactText}`;
    } else if (r.status === 'miss') {
      msg = `${r.label} Bridge: ${r.actual}/${r.target} units (${pacePct}%), short ${r.miss} • ${mixText}. ${impactText}`;
    } else {
      msg = `${r.label} Bridge: ${r.actual}/${r.target} units (${pacePct}%) on target • ${mixText}. Item mix is being monitored.`;
    }

    const tone = r.status === 'miss' ? 'warn' : (r.status === 'hit' ? 'good' : 'neutral');
    return `<div id="whd-overall-bridge" class="whd-bridge-line ${tone}">
      <span>${msg}</span>
      <span class="whd-bridge-pill">Daily target: ${target || 'not set'}</span>
    </div>`;
  }

  function refreshOverallQuarterBridge(popupEl) {
    const box = popupEl?.querySelector('#whd-overall-bridge');
    if (!box) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = overallQuarterBridgeHtml();
    box.replaceWith(wrap.firstElementChild);
  }

  // Build the "Items processed" table for each AA card.
  // This was missing in v18.7 and caused: ReferenceError: processedItemsHtml is not defined.
  function processedItemsHtml(d) {
    const scans = Array.isArray(d?.scanList) ? d.scanList.filter(s => s && s.asin) : [];
    if (!scans.length) {
      return `<div class="muted" style="padding:10px 0">No processed ASIN scans found yet. Keep popup open while WHD activity details load.</div>`;
    }

    const byAsin = new Map();
    scans.forEach(s => {
      const asin = String(s.asin || '').trim().toUpperCase();
      if (!asin) return;
      const qty = Math.max(1, Number(s.qty || 1) || 1);
      const time = Number(s.time || 0);
      const current = byAsin.get(asin) || { asin, qty:0, sizeCounts:{Small:0, Medium:0, Large:0, Other:0}, first:time, last:time };
      current.qty += qty;
      const size = normSize(s.size || '');
      if (size === 'Small') current.sizeCounts.Small += qty;
      else if (size === 'Medium') current.sizeCounts.Medium += qty;
      else if (size === 'Large') current.sizeCounts.Large += qty;
      else current.sizeCounts.Other += qty;
      current.first = Math.min(current.first || time, time);
      current.last = Math.max(current.last || time, time);
      byAsin.set(asin, current);
    });

    const rows = [...byAsin.values()].sort((a,b) => b.qty - a.qty || String(a.asin).localeCompare(String(b.asin))).slice(0, 80);
    const totalUnique = byAsin.size;
    const totalUnits = rows.reduce((sum,r)=>sum+r.qty,0);

    const rowHtml = rows.map(r => {
      const meta = asinCategoryCache.get(r.asin) || {};
      const title = meta.title || asinTitleCache.get(r.asin) || '';
      const cat = classifyAsinItem(r.asin, title);
      const sizeTxt = ['Small','Medium','Large','Other'].filter(k => r.sizeCounts[k]).map(k => `${k[0]}:${r.sizeCounts[k]}`).join(' ');
      const source = cat.source === 'amazon-category' ? 'Amazon category' : (title ? 'Title fallback' : 'Loading');
      return `<tr>
        <td>${asinLink(r.asin)}</td>
        <td><span data-asin-classify="${esc(r.asin)}" class="cr-cat-pill">${esc(cat.icon)} ${esc(cat.family)}${cat.source === 'amazon-category' ? ' ✓' : ''}</span><br><small class="muted">${esc(source)}${meta.rawCategory ? ' • ' + esc(meta.rawCategory).slice(0,95) : ''}</small></td>
        <td><b>${r.qty}</b><br><small class="muted">${esc(sizeTxt || '—')}</small></td>
        <td><small>${r.first ? esc(absToHHMM(r.first)) : '—'} → ${r.last ? esc(absToHHMM(r.last)) : '—'}</small></td>
      </tr>`;
    }).join('');

    return `<div class="cr-items-summary">${totalUnique} unique ASINs • ${totalUnits} shown units${totalUnique > rows.length ? ` • showing top ${rows.length}` : ''}</div>
      <table class="cr-table cr-items-table"><thead><tr><th>ASIN / Title</th><th>Amazon Category</th><th>Qty / Size</th><th>Time</th></tr></thead><tbody>${rowHtml}</tbody></table>`;
  }
  function arGetTPH(d) {
    const vals = [d?.uph, d?.perf?.uph, d?.perf?.UPH, d?.perf?.tph, d?.perf?.TPH];
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const units = Number(d?.perf?.units || 0);
    const hrs = Number(d?.perf?.hrs || d?.hrs || 0);
    if (units > 0 && hrs > 0) return units / hrs;
    return 0;
  }

  function arGetTotalItems(d) {
    const units = Number(d?.perf?.units || 0);
    if (Number.isFinite(units) && units > 0) return units;
    const scans = d?.scans || d?.scanList || [];
    return scans.filter(s => s.asin).length;
  }

  function arAllGaps(d) {
    const out = [];
    (d?.qResults || []).forEach(q => (q.gaps || []).forEach(g => out.push(Object.assign({quarter:q.label}, g))));
    return out;
  }

  function arLargestGap(d) {
    const gaps = arAllGaps(d);
    if (!gaps.length) return null;
    return gaps.slice().sort((a,b) => (b.mins||0) - (a.mins||0))[0];
  }

  function arGapAsin(g) {
    return (g?.gapAsin || g?.bridgeAsin || g?.asinAfter || g?.asinBefore || '').toUpperCase();
  }

  function arGapItemCell(g) {
    const asin = arGapAsin(g);
    if (!asin) return `<span style="color:#94a3b8;font-weight:700">—</span>`;
    const title = asinTitleCache.get(asin) || '';
    const meta = classifyAsinItem(asin, title);
    return `<div style="display:flex;flex-direction:column;gap:4px;min-width:260px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <a href="${fcResearchUrl(asin)}" target="_blank"
           style="font-family:monospace;font-size:11px;font-weight:900;color:#0369a1;background:#e0f2fe;padding:3px 8px;border-radius:999px;text-decoration:none">${asin}</a>
        <span data-asin-classify="${asin}"
          style="font-size:10px;font-weight:900;padding:3px 8px;border-radius:999px;background:#f1f5f9;color:#64748b">Category pending</span>
      </div>
      <div data-asin-title="${asin}" style="font-size:11px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px">—</div>
    </div>`;
  }

  function arRowStatus(d) {
    const tph = arGetTPH(d);
    const gaps = arAllGaps(d);
    if (gaps.length && tph < WHD.UPH_TARGET) return 'review';
    if (gaps.length) return 'gaps';
    if (tph >= WHD.UPH_TARGET) return 'good';
    return 'watch';
  }

  function arBuildAATableRows(data) {
    const sorted = [...data].sort((a,b) => {
      const sg = arAllGaps(b).length - arAllGaps(a).length;
      if (sg) return sg;
      return arGetTPH(b) - arGetTPH(a);
    });

    return sorted.map(d => {
      const tph = arGetTPH(d);
      const gaps = arAllGaps(d);
      const largest = arLargestGap(d);
      const gapMins = gaps.reduce((s,g)=>s+(Number(g.mins)||0),0);
      const maxGap = largest ? Number(largest.mins || 0) : 0;
      const rowStatus = arRowStatus(d);
      const rowBg = rowStatus === 'review' ? '#fff7ed' : rowStatus === 'good' ? '#f0fdf4' : '#ffffff';
      const gapText = largest
        ? `<strong style="color:${maxGap>=15?'#dc2626':'#b45309'}">${maxGap}m</strong>
           <div style="font-size:10px;color:#64748b">${largest.timeBefore||''} → ${largest.timeAfter||''}${largest.breakAdjusted ? ` • ${largest.breakLabel} break-adj` : ''}</div>
           ${(largest.beforeBreakGap||0) >= WHD.GAP_MIN ? `<div style="font-size:10px;color:#b45309">Before break: ${largest.beforeBreakGap}m</div>` : ''}
           ${(largest.afterBreakGap||0) >= WHD.GAP_MIN ? `<div style="font-size:10px;color:#b45309">After break: ${largest.afterBreakGap}m</div>` : ''}`
        : `<span style="color:#64748b;font-weight:800">0m</span>`;

      return `<tr class="ar-aa-row" data-aa-name="${String(d.name||'').toLowerCase()}" data-filter-status="${rowStatus}"
            style="background:${rowBg};border-bottom:1px solid #e2e8f0">
        <td style="padding:12px 10px;font-weight:900;color:#1e40af;min-width:170px">
          ${d.detailUrl ? `<a href="${d.detailUrl}" target="_blank" style="color:#1e40af;text-decoration:none">${d.name}</a>` : d.name}
        </td>
        <td style="padding:12px 10px;font-weight:900;color:${tph>=WHD.UPH_TARGET?'#166534':'#b45309'};white-space:nowrap">
          ${tph ? tph.toFixed(1) : '—'}
          <div style="font-size:10px;color:#64748b">Exp ${WHD.UPH_TARGET}</div>
        </td>
        <td style="padding:12px 10px;white-space:nowrap">${gapText}</td>
        <td style="padding:12px 10px">${largest ? arGapItemCell(largest) : '<span style="color:#94a3b8;font-weight:800">No before-processing item</span>'}</td>
        <td style="padding:12px 10px;font-weight:900;color:#111827;text-align:center">${arGetTotalItems(d)}</td>
        <td style="padding:12px 10px;text-align:center">
          <button class="ar-show-gaps" data-aa="${String(d.name||'').replace(/"/g,'&quot;')}"
            style="background:#0f172a;color:white;border:0;border-radius:10px;padding:6px 11px;font-size:12px;font-weight:900;cursor:pointer">
            ${gaps.length}
          </button>
          <button class="ar-show-items" data-aa="${String(d.name||'').replace(/"/g,'&quot;')}"
            style="margin-left:6px;background:#475569;color:white;border:0;border-radius:10px;padding:6px 11px;font-size:12px;font-weight:900;cursor:pointer">
            Items
          </button>
        </td>
      </tr>
      <tr class="ar-aa-detail" data-aa-detail="${String(d.name||'').replace(/"/g,'&quot;')}" style="display:none;background:#f8fafc">
        <td colspan="6" style="padding:12px 18px">
          <div class="ar-detail-content" style="font-size:12px;color:#334155">Select Gaps or Items.</div>
        </td>
      </tr>`;
    }).join('');
  }

  function arBuildItemsDetail(d) {
    const scans = (d?.scans || d?.scanList || []).filter(s=>s.asin);
    if (!scans.length) return `<div style="color:#64748b;font-weight:700">No processed ASIN list found.</div>`;
    return `<div style="max-height:320px;overflow:auto;border:1px solid #e2e8f0;border-radius:10px;background:white">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead style="position:sticky;top:0;background:#f1f5f9;z-index:1">
          <tr>
            <th style="text-align:left;padding:8px">Time</th>
            <th style="text-align:left;padding:8px">ASIN</th>
            <th style="text-align:left;padding:8px">Title</th>
            <th style="text-align:left;padding:8px">Category</th>
          </tr>
        </thead>
        <tbody>
          ${scans.map(s => {
            const asin = String(s.asin||'').toUpperCase();
            return `<tr style="border-top:1px solid #e2e8f0">
              <td style="padding:8px;color:#64748b;font-weight:700">${absToHHMM(s.time)}</td>
              <td style="padding:8px"><a href="${fcResearchUrl(asin)}" target="_blank" style="font-family:monospace;font-weight:900;color:#0369a1">${asin}</a></td>
              <td style="padding:8px"><span data-asin-title="${asin}" style="color:#334155">—</span></td>
              <td style="padding:8px"><span data-asin-classify="${asin}" style="font-size:10px;font-weight:900;padding:3px 8px;border-radius:999px;background:#f1f5f9;color:#64748b">Category pending</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  }

  function arBuildGapsDetail(d) {
    const gaps = arAllGaps(d);
    if (!gaps.length) return `<div style="color:#64748b;font-weight:700">No gaps detected.</div>`;
    return `<div style="display:flex;flex-direction:column;gap:8px">
      ${gaps.map(g => {
        const asin = arGapAsin(g);
        return `<div style="background:white;border:1px solid #e2e8f0;border-radius:10px;padding:10px">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <strong style="color:${g.mins>=15?'#dc2626':'#b45309'}">${g.mins}m gap</strong>
            <span style="color:#64748b">${g.timeBefore||''} → ${g.timeAfter||''}</span>
            ${g.breakAdjusted ? `<span style="background:#fff7ed;color:#b45309;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:900">${g.breakLabel} break adjusted</span>` : ''}
            ${(g.beforeBreakGap||0)>=WHD.GAP_MIN ? `<span style="background:#fef3c7;color:#92400e;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:900">Before break ${g.beforeBreakGap}m</span>` : ''}
            ${(g.afterBreakGap||0)>=WHD.GAP_MIN ? `<span style="background:#fef3c7;color:#92400e;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:900">After break ${g.afterBreakGap}m</span>` : ''}
          </div>
          <div style="margin-top:7px">${asin ? arGapItemCell(g) : 'No ASIN'}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function arInstallTableHandlers(overlay) {
    const search = overlay.querySelector('#ar-aa-search');
    const filter = overlay.querySelector('#ar-aa-filter');
    const apply = () => {
      const q = (search?.value || '').toLowerCase().trim();
      const f = filter?.value || 'all';
      overlay.querySelectorAll('.ar-aa-row').forEach(row => {
        const okName = !q || row.getAttribute('data-aa-name').includes(q);
        const st = row.getAttribute('data-filter-status');
        const okFilter = f === 'all' || st === f || (f === 'hasgaps' && (st === 'gaps' || st === 'review'));
        row.style.display = okName && okFilter ? '' : 'none';
        const next = row.nextElementSibling;
        if (next && next.classList.contains('ar-aa-detail') && row.style.display === 'none') next.style.display = 'none';
      });
    };
    if (search) search.addEventListener('input', apply);
    if (filter) filter.addEventListener('change', apply);

    overlay.querySelectorAll('.ar-show-items,.ar-show-gaps').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-aa');
        const d = whdPopupData.find(x => String(x.name) === String(name));
        const detail = overlay.querySelector(`[data-aa-detail="${CSS.escape(name)}"]`);
        if (!detail || !d) return;
        const content = detail.querySelector('.ar-detail-content');
        const opening = detail.style.display === 'none' || btn.dataset.mode !== (btn.classList.contains('ar-show-items') ? 'items' : 'gaps');
        overlay.querySelectorAll('.ar-aa-detail').forEach(x => x.style.display = 'none');
        overlay.querySelectorAll('.ar-show-items,.ar-show-gaps').forEach(x => delete x.dataset.mode);
        if (!opening) return;
        if (btn.classList.contains('ar-show-items')) {
          btn.dataset.mode = 'items';
          content.innerHTML = arBuildItemsDetail(d);
        } else {
          btn.dataset.mode = 'gaps';
          content.innerHTML = arBuildGapsDetail(d);
        }
        detail.style.display = '';
        arV195ForceReplaceTable(overlay);
    arV195InstallHandlers(overlay);
    loadAsinTitlesInPopup(overlay);
    arInstallTableHandlers(overlay);
      });
    });
  }
  function arV195GetTPH(d) {
    const values = [d?.uph, d?.perf?.uph, d?.perf?.UPH, d?.perf?.tph, d?.perf?.TPH];
    for (const v of values) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const units = Number(d?.perf?.units || 0);
    const hrs = Number(d?.perf?.hrs || d?.hrs || 0);
    if (units > 0 && hrs > 0) return units / hrs;
    return 0;
  }

  function arV195AllScans(d) {
    const scans = d?.scans || d?.scanList || d?.items || [];
    return Array.isArray(scans) ? scans.filter(s => s && s.asin) : [];
  }

  function arV195TotalItems(d) {
    const units = Number(d?.perf?.units || 0);
    if (Number.isFinite(units) && units > 0) return units;
    return arV195AllScans(d).length;
  }

  function arV195AllGaps(d) {
    const out = [];
    (d?.qResults || []).forEach(q => (q.gaps || []).forEach(g => out.push(Object.assign({quarter:q.label}, g))));
    return out;
  }

  function arV195LargestGap(d) {
    const gaps = arV195AllGaps(d);
    if (!gaps.length) return null;
    return gaps.slice().sort((a,b) => (Number(b.mins)||0) - (Number(a.mins)||0))[0];
  }

  function arV195GapAsin(g) {
    return String(g?.gapAsin || g?.bridgeAsin || g?.asinAfter || g?.asinBefore || '').toUpperCase();
  }

  function arV195CategoryLabel(asin) {
    asin = String(asin || '').toUpperCase();
    const title = asinTitleCache.get(asin) || '';
    const meta = (typeof classifyAsinItem === 'function') ? classifyAsinItem(asin, title) : classifyItemDetailed(title);
    if (!asin) return '—';
    if (!title) return 'Loading category…';
    return `${meta.icon || ''} ${meta.family || 'Other'}${meta.type ? ' | ' + meta.type : ''}`;
  }

  function arV195TitleText(asin) {
    asin = String(asin || '').toUpperCase();
    return asinTitleCache.get(asin) || '';
  }

  function arV195GapItemCell(g) {
    const asin = arV195GapAsin(g);
    if (!asin) return `<span style="color:#94a3b8;font-weight:800">No before-processing item</span>`;
    return `<div class="ar-gap-cell" data-gap-asin="${asin}" style="display:flex;flex-direction:column;gap:4px;min-width:360px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <a href="${fcResearchUrl(asin)}" target="_blank"
          style="font-family:monospace;font-size:11px;font-weight:900;color:#0369a1;background:#e0f2fe;padding:3px 8px;border-radius:999px;text-decoration:none">${asin}</a>
        <span data-asin-classify="${asin}" class="ar-gap-category"
          style="font-size:10px;font-weight:900;padding:3px 8px;border-radius:999px;background:#f1f5f9;color:#64748b">Loading category…</span>
      </div>
      <div data-asin-title="${asin}" class="ar-gap-title"
        style="font-size:11px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:560px">Loading title…</div>
    </div>`;
  }

  function arV195BuildItemsDetail(d) {
    const scans = arV195AllScans(d);
    if (!scans.length) return `<div style="font-size:12px;color:#64748b;font-weight:800;padding:10px">No item-level WHD scans found for this AA.</div>`;
    return `<div style="max-height:360px;overflow:auto;border:1px solid #e2e8f0;border-radius:10px;background:white">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead style="position:sticky;top:0;background:#f8fafc;z-index:2;color:#475569;text-transform:uppercase;font-size:11px">
          <tr>
            <th style="text-align:left;padding:8px">Time</th>
            <th style="text-align:left;padding:8px">ASIN</th>
            <th style="text-align:left;padding:8px">Title</th>
            <th style="text-align:left;padding:8px">Category</th>
            <th style="text-align:left;padding:8px">Size</th>
          </tr>
        </thead>
        <tbody>
          ${scans.map(s => {
            const asin = String(s.asin || '').toUpperCase();
            return `<tr style="border-top:1px solid #e2e8f0">
              <td style="padding:8px;color:#64748b;font-weight:800">${absToHHMM(s.time)}</td>
              <td style="padding:8px"><a href="${fcResearchUrl(asin)}" target="_blank" style="font-family:monospace;color:#0369a1;font-weight:900">${asin}</a></td>
              <td style="padding:8px"><span data-asin-title="${asin}">Loading title…</span></td>
              <td style="padding:8px"><span data-asin-classify="${asin}" style="font-size:10px;font-weight:900;padding:3px 8px;border-radius:999px;background:#f1f5f9;color:#64748b">Loading category…</span></td>
              <td style="padding:8px;color:#475569;font-weight:800">${s.size || '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  }

  function arV195BuildGapsDetail(d) {
    const gaps = arV195AllGaps(d);
    if (!gaps.length) return `<div style="font-size:12px;color:#64748b;font-weight:800;padding:10px">No gaps detected for this AA.</div>`;
    return `<div style="display:flex;flex-direction:column;gap:8px">
      ${gaps.map(g => {
        const asin = arV195GapAsin(g);
        return `<div style="background:white;border:1px solid #e2e8f0;border-radius:10px;padding:10px">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <strong style="color:${g.mins>=15?'#dc2626':'#b45309'}">${g.mins}m gap</strong>
            <span style="font-size:11px;color:#64748b;font-weight:800">${g.timeBefore || ''} → ${g.timeAfter || ''}</span>
            ${g.breakAdjusted ? `<span style="font-size:10px;background:#fff7ed;color:#b45309;border-radius:999px;padding:2px 7px;font-weight:900">${g.breakLabel || ''} break adjusted</span>` : ''}
            ${(g.beforeBreakGap||0) >= WHD.GAP_MIN ? `<span style="font-size:10px;background:#fef3c7;color:#92400e;border-radius:999px;padding:2px 7px;font-weight:900">Before break ${g.beforeBreakGap}m</span>` : ''}
            ${(g.afterBreakGap||0) >= WHD.GAP_MIN ? `<span style="font-size:10px;background:#fef3c7;color:#92400e;border-radius:999px;padding:2px 7px;font-weight:900">After break ${g.afterBreakGap}m</span>` : ''}
          </div>
          <div style="margin-top:8px">${asin ? arV195GapItemCell(g) : '<span style="color:#94a3b8">No ASIN</span>'}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function arV195Status(d) {
    const tph = arV195GetTPH(d);
    const gaps = arV195AllGaps(d);
    if (gaps.length && tph < WHD.UPH_TARGET) return 'review';
    if (gaps.length) return 'hasgaps';
    if (tph >= WHD.UPH_TARGET) return 'good';
    return 'below';
  }

  function arV195BuildRows() {
    return [...whdPopupData].sort((a,b) => {
      const ga = arV195AllGaps(a).length, gb = arV195AllGaps(b).length;
      if (gb !== ga) return gb - ga;
      return arV195GetTPH(b) - arV195GetTPH(a);
    }).map(d => {
      const tph = arV195GetTPH(d);
      const largest = arV195LargestGap(d);
      const gaps = arV195AllGaps(d);
      const gapMins = largest ? Number(largest.mins || 0) : 0;
      const status = arV195Status(d);
      const rowBg = status === 'review' ? '#fff7ed' : status === 'good' ? '#f0fdf4' : '#ffffff';
      const gapInfo = largest
        ? `<strong style="color:${gapMins>=15?'#dc2626':'#b45309'}">${gapMins}m</strong>
           <div style="font-size:10px;color:#64748b">${largest.timeBefore||''} → ${largest.timeAfter||''}</div>
           ${(largest.beforeBreakGap||0) >= WHD.GAP_MIN ? `<div style="font-size:10px;color:#92400e">Before break: ${largest.beforeBreakGap}m</div>` : ''}
           ${(largest.afterBreakGap||0) >= WHD.GAP_MIN ? `<div style="font-size:10px;color:#92400e">After break: ${largest.afterBreakGap}m</div>` : ''}`
        : `<span style="font-weight:900;color:#64748b">0m</span>`;

      const safeName = String(d.name || '').replace(/"/g,'&quot;');

      return `<tr class="ar195-aa-row" data-aa-name="${safeName.toLowerCase()}" data-status="${status}" style="background:${rowBg};border-top:1px solid #e2e8f0">
        <td style="padding:12px 10px;font-weight:900;color:#1e3a8a;min-width:170px">
          ${d.detailUrl ? `<a href="${d.detailUrl}" target="_blank" style="color:#1e3a8a;text-decoration:none">${d.name}</a>` : d.name}
        </td>
        <td style="padding:12px 10px;font-weight:900;color:${tph>=WHD.UPH_TARGET?'#166534':'#b45309'};white-space:nowrap">
          ${tph ? tph.toFixed(1) : '—'}
          <div style="font-size:10px;color:#64748b">Exp ${WHD.UPH_TARGET}</div>
        </td>
        <td style="padding:12px 10px;white-space:nowrap">${gapInfo}</td>
        <td style="padding:12px 10px">${largest ? arV195GapItemCell(largest) : '<span style="color:#94a3b8;font-weight:800">No before-processing item</span>'}</td>
        <td style="padding:12px 10px;text-align:center;font-weight:900;color:#0f172a">${arV195TotalItems(d)}</td>
        <td style="padding:12px 10px;text-align:center;white-space:nowrap">
          <button class="ar195-show-gaps" data-aa="${safeName}" style="background:#0f172a;color:white;border:0;border-radius:10px;padding:6px 11px;font-size:12px;font-weight:900;cursor:pointer">${gaps.length}</button>
          <div style="margin-top:5px;font-size:10px;color:#64748b;font-weight:800">click for gap details</div>
          <button class="ar195-show-items" data-aa="${safeName}" style="margin-top:6px;background:#475569;color:white;border:0;border-radius:10px;padding:5px 9px;font-size:11px;font-weight:900;cursor:pointer">Items</button>
        </td>
      </tr>
      <tr class="ar195-aa-detail" data-aa-detail="${safeName}" style="display:none;background:#f8fafc">
        <td colspan="6" style="padding:12px 18px">
          <div class="ar195-detail-content" style="font-size:12px;color:#334155"></div>
        </td>
      </tr>`;
    }).join('');
  }

  function arV195SectionHtml() {
    return `<div id="ar195-aa-section" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:16px 18px;margin-top:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <div style="font-size:18px;font-weight:900;color:#0f172a">AA Items &amp; Gaps</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px">V1 shareable view: Associate, TPH, GAP, Before processing, Total Items and Total Gaps.</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="ar195-search" placeholder="Search AA"
            style="width:220px;padding:9px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:13px">
          <select id="ar195-filter"
            style="width:155px;padding:9px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:13px">
            <option value="all">All</option>
            <option value="review">Needs Review</option>
            <option value="hasgaps">Has Gaps</option>
            <option value="below">Below Target</option>
            <option value="good">Good</option>
          </select>
        </div>
      </div>
      <div style="overflow:auto;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff">
        <table id="ar195-aa-table" style="width:100%;border-collapse:collapse;font-size:13px">
          <thead style="background:#f8fafc;color:#475569;text-transform:uppercase;font-size:11px;letter-spacing:.04em">
            <tr>
              <th style="text-align:left;padding:11px 10px;min-width:170px">Associate</th>
              <th style="text-align:left;padding:11px 10px;width:90px">TPH</th>
              <th style="text-align:left;padding:11px 10px;width:130px">GAP</th>
              <th style="text-align:left;padding:11px 10px;width:32%">Before processing</th>
              <th style="text-align:center;padding:11px 10px;width:120px">Total Items</th>
              <th style="text-align:center;padding:11px 10px;width:150px">Total Gaps</th>
            </tr>
          </thead>
          <tbody>${arV195BuildRows()}</tbody>
        </table>
      </div>
    </div>`;
  }

  function arV195ForceReplaceTable(overlay) {
    if (!overlay) return;
    const old = [...overlay.querySelectorAll('div')].find(el => /AA Items\s*&\s*Gaps/i.test(el.textContent || '') && !el.querySelector('#ar195-aa-table'));
    const html = arV195SectionHtml();
    if (old) {
      // Find a reasonable card container around the old section
      let card = old;
      for (let i=0; i<4 && card.parentElement; i++) {
        if ((card.parentElement.textContent || '').includes('AA Items') && card.parentElement.querySelector('table')) {
          card = card.parentElement;
        }
      }
      card.outerHTML = html;
    } else {
      const body = overlay.querySelector('#whd-popup > div[style*="overflow-y"]') || overlay.querySelector('#whd-popup');
      if (body && !overlay.querySelector('#ar195-aa-section')) body.insertAdjacentHTML('beforeend', html);
    }
  }

  function arV195InstallHandlers(overlay) {
    const search = overlay.querySelector('#ar195-search');
    const filter = overlay.querySelector('#ar195-filter');

    const apply = () => {
      const q = (search?.value || '').trim().toLowerCase();
      const f = filter?.value || 'all';
      overlay.querySelectorAll('.ar195-aa-row').forEach(row => {
        const okName = !q || (row.getAttribute('data-aa-name') || '').includes(q);
        const status = row.getAttribute('data-status') || '';
        const okFilter = f === 'all' || status === f || (f === 'hasgaps' && (status === 'hasgaps' || status === 'review'));
        row.style.display = okName && okFilter ? '' : 'none';
        const detail = row.nextElementSibling;
        if (detail && detail.classList.contains('ar195-aa-detail') && row.style.display === 'none') detail.style.display = 'none';
      });
    };

    if (search) search.addEventListener('input', apply);
    if (filter) filter.addEventListener('change', apply);

    overlay.querySelectorAll('.ar195-show-items,.ar195-show-gaps').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-aa');
        const d = whdPopupData.find(x => String(x.name || '') === String(name));
        const detail = overlay.querySelector(`[data-aa-detail="${CSS.escape(name)}"]`);
        if (!d || !detail) return;

        const content = detail.querySelector('.ar195-detail-content');
        const mode = btn.classList.contains('ar195-show-items') ? 'items' : 'gaps';
        const alreadyOpen = detail.style.display !== 'none' && detail.getAttribute('data-mode') === mode;

        overlay.querySelectorAll('.ar195-aa-detail').forEach(x => { x.style.display = 'none'; x.removeAttribute('data-mode'); });
        if (alreadyOpen) return;

        detail.setAttribute('data-mode', mode);
        content.innerHTML = mode === 'items' ? arV195BuildItemsDetail(d) : arV195BuildGapsDetail(d);
        detail.style.display = '';
        loadAsinTitlesInPopup(overlay);
      });
    });
  }

function showWHDPopup() {
const existing = document.getElementById('whd-popup-overlay');
    if (existing) existing.remove();

    const ppr = _pprWHDMetrics || {};
    const actualRate = Number(ppr.actualTPH || 0); // Source of truth: PPR Warehouse Deals actual Rate
    const planRate = 9.61;                         // Agreed expected/planned WHD rate for now
    const actualUnits = Number(ppr.actualUnits || 0);
    const planUnits = Number(ppr.planUnits || 0);
    const manualTarget = getTargetValue();
    const activeTargetUnits = manualTarget || planUnits;
    const actualHours = Number(ppr.actualHours || 0);
    const planHours = Number(ppr.planHours || 0);
    const pctPlan = planRate ? Math.round((actualRate / planRate) * 100) : 0;
    const rateState = !actualRate ? 'neutral' : (actualRate < planRate ? 'bad' : 'good');
    const expected = 9.61;
    const teamAvg = getTeamAvgTPH(whdPopupData); // Average TPH of all AAs from WHD function rollup
    const dateStr = (new URLSearchParams(location.search).get('startDateIntraday')||'').replace(/\//g,'-') || 'Current report';

    const sorted = [...whdPopupData].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
    const gapsForAA = d => (d.qResults||[]).flatMap(q => (q.gaps||[]).map(g => ({ aa:d.name, detailUrl:d.detailUrl, q:q.label, ...g })));
    const allGaps = sorted.flatMap(gapsForAA);
    const totalGapMins = allGaps.reduce((s,g)=>s+Number(g.mins||0),0);
    const totalUnits = sorted.reduce((s,d)=>s+(getAssociateUnits ? getAssociateUnits(d) : 0),0);

    const gapJson = g => esc(JSON.stringify(g || {}).replace(/"/g,'&quot;'));
    const itemMeta = asin => {
      asin = String(asin || '').toUpperCase();
      const meta = asin ? (asinCategoryCache.get(asin) || {}) : {};
      const title = meta.title || (asin ? asinTitleCache.get(asin) : '') || '';
      const cat = asin ? classifyAsinItem(asin, title) : null;
      return { asin, meta, title, cat };
    };
    const itemCell = (asin, small=true) => {
      const m = itemMeta(asin);
      if (!m.asin) return '—';
      return `${asinLink(m.asin)}<br><small data-asin-title="${esc(m.asin)}">${m.title ? esc(m.title) : 'Loading title…'}</small>`;
    };
    const catCell = asin => {
      const m = itemMeta(asin);
      if (!m.asin || !m.cat) return '—';
      return `<span class="cr-cat-pill" data-asin-classify="${esc(m.asin)}">${esc(m.cat.icon)} ${esc(m.cat.family)}</span>`;
    };

    const mainCatForAA = d => {
      const counts = {};
      (d.scanList||[]).forEach(s => {
        if (!s.asin) return;
        const m = itemMeta(s.asin);
        const key = m.cat?.family || 'Loading';
        counts[key] = (counts[key] || 0) + (Number(s.qty||1)||1);
      });
      const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
      return top ? `${top[0]} (${top[1]})` : 'Loading';
    };

    const lastGapForAA = d => {
      const gaps = gapsForAA(d);
      return gaps.sort((a,b)=>Number(b.mins||0)-Number(a.mins||0))[0] || null;
    };

    const aaRows = sorted.map((d, idx) => {
      const tph = getAssociateAvgTPH(d);
      const units = getAssociateUnits(d);
      const hrs = d?.perf?.hrs || (tph ? units / tph : 0);
      const gaps = gapsForAA(d).sort((a,b)=>Number(b.mins||0)-Number(a.mins||0));
      const gap = gaps[0] || null;
      const gapAsin = gap?.bridgeAsin || gap?.asinAfter || '';
      const status = gaps.length || (tph && tph < expected) ? 'Review' : 'Stable';
      const gapTarget = `whd-gap-details-${idx}`;
      const gapRows = gaps.map(g => {
        const fromAsin = g.asinBefore || '';
        const toAsin = g.bridgeAsin || g.asinAfter || '';
        return `<tr class="whd-gap-row-detail">
          <td><b>${esc(g.mins)}m</b><br><small>${esc(g.timeBefore)} → ${esc(g.timeAfter)} • ${esc(g.q)}${g.breakAdjusted ? ' • break adjusted' : ''}</small></td>
          <td>${itemCell(fromAsin)}</td>
          <td>${catCell(fromAsin)}</td>
          <td>${itemCell(toAsin)}</td>
          <td>${catCell(toAsin)}</td>
          <td><button class="whd-review-btn" data-review-aa="${esc(d.name)}" data-review-asin="${esc(toAsin)}" data-review-gap="${gapJson(g)}">🔍 Review</button></td>
        </tr>`;
      }).join('') || `<tr><td colspan="6" class="muted">No ${WHD.GAP_MIN}+ min scan gaps for this AA.</td></tr>`;

      return `<tr data-aa-row data-name="${esc(String(d.name||'').toLowerCase())}" data-status="${status.toLowerCase()}" data-gap-parent="${gapTarget}">
        <td><a href="${esc(d.detailUrl||'#')}" target="_blank"><b>${esc(d.name||'—')}</b></a></td>
        <td>${units}</td>
        <td>${hrs ? Number(hrs).toFixed(1) : '—'}</td>
        <td>${esc(mainCatForAA(d))}</td>
        <td>${gap ? `<b>${gap.mins}m</b><br><small>${esc(gap.timeBefore)} → ${esc(gap.timeAfter)} • ${esc(gap.q)}</small>` : '—'}</td>
        <td>${gapAsin ? itemCell(gapAsin) : '—'}</td>
        <td>${gapAsin ? catCell(gapAsin) : '—'}</td>
        <td><button class="whd-gap-toggle" data-gap-target="${gapTarget}">Gaps (${gaps.length}) ▼</button></td>
      </tr>
      <tr id="${gapTarget}" class="whd-gap-detail-row" data-gap-child="${gapTarget}" style="display:none"><td colspan="9">
        <div class="whd-gap-detail-box">
          <div class="whd-gap-detail-title">${esc(d.name||'AA')} scan gaps — from item already processed → to next scanned item</div>
          <table class="cr-table whd-gap-detail-table"><thead><tr><th>Gap</th><th>From ASIN / Title</th><th>From Category</th><th>To ASIN / Title</th><th>To Category</th><th>Action</th></tr></thead><tbody>${gapRows}</tbody></table>
        </div>
      </td></tr>`;
    }).join('') || `<tr><td colspan="9" class="muted">No WHD associates loaded yet. Keep the popup open or press Refresh.</td></tr>`;

    const bridgeRows = allGaps.sort((a,b)=>b.mins-a.mins).slice(0,80).map(g => {
      const fromAsin = g.asinBefore || '';
      const toAsin = g.bridgeAsin || g.asinAfter || '';
      return `<tr>
        <td>${esc(g.aa)}</td><td>${esc(g.q)}</td><td><b>${g.mins}m</b><br><small>${esc(g.timeBefore)} → ${esc(g.timeAfter)}</small></td>
        <td>${itemCell(fromAsin)}</td><td>${catCell(fromAsin)}</td>
        <td>${itemCell(toAsin)}</td><td>${catCell(toAsin)}</td>
        <td><button class="whd-review-btn" data-review-aa="${esc(g.aa)}" data-review-asin="${esc(toAsin)}" data-review-gap="${gapJson(g)}">🔍 Review</button></td>
      </tr>`;
    }).join('') || `<tr><td colspan="8" class="muted">No ${WHD.GAP_MIN}+ min scan gaps detected.</td></tr>`;

    const overlay = document.createElement('div');
    overlay.id = 'whd-popup-overlay';
    overlay.innerHTML = `
      <div id="whd-popup-backdrop"></div>
      <div id="whd-popup" class="cr-shell whd-final">
        <header class="cr-header">
          <div class="cr-brand"><div class="cr-logo">AVV4</div><div><h1>AR (WHD) Operations Dashboard</h1><p>${esc(dateStr)} • PPR actual Rate is source of truth • Expected TPH fixed at 9.61</p></div></div>
          <div class="cr-actions"><button id="whd-open-page" class="primary-web">🌐 Web Page View</button><button id="whd-refresh-all">🔄 Refresh</button><button id="whd-download-csv">Export CSV</button><button id="whd-popup-expand">⤢ Expand</button><button id="whd-popup-close">✕</button></div>
        </header>
        <section class="cr-command">
          <div class="cr-command-main"><span>PPR WHD Actual Rate</span><strong>${actualRate ? actualRate.toFixed(2) : '—'}</strong><div class="cr-bar"><i class="${rateState}" style="width:${Math.max(4, Math.min(100, pctPlan||0))}%"></i></div><em>${actualRate ? `${pctPlan}% of expected 9.61` : (ppr.reason || 'PPR actual rate loading')}</em></div>
          <div class="cr-kpi"><span>Expected / Planned TPH</span><b>9.61</b><small>Fixed WHD target</small></div>
          <div class="cr-kpi"><span>PPR Actual Units</span><b>${actualUnits || '—'}</b><small>Plan ${planUnits || '—'}</small></div>
          <div class="cr-kpi"><span>PPR Hours</span><b>${actualHours ? actualHours.toFixed(1) : '—'}</b><small>Plan ${planHours ? planHours.toFixed(1) : '—'}</small></div>
          <div class="cr-kpi"><span>Function Rollup Team Avg</span><b>${teamAvg ? teamAvg.toFixed(1) : '—'}</b><small>Average of all AA TPH</small></div>
        </section>
        ${!ppr.ok ? `<div class="whd-alert">⚠ ${esc(ppr.reason || 'PPR failed to parse Warehouse Deals actual Rate.')} <a href="${esc(ppr.url||buildProcessPathRollupUrl())}" target="_blank">Open PPR</a></div>` : ''}
        <section class="cr-strip"><div><b>${sorted.length}</b><span>Associates</span></div><div><b>${totalUnits}</b><span>Function Rollup Units</span></div><div><b>${allGaps.length}</b><span>Review Gaps</span></div><div><b>${totalGapMins}m</b><span>Total Gap Time</span></div></section>
        <main class="cr-body whd-list-layout">
          <section class="cr-panel whd-full-width"><div class="cr-panel-head"><h2>AA List View</h2><span>Click Gaps to see from-ASIN → to-ASIN with title and category</span></div><div class="cr-toolbar"><input id="whd-aa-search" placeholder="Search AA"><select id="cr-risk-filter"><option value="all">All</option><option value="review">Review only</option><option value="stable">Stable only</option></select></div><div class="whd-table-scroll"><table class="cr-table whd-aa-list"><thead><tr><th>AA</th><th>TPH</th><th>Units</th><th>Hours</th><th>Main Category</th><th>Largest Gap</th><th>Next Item Title</th><th>Category</th><th>Gaps</th></tr></thead><tbody>${aaRows}</tbody></table></div></section>
          <section class="cr-panel whd-full-width"><div class="cr-panel-head"><h2>Quarter Bridge</h2><span>Gap is attached to the next scanned item. Review is neutral bridge language.</span></div><div id="whd-overall-bridge">${overallQuarterBridgeHtml()}</div><div class="whd-table-scroll"><table class="cr-table whd-bridge-table"><thead><tr><th>AA</th><th>Q</th><th>Gap</th><th>From ASIN / Title</th><th>From Category</th><th>To ASIN / Title</th><th>To Category</th><th>Action</th></tr></thead><tbody>${bridgeRows}</tbody></table></div></section>
          <section class="cr-panel whd-full-width"><div class="cr-panel-head"><h2>Amazon Category Mix</h2><span>Uses Amazon/FC Research category first, title fallback second</span></div><div id="whd-pie-chart-wrap">${donutChartHtml(getItemMixCounts())}</div></section>
        </main>
        <footer class="cr-footer">Refresh keeps popup open • PPR actual Rate only from Warehouse Deals section • AA average TPH from WHD function rollup</footer>
      </div>`;
    document.body.appendChild(overlay);

    const popup = overlay.querySelector('#whd-popup');
    const savedPopupTheme = localStorage.getItem('ar_whd_theme') || 'light';
    if (popup) popup.setAttribute('data-theme', savedPopupTheme);
    const popupThemeBtn = overlay.querySelector('#whd-theme-toggle');
    if (popupThemeBtn) popupThemeBtn.textContent = savedPopupTheme === 'dark' ? '☀️ Bright' : '🌙 Dark';
    const style = document.createElement('style');
    style.id = 'whd-final-v1810-style';
    style.textContent = `
      #whd-popup.whd-final { max-width: min(1550px,97vw); width:97vw; }
      #whd-popup .whd-full-width{grid-column:1/-1} #whd-popup .whd-list-layout{display:grid;grid-template-columns:1fr;gap:14px}
      #whd-popup .whd-table-scroll{overflow:auto;max-height:390px;border-radius:14px;border:1px solid rgba(148,163,184,.25)}
      #whd-popup .whd-aa-list th,#whd-popup .whd-aa-list td,#whd-popup .whd-bridge-table th,#whd-popup .whd-bridge-table td,#whd-popup .whd-gap-detail-table th,#whd-popup .whd-gap-detail-table td{vertical-align:top;white-space:normal}
      #whd-popup .whd-review-btn,#whd-popup .whd-gap-toggle{border:0;border-radius:999px;padding:7px 11px;background:#2563eb;color:#fff;font-weight:900;cursor:pointer;white-space:nowrap}
      #whd-popup .whd-gap-toggle{background:#0f172a}
      #whd-popup .whd-gap-detail-box{background:rgba(37,99,235,.045);border:1px solid rgba(37,99,235,.18);border-radius:16px;padding:12px;margin:4px 0 8px}
      #whd-popup .whd-gap-detail-title{font-size:13px;font-weight:950;color:#1e3a8a;margin-bottom:8px}
      #whd-popup .whd-gap-row-detail td{background:rgba(255,255,255,.65)}
      #whd-popup .whd-alert{margin:10px 16px;padding:10px 12px;border-radius:12px;background:#fff7ed;border:1px solid #fdba74;color:#9a3412;font-weight:800}
      #whd-popup .whd-review-modal{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.55)}
      #whd-popup .whd-review-box{width:min(700px,92vw);background:#fff;color:#0f172a;border-radius:20px;padding:20px;box-shadow:0 30px 80px rgba(0,0,0,.35)}
      #whd-popup .whd-review-box h2{margin:0 0 10px;font-size:22px}.whd-review-box textarea{width:100%;min-height:90px;border:1px solid #cbd5e1;border-radius:12px;padding:10px}.whd-review-box .row{margin:7px 0}.whd-review-box .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
    `;
    overlay.appendChild(style);

    const applyFilter = () => {
      const q = (overlay.querySelector('#whd-aa-search')?.value || '').toLowerCase().trim();
      const f = overlay.querySelector('#cr-risk-filter')?.value || 'all';
      overlay.querySelectorAll('[data-aa-row]').forEach(row => {
        const name = row.getAttribute('data-name') || '';
        const st = row.getAttribute('data-status') || '';
        const ok = (!q || name.includes(q)) && (f === 'all' || st === f);
        row.style.display = ok ? '' : 'none';
        const target = row.getAttribute('data-gap-parent');
        const child = target ? overlay.querySelector('#' + CSS.escape(target)) : null;
        if (child && !ok) child.style.display = 'none';
      });
    };
    overlay.querySelector('#whd-aa-search')?.addEventListener('input', applyFilter);
    overlay.querySelector('#cr-risk-filter')?.addEventListener('change', applyFilter);
    overlay.querySelector('#whd-download-csv')?.addEventListener('click', downloadWHDCSV);
    overlay.querySelector('#whd-open-page')?.addEventListener('click', openWHDFullPage);
    overlay.querySelector('#whd-refresh-all')?.addEventListener('click', refreshWHDDataKeepOpen);
    overlay.querySelector('#whd-popup-close').onclick = () => overlay.remove();
    overlay.querySelector('#whd-popup-backdrop').onclick = () => overlay.remove();
let expanded=false; overlay.querySelector('#whd-popup-expand').onclick=()=>{expanded=!expanded; popup.classList.toggle('expanded', expanded); overlay.querySelector('#whd-popup-expand').textContent=expanded?'⤡ Narrow':'⤢ Expand';};

    overlay.querySelectorAll('.whd-gap-toggle').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-gap-target');
      const row = id ? overlay.querySelector('#' + CSS.escape(id)) : null;
      if (!row) return;
      const open = row.style.display === 'none';
      row.style.display = open ? '' : 'none';
      btn.textContent = btn.textContent.replace(open ? '▼' : '▲', open ? '▲' : '▼');
    }));
    overlay.querySelectorAll('.whd-review-btn').forEach(btn => btn.addEventListener('click', () => openGapReviewModal(btn)));
    loadAsinTitlesInPopup(overlay); refreshWHDVisuals(overlay); refreshOverallQuarterBridge(overlay);
  }
  function injectStyles() {
    if (document.getElementById('bpc-styles')) return;
    const s=document.createElement('style'); s.id='bpc-styles';
    s.textContent=`

      #whd-popup .whd-bridge-line { display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:nowrap;border-radius:12px;padding:8px 12px;margin-top:9px;font-size:11.5px;font-weight:900;line-height:1.25;border:1px solid #dbe4ff;background:linear-gradient(90deg,#eef4ff,#ffffff);color:#1e293b;box-shadow:0 8px 22px rgba(15,23,42,.05); }
      #whd-popup .whd-bridge-line > span:first-child { white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      #whd-popup .whd-bridge-line.warn { border-color:#fed7aa;background:linear-gradient(90deg,#fff7ed,#ffffff);color:#9a3412; }
      #whd-popup .whd-bridge-line.good { border-color:#bbf7d0;background:linear-gradient(90deg,#f0fdf4,#ffffff);color:#166534; }
      #whd-popup .whd-bridge-pill { white-space:nowrap;border-radius:999px;padding:4px 9px;background:rgba(255,255,255,.72);border:1px solid rgba(148,163,184,.35);font-size:11px;font-weight:950; }
      #whd-popup .whd-mix-wrap { display:flex;align-items:center;gap:18px;flex-wrap:wrap; }
      #whd-popup .whd-donut { width:142px;height:142px;border-radius:50%;position:relative;box-shadow:inset 0 0 0 1px rgba(148,163,184,.28),0 16px 35px rgba(15,23,42,.12);flex:0 0 auto; }
      #whd-popup .whd-donut > div { position:absolute;inset:34px;border-radius:50%;background:rgba(255,255,255,.94);display:flex;align-items:center;justify-content:center;flex-direction:column;box-shadow:0 0 0 1px rgba(148,163,184,.22); }
      #whd-popup .whd-donut b { font-size:22px;font-weight:950;color:#0f172a;line-height:1; }
      #whd-popup .whd-donut span { font-size:10px;color:#64748b;font-weight:900;text-transform:uppercase;letter-spacing:.05em; }
      #whd-popup .whd-mix-legend { display:grid;grid-template-columns:repeat(2,minmax(160px,1fr));gap:8px 12px;flex:1;min-width:320px; }
      #whd-popup .whd-mix-row { display:flex;align-items:center;gap:8px;font-size:12px;background:rgba(255,255,255,.78);border:1px solid rgba(148,163,184,.22);border-radius:12px;padding:7px 9px;color:#334155; }
      #whd-popup .whd-mix-dot { width:11px;height:11px;border-radius:50%;display:inline-block;box-shadow:0 0 0 2px rgba(255,255,255,.8); }
      #whd-popup .whd-mix-label { flex:1;font-weight:850; }
      #whd-popup .whd-mix-pct { font-size:11px;color:#64748b;font-weight:950;min-width:36px;text-align:right; }
      #whd-popup .whd-mix-empty { font-size:12px;color:#64748b;font-weight:800; }
      #whd-popup .cr-actions button.primary-web { background:#2563eb !important;color:#fff !important;border-color:#1d4ed8 !important;font-weight:950 !important;box-shadow:0 10px 22px rgba(37,99,235,.24); }
      #whd-popup {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif !important;
        background: #f6f7f9 !important;
        color: #1f2933 !important;
      }
      #whd-popup .whd-clean-topbar {
        background: #ffffff;
        border: 1px solid #dde3ea;
        border-radius: 12px;
        padding: 12px 14px;
        margin-bottom: 12px;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: center;
      }
      #whd-popup .whd-title-main {
        font-size: 18px;
        font-weight: 800;
        color: #17202a;
        letter-spacing: -0.01em;
      }
      #whd-popup .whd-subtitle {
        font-size: 12px;
        color: #637381;
        margin-top: 3px;
      }
      #whd-popup .whd-control-cluster {
        display: flex;
        align-items: center;
        gap: 7px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      #whd-popup .whd-target-box {
        display: flex;
        align-items: center;
        gap: 7px;
        background: #f8fafc;
        border: 1px solid #dbe3ec;
        border-radius: 10px;
        padding: 7px 9px;
      }
      #whd-popup .whd-target-box label {
        font-size: 11px;
        font-weight: 800;
        color: #4b5563;
        text-transform: uppercase;
        letter-spacing: .04em;
      }
      #whd-popup .whd-kpi-strip {
        display: grid;
        grid-template-columns: repeat(8, minmax(78px, 1fr));
        gap: 8px;
        margin-bottom: 12px;
      }
      #whd-popup .whd-kpi {
        background: #ffffff;
        border: 1px solid #dde3ea;
        border-radius: 12px;
        padding: 10px 8px;
        text-align: center;
        min-height: 58px;
      }
      #whd-popup .whd-kpi-value {
        font-size: 18px;
        font-weight: 850;
        color: #1f2933;
        line-height: 1.1;
      }
      #whd-popup .whd-kpi-label {
        font-size: 10px;
        color: #697386;
        font-weight: 800;
        margin-top: 4px;
        text-transform: uppercase;
        letter-spacing: .035em;
      }
      #whd-popup .whd-performance-strip {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        background: #ffffff;
        border: 1px solid #dde3ea;
        border-radius: 12px;
        padding: 10px 12px;
        margin-bottom: 12px;
      }
      #whd-popup .whd-chip {
        font-size: 12px;
        font-weight: 800;
        padding: 5px 9px;
        border-radius: 999px;
        border: 1px solid transparent;
        white-space: nowrap;
      }
      #whd-popup .whd-chip-blue { background:#e8f2ff; color:#125c9f; border-color:#c7def8; }
      #whd-popup .whd-chip-grey { background:#f1f4f8; color:#3f4b5b; border-color:#dde3ea; }
      #whd-popup .whd-chip-green { background:#e8f7ee; color:#1f7a43; border-color:#c8ecd5; }
      #whd-popup .whd-chip-yellow { background:#fff7df; color:#8a5b00; border-color:#ffe08a; }
      #whd-popup .whd-chip-red { background:#fff0f0; color:#b42318; border-color:#ffd0d0; }
      #whd-popup .whd-section-card {
        background: #ffffff;
        border: 1px solid #dde3ea;
        border-radius: 12px;
        padding: 12px;
        margin-bottom: 12px;
      }
      #whd-popup .whd-section-title {
        font-size: 13px;
        font-weight: 850;
        color: #1f2933;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      #whd-popup button {
        font-family: inherit !important;
      }
      #whd-popup input, #whd-popup select {
        font-family: inherit !important;
      }
      #whd-popup a {
        color: #1769aa;
      }

      @media (max-width: 900px) {
        #whd-popup .whd-kpi-strip { grid-template-columns: repeat(4, 1fr); }
        #whd-popup .whd-clean-topbar { grid-template-columns: 1fr; }
        #whd-popup .whd-control-cluster { justify-content: flex-start; }
      }

      #whd-toolbar-isolated { display:flex; align-items:center; gap:8px; margin:6px 0; font-family:"Amazon Ember",Arial,sans-serif; }
      .whd-toolbar-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
      #whd-toolbar-isolated .bpc-divider { width:1px; height:20px; background:#c8d0d8; margin:0 4px; }
      #whd-toolbar-isolated .bpc-label { font-size:11px; font-weight:700; color:#5a6472; text-transform:uppercase; letter-spacing:.6px; white-space:nowrap; }
      #whd-toolbar-isolated button, #whd-mode-btn { display:inline-flex; align-items:center; gap:4px; padding:5px 12px; font-size:12px; font-weight:600; cursor:pointer; border-radius:20px; border:1.5px solid transparent; line-height:1; white-space:nowrap; transition:all .15s; font-family:inherit; }
      #bpc-run-btn { background:#0f6cbd; color:#fff; border-color:#0a5aa8; padding:6px 18px!important; font-size:13px!important; box-shadow:0 2px 4px rgba(15,108,189,.3); }
      #bpc-run-btn:hover { background:#0a5aa8; }
      #bpc-run-btn:disabled { opacity:.5; cursor:not-allowed; }
      #whd-mode-btn { background:#4a235a; color:#fff; border-color:#6c3483; padding:6px 18px!important; font-size:13px!important; }
      #whd-mode-btn:hover { background:#6c3483; }
      #whd-mode-btn.whd-active { background:#1e8449; border-color:#196f3d; }
      #whd-mode-btn:disabled { opacity:.5; cursor:not-allowed; }
      .bpc-intraday-ns { background:#e8f4fd; color:#0a5aa8; border-color:#9dc3e6; }
      .bpc-intraday-ns:hover { background:#cce4f7; border-color:#0a5aa8; }
      .bpc-intraday-ns.bpc-bold-btn { font-weight:900; border-width:2px; border-color:#0a5aa8; }
      .bpc-intraday-ds { background:#fef9e7; color:#7a5c00; border-color:#f0c040; }
      .bpc-intraday-ds:hover { background:#fdeea0; border-color:#c9a000; }
      .bpc-intraday-ds.bpc-bold-btn { font-weight:900; border-width:2px; border-color:#c9a000; }
      #whd-toolbar-isolated .bpc-opt-btn { background:#f0f2f5; color:#333; border-color:#c8d0d8; }
      #whd-toolbar-isolated .bpc-opt-btn:hover { background:#e2e6ea; }
      #whd-toolbar-isolated .bpc-opt-btn.bpc-active { background:#0f6cbd; color:#fff; border-color:#0a5aa8; }
      #bpc-legend { font-size:11px; color:#888; display:inline-flex; align-items:center; gap:4px; }
      #whd-progress { font-size:11px; color:#555; padding:2px 0; display:none; font-family:monospace; }
      td.employee-name, td[class*="name"] a, tr.tot-row td:nth-child(2) { font-size:13px!important; }
      .bpc-th { background:#2c3e50!important; color:#fff!important; padding:5px 8px!important; font-size:11px!important; white-space:nowrap!important; font-weight:600!important; cursor:pointer; user-select:none; }
      .bpc-th:hover { background:#3d5166!important; }
      .bpc-th .bpc-sort-arrow { margin-left:4px; opacity:.5; font-size:10px; }
      .bpc-th.bpc-sorted-asc .bpc-sort-arrow::after { content:' ▲'; opacity:1; }
      .bpc-th.bpc-sorted-desc .bpc-sort-arrow::after { content:' ▼'; opacity:1; }
      .bpc-th:not(.bpc-sorted-asc):not(.bpc-sorted-desc) .bpc-sort-arrow::after { content:' ⇅'; }
      .whd-th { background:#4a235a!important; color:#fff!important; padding:5px 8px!important; font-size:11px!important; white-space:nowrap!important; font-weight:600!important; cursor:pointer; user-select:none; display:none; }
      .whd-th.whd-visible { display:table-cell; }
      .whd-th:hover { background:#6c3483!important; }
      .bpc-cell { font-size:11px; padding:3px 7px; vertical-align:middle; white-space:nowrap; color:#222; }
      .bpc-cell-process { white-space:normal; line-height:1.7; }
      .bpc-cell-process span { display:block; }
      .bpc-cell-breaks { white-space:normal; line-height:1.9; min-width:180px; font-size:11px; padding:4px 8px; }
      .bpc-break-line { display:flex; align-items:baseline; gap:4px; }
      .bpc-break-label { font-weight:700; color:#555; min-width:28px; font-size:10px; text-transform:uppercase; }
      .bpc-flag { background:#c0392b!important; color:#fff!important; font-weight:bold; }
      .bpc-flag-row { background:#fdf0ee!important; }
      .bpc-warn { color:#c0392b; }
      .bpc-ok   { color:#1e8449; }
      .bpc-dim  { color:#aaa; }
      /* WHD cells — hidden until AR (WHD) mode activated */
      .whd-cell { font-size:11px; padding:4px 7px; vertical-align:top; display:none; }
      .whd-cell.whd-visible { display:table-cell; }
      .whd-cell-perf { text-align:center; vertical-align:middle; font-family:monospace; white-space:nowrap; }
      .whd-cell-gaps { white-space:normal; line-height:1.9; min-width:240px; }
      .whd-cell-tot  { text-align:center; vertical-align:middle; font-family:monospace; }
      .q-line { display:flex; align-items:baseline; gap:4px; font-size:11px; flex-wrap:wrap; }
      .q-lbl  { font-weight:700; color:#555; min-width:22px; font-size:10px; flex-shrink:0; }
      .q-ok   { color:#1e8449; }
      .q-warn { color:#c0392b; }
      .q-dim  { color:#aaa; }
      .q-gap  { color:#d68910; font-weight:600; font-size:10px; }
      .gaps-row { padding-left:26px; display:block; line-height:1.7; }
      .whd-g { color:#1e8449; font-weight:700; }
      .whd-w { color:#d29922; font-weight:700; }
      .whd-r { color:#c0392b; font-weight:700; }
      tr.whd-skip { opacity:.3; }
      /* Do not hide Brad's intraday/day-night controls. */
    `;
    document.head.appendChild(s);
  }
  // Important: this script must NOT create/replace Brad's Break & Process toolbar.
  // It only appends one AR (WHD) button after Brad's ToT/Performance button.
  function addToolbar() {
    if (document.getElementById('whd-mode-btn')) return;

    const insertButton = () => {
      if (document.getElementById('whd-mode-btn')) return true;

      const whdBtn = document.createElement('button');
      whdBtn.id = 'whd-mode-btn';
      whdBtn.type = 'button';
      whdBtn.innerHTML = '⚡ AR (WHD) Only';
      whdBtn.title = 'Open AR (WHD) dashboard only — does not affect Brad\'s ToT/Performance checker';
      whdBtn.onclick = runWHDMode;

      const progEl = document.createElement('span');
      progEl.id = 'whd-progress';
      progEl.style.display = 'none';

      // Brad's main button from Break & Process Checker v9.
      const bradRunBtn = document.getElementById('bpc-run-btn');
      const bradRow = bradRunBtn ? bradRunBtn.parentElement : null;

      if (bradRunBtn && bradRow) {
        // Put our button immediately after Brad's ToT & Performance button.
        bradRunBtn.insertAdjacentElement('afterend', whdBtn);
        whdBtn.insertAdjacentElement('afterend', progEl);
        return true;
      }

      // Fallback only if Brad's toolbar has not loaded yet. This creates a tiny isolated row
      // without using Brad's IDs, so it will not block Brad when he loads later.
      const anchor = document.querySelector('.tot-filters') || document.querySelector('form') || document.body;
      const wrap = document.createElement('div');
      wrap.id = 'whd-toolbar-isolated';
      wrap.appendChild(whdBtn);
      wrap.appendChild(progEl);
      anchor.appendChild(wrap);
      return true;
    };

    if (insertButton()) return;

    // Wait for Brad's script if it loads a little later.
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (insertButton() || tries > 20) clearInterval(timer);
    }, 500);
  }

  function mkRow()    { const d=document.createElement('div'); d.className='whd-toolbar-row'; return d; }
  function mkDivider(){ const d=document.createElement('span'); d.className='bpc-divider'; return d; }
  function mkLabel(t) { const s=document.createElement('span'); s.className='bpc-label'; s.textContent=t; return s; }

  function getDateStrings(){
    const now=new Date(),yest=new Date(now),tmrw=new Date(now);
    yest.setDate(yest.getDate()-1); tmrw.setDate(tmrw.getDate()+1);
    const fmt=d=>`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    return{today:fmt(now),yesterday:fmt(yest),tomorrow:fmt(tmrw)};
  }
  function setIntraday(sd,ed,sh,sm,eh,em){
    const g=id=>document.getElementById(id);
    const radios=document.getElementsByName('spanType');
    if(radios.length)radios[radios.length-1].checked=true;
    if(g('startDateIntraday'))g('startDateIntraday').value=sd;
    if(g('endDateIntraday'))g('endDateIntraday').value=ed;
    if(g('startHourIntraday'))g('startHourIntraday').selectedIndex=sh;
    if(g('startMinuteIntraday'))g('startMinuteIntraday').selectedIndex=sm;
    if(g('endHourIntraday'))g('endHourIntraday').selectedIndex=eh;
    if(g('endMinuteIntraday'))g('endMinuteIntraday').selectedIndex=em;
  }
  function exportCSV(){
    const headers=[]; document.querySelectorAll('thead th').forEach(th=>headers.push('"'+th.textContent.trim()+'"'));
    const lines=[headers.join(',')];
    document.querySelectorAll('tr.tot-row').forEach(row=>{
      if(row.style.display==='none')return;
      const cols=[]; row.querySelectorAll('td').forEach(td=>cols.push('"'+td.textContent.trim().replace(/"/g,'""')+'"'));
      lines.push(cols.join(','));
    });
    const blob=new Blob([lines.join('\n')],{type:'text/csv'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='tot_report.csv'; a.click();
  }
  function ensureColumns(){
    const thead=document.querySelector('thead tr');
    if(!thead||document.getElementById('bpc-th-0'))return;
    ['Process','Time On Task','Idle Minutes','JPH','Packages'].forEach((label,i)=>{
      const th=document.createElement('th'); th.id='bpc-th-'+i; th.className='bpc-th';
      th.innerHTML=label+'<span class="bpc-sort-arrow"></span>';
      th.dataset.colIdx=i; th.dataset.sortDir='';
      th.onclick=()=>sortByColumn(th,i); thead.appendChild(th);
    });
    // WHD extra columns — hidden until AR (WHD) mode
    ['WHD UPH','WHD Scan Gaps (Q1–Q4)','Gap Total'].forEach((label,i)=>{
      const th=document.createElement('th'); th.id='whd-th-'+i; th.className='whd-th';
      th.innerHTML=label+'<span class="bpc-sort-arrow"></span>';
      th.dataset.colIdx=i; th.dataset.sortDir='';
      th.onclick=()=>sortWHDCol(th,i); thead.appendChild(th);
    });
  }

  function sortByColumn(th,colIdx){
    const rows=[...document.querySelectorAll('tr.tot-row')];
    if(!rows.length)return;
    const tbody=rows[0].parentElement;
    const asc=th.dataset.sortDir!=='asc';
    document.querySelectorAll('.bpc-th').forEach(h=>{h.classList.remove('bpc-sorted-asc','bpc-sorted-desc');h.dataset.sortDir='';});
    th.classList.add(asc?'bpc-sorted-asc':'bpc-sorted-desc'); th.dataset.sortDir=asc?'asc':'desc';
    rows.sort((a,b)=>{
      const ca=a.querySelectorAll('.bpc-cell')[colIdx],cb=b.querySelectorAll('.bpc-cell')[colIdx];
      const ra=ca?.dataset?.sort??ca?.textContent?.trim()??'';
      const rb=cb?.dataset?.sort??cb?.textContent?.trim()??'';
      const na=parseFloat(ra),nb=parseFloat(rb);
      return (!isNaN(na)&&!isNaN(nb))?(asc?na-nb:nb-na):(asc?ra.localeCompare(rb):rb.localeCompare(ra));
    });
    const ref=rows[rows.length-1].nextSibling;
    rows.forEach(r=>tbody.insertBefore(r,ref));
  }

  function sortWHDCol(th,idx){
    const rows=[...document.querySelectorAll('tr.tot-row:not(.whd-skip)')];
    if(!rows.length)return;
    const tbody=rows[0].parentElement;
    const asc=th.dataset.sortDir!=='asc';
    document.querySelectorAll('.whd-th').forEach(h=>{h.classList.remove('bpc-sorted-asc','bpc-sorted-desc');h.dataset.sortDir='';});
    th.classList.add(asc?'bpc-sorted-asc':'bpc-sorted-desc'); th.dataset.sortDir=asc?'asc':'desc';
    rows.sort((a,b)=>{
      const ca=a.querySelectorAll('.whd-cell')[idx],cb=b.querySelectorAll('.whd-cell')[idx];
      const na=parseFloat(ca?.dataset?.sort??'0'),nb=parseFloat(cb?.dataset?.sort??'0');
      return asc?na-nb:nb-na;
    });
    const ref=rows[rows.length-1].nextSibling;
    rows.forEach(r=>tbody.insertBefore(r,ref));
  }
  function applyIdleRanking(){
    if(!allRows.length)return;
    const isCRET=e=>/^(CRET|PA|Problem Solve|Audit|Refurbish|PIT)/i.test(e.process);
    const cretRows=allRows.filter(isCRET);
    if(!cretRows.length)return;
    const withVal=cretRows.map(e=>({...e,unschedMin:parseFloat(e.idleCell.textContent.replace(/[^\d.]/g,''))||0}));
    const sorted=[...withVal].sort((a,b)=>b.unschedMin-a.unschedMin);
    const cutoff=Math.ceil(sorted.length*0.3);
    sorted.forEach((entry,idx)=>{
      if(idx<cutoff&&entry.unschedMin>0){
        entry.row.classList.add('bpc-flag-row');
        entry.idleCell.classList.add('bpc-flag');
        if(!entry.idleCell.textContent.startsWith('🚩'))
          entry.idleCell.textContent='🚩 '+entry.idleCell.textContent;
      }
    });
  }
  function requestDone(){
    pendingRequests--;
    if(pendingRequests===0){applyIdleRanking();formatTotalTimeColumn();}
  }
  function formatTotalTimeColumn(){
    let idx=-1;
    document.querySelectorAll('thead th').forEach((th,i)=>{if(/total\s*time/i.test(th.textContent))idx=i;});
    if(idx<0)return;
    document.querySelectorAll('tr.tot-row').forEach(row=>{
      const td=row.querySelectorAll('td')[idx]; if(!td)return;
      const val=td.textContent.trim();
      if(val&&!val.includes('h')&&!isNaN(parseFloat(val)))td.textContent=val+'h';
    });
  }
  function runCheck(){
    detectShift(); ensureColumns();
    allRows.length=0; pendingRequests=0; _jphCache=null;

    let rowIndex=0;
    document.querySelectorAll('tr.tot-row').forEach(row=>{
      if(row.querySelector('.bpc-cell'))return;
      const link=row.querySelector('a.employee-time-details-link');
      if(!link)return;
      const cells=Array.from({length:5},()=>{
        const td=document.createElement('td'); td.className='bpc-cell'; td.textContent='…';
        row.appendChild(td); return td;
      });
      // Also add blank WHD cells (hidden until AR (WHD) mode)
      ['whd-cell whd-cell-perf','whd-cell whd-cell-gaps','whd-cell whd-cell-tot'].forEach(cls=>{
        const td=document.createElement('td'); td.className=cls; td.textContent='—';
        row.appendChild(td);
      });

      pendingRequests++;
      const delay=rowIndex*200; rowIndex++;
      setTimeout(()=>{
        GM_xmlhttpRequest({ method:'GET', url:link.href,
          onload: res=>{
            try{
              const doc=new DOMParser().parseFromString(res.responseText,'text/html');
              const result=parseEmployeePage(doc,cells);
              const managerTd=row.querySelector('td.manager')||
                [...row.querySelectorAll('td')].find(td=>/,/.test(td.textContent)&&td!==row.querySelector('td:first-child'));
              if(managerTd){const parts=managerTd.textContent.trim().split(',');if(parts.length>=2)managerTd.textContent=parts[1].trim().split(' ')[0];}
              fetchJPH(link.href,jph=>{
                if(jph){
                  const jphNum=parseFloat(jph.total)||0;
                  cells[3].innerHTML=`<strong>${jph.total}</strong> JPH<br><small style="color:#555">S:${jph.uphS} M:${jph.uphM} L:${jph.uphL}</small>`;
                  cells[3].dataset.sort=String(jphNum);
                } else {cells[3].textContent='—';cells[3].dataset.sort='0';cells[3].classList.add('bpc-dim');}
                fetchActivityDetails(link.href,counts=>{
                  if(counts===null){cells[4].textContent='ERR';cells[4].style.color='#c0392b';cells[4].dataset.sort='0';}
                  else if(counts.S+counts.M+counts.L>0){
                    cells[4].innerHTML=`<span style="font-size:10px;font-weight:700;color:#784212;display:block;margin-bottom:1px">CRET</span><span style="color:#1a5276;font-weight:600">S${counts.S}</span> <span style="color:#4a235a;font-weight:600">M${counts.M}</span> <span style="color:#1e6b3a;font-weight:600">L${counts.L}</span>`;
                    cells[4].dataset.sort=String(counts.S+counts.M+counts.L);
                  } else {cells[4].textContent=counts._rowsFound>0?'No CRET':'—';cells[4].dataset.sort='0';cells[4].classList.add('bpc-dim');}
                  allRows.push({row,idleCell:cells[2],idleHours:result?.idleHours||0,process:cells[0].dataset.process||''});
                  requestDone();
                });
              });
            } catch(e){cells.forEach(c=>{c.textContent='ERR';c.classList.add('bpc-warn');});console.error('[BPC]',e);requestDone();}
          },
          onerror:()=>{cells.forEach(c=>{c.textContent='ERR';c.classList.add('bpc-warn');});requestDone();}
        });
      },delay);
    });
  }
  function runWHDMode(){
    if(whdModeActive){
      // v18.8: AR (WHD) should always open the popup first, not toggle the mode off.
      // This prevents the manager view from disappearing when the user clicks AR (WHD) again.
      window.__whdLoadingNow = false;
      safeShowWHDPopup('AR (WHD) mode is already active. Showing the popup view.');
      return;
    }

    whdModeActive=true;
    whdPopupData.length=0;
    const btn=document.getElementById('whd-mode-btn');
    if(btn){btn.disabled=true;btn.innerHTML='⏳ Loading AR (WHD)…';}
    const prog=document.getElementById('whd-progress');
    if(prog){prog.style.display='block';prog.textContent='Fetching WHD rollup…';}

    // v18.8: load the popup IMMEDIATELY before any network call.
    // The user must see the popup first, then data/PPR refreshes into it.
    window.__whdLoadingNow = true;
    safeShowWHDPopup('Loading AR (WHD) data…');
    try { fetchPPRWHDMetrics(() => safeShowWHDPopup('PPR Warehouse Deals Rate loaded.')); } catch(e) { console.warn('[WHD PPR preload failed]', e); }

    // Show WHD column headers
    document.querySelectorAll('.whd-th').forEach(th=>th.classList.add('whd-visible'));

    fetchWHDRollup(rollupMap=>{
      if(prog)prog.textContent=`WHD rollup: ${rollupMap.size} graders — filtering rows…`;

      // Dim non-WHD rows, collect WHD rows
      const whdRows=[];
      document.querySelectorAll('tr.tot-row').forEach(row=>{
        const link=row.querySelector('a.employee-time-details-link');
        if(!link)return;
        const m=link.href.match(/employeeId=(\d+)/);
        const empId=m?m[1]:null;
        if(!empId||!rollupMap.has(empId)){
          row.classList.add('whd-skip');
        } else {
          row.classList.remove('whd-skip');
          whdRows.push({row,empId,link});
        }
      });

      if(!whdRows.length){
        if(btn){btn.disabled=false;btn.innerHTML='⚡ AR (WHD) Only';btn.classList.add('whd-active');}
        if(prog)prog.textContent='No WHD associates found on this page.';
        return;
      }

      if(prog)prog.textContent=`Running WHD scan gaps for ${whdRows.length} graders…`;
      let done=0;

      whdRows.forEach(({row,empId,link},i)=>{
        // Get or create WHD cells for this row
        let whdCells=[...row.querySelectorAll('.whd-cell')];
        if(!whdCells.length){
          whdCells=['whd-cell whd-cell-perf','whd-cell whd-cell-gaps','whd-cell whd-cell-tot'].map(cls=>{
            const td=document.createElement('td'); td.className=cls; td.textContent='…';
            row.appendChild(td); return td;
          });
        }
        // Show them
        whdCells.forEach(td=>td.classList.add('whd-visible'));

        setTimeout(()=>{
          fetchWHDScans(link.href,scans=>{
            const perf=rollupMap.get(empId);

            // Cell 0: TPH/UPH — use FCLM rollup first, then scan-based fallback so it does not stay blank.
            const hydratedPerf = hydratePerfWithScans(perf, scans);
            const shownTPH = getAssociateAvgTPH({perf:hydratedPerf, scanList:scans});
            if(shownTPH>0){
              const vs=shownTPH/WHD.UPH_TARGET-1;
              const cls=vs>=0?'whd-g':vs>=-0.15?'whd-w':'whd-r';
              whdCells[0].innerHTML=
                `<span class="${cls}">${shownTPH.toFixed(1)} TPH</span>`
               +`<br><small style="color:#888">${getAssociateUnits({perf:hydratedPerf, scanList:scans})} items · ${(hydratedPerf.hrs||0).toFixed(1)}h</small>`
               +`<br><small style="color:#555">S:${hydratedPerf.smU||0} M:${hydratedPerf.mdU||0} L:${hydratedPerf.lgU||0}</small>`;
              whdCells[0].dataset.sort=String(shownTPH);
            } else {
              whdCells[0].innerHTML='<span style="color:#aaa">No TPH</span>';
              whdCells[0].dataset.sort='0';
            }

            // Cell 1 & 2: scan gaps
            if(!scans.length){
              whdCells[1].innerHTML='<span style="color:#aaa;font-size:10px">No ItemGraded scans</span>';
              whdCells[1].dataset.sort='0';
              whdCells[2].textContent='—'; whdCells[2].dataset.sort='0';
            } else {
              const {qResults,totalGapMins}=analyseWHDGaps(scans);
              let html='', hasFlag=false;
              qResults.forEach(q=>{
                if(q.empty){html+=`<div class="q-line"><span class="q-lbl">${q.label}</span><span class="q-dim">—</span></div>`;return;}
                if(q.hasFlag)hasFlag=true;
                const col=q.hasFlag?'q-warn':'q-ok';
                html+=`<div class="q-line ${col}"><span class="q-lbl">${q.label}</span>↑${absToHHMM(q.firstScan)} ↓${absToHHMM(q.lastScan)}</div>`;
                if(q.gaps.length){
                  const ords=['1st','2nd','3rd','4th','5th'];
                  const items=q.gaps.map((g,i)=>{
                    const asinPart = (g.asinBefore||g.asinAfter)
                      ? `<span style="color:#888;font-size:10px;font-family:monospace"> [${g.asinBefore||'?'} → ${g.asinAfter||'?'}]</span>`
                      : '';
                    return `<span class="q-gap">${ords[i]||i+1+'th'} gap — ${g.mins}m</span>${asinPart}`;
                  }).join('<br>');
                  html+=`<div class="gaps-row">${items}</div>`;
                }
              });
              whdCells[1].innerHTML=html;
              whdCells[1].dataset.sort=String(qResults.reduce((s,q)=>s+q.gaps.length,0));
              if(hasFlag)row.classList.add('bpc-flag-row');

              if(totalGapMins>0){
                whdCells[2].textContent=totalGapMins+'m';
                whdCells[2].dataset.sort=String(totalGapMins);
                whdCells[2].style.color=totalGapMins>20?'#c0392b':'#d29922';
              } else {
                whdCells[2].textContent='—'; whdCells[2].dataset.sort='0'; whdCells[2].style.color='#aaa';
              }
            }

            done++;
            if(prog)prog.textContent=`WHD: ${done} / ${whdRows.length} done…`;

            // Collect data for popup
            let popupPerf=rollupMap.get(empId);
            const nameTd=row.querySelectorAll('td')[1];
            const rawName=nameTd?.textContent?.trim()||'Unknown';
            const nameParts=rawName.split(',');
            const displayName=nameParts.length>=2?`${nameParts[1].trim()} ${nameParts[0].trim()}`:rawName;

            popupPerf = hydratePerfWithScans(popupPerf, scans);
            if(scans.length){
              const {qResults,totalGapMins}=analyseWHDGaps(scans);
              whdPopupData.push({name:displayName,uph:getAssociateAvgTPH({perf:popupPerf,scanList:scans}),perf:popupPerf,qResults,totalGapMins,scanList:scans,detailUrl:link.href});
            } else {
              whdPopupData.push({name:displayName,uph:getAssociateAvgTPH({perf:popupPerf,scanList:scans}),perf:popupPerf,qResults:null,totalGapMins:0,scanList:[],detailUrl:link.href});
            }

            if(done===whdRows.length){
              if(btn){btn.disabled=false;btn.innerHTML='✓ AR (WHD) Active';btn.classList.add('whd-active');}
              if(prog)prog.textContent=`✓ WHD complete — ${whdRows.length} graders processed`;
              const rb=document.getElementById('whd-report-btn');
              if(rb)rb.style.display='';
              const pb=document.getElementById('whd-page-btn');
              if(pb)pb.style.display='';
              if(prog)prog.textContent=`Fetching PPR Warehouse Deals actual vs plan…`;
              fetchPPRWHDMetrics(()=>{ window.__whdLoadingNow = false; safeShowWHDPopup('AR (WHD) data complete.'); });
            }
          });
        }, i*WHD.STAGGER_MS);
      });
    });
  }
  function parseEmployeePage(doc,cells){
    const segments=[]; let baseDay=null;
    doc.querySelectorAll('tr').forEach(tr=>{
      const cls=tr.className||''; const tds=tr.querySelectorAll('td'); if(tds.length<3)return;
      const title=tds[0]?.textContent?.trim();
      const startRaw=tds[1]?.textContent?.trim(); const endRaw=tds[2]?.textContent?.trim();
      const startMin=parseSegTime(startRaw); const endMin=parseSegTime(endRaw);
      const startDay=parseSegDay(startRaw); const endDay=parseSegDay(endRaw);
      if(startMin===null||!title)return;
      const isAdminHR=/admin.*hr|hr.*it|ops_emp/i.test(title);
      const isIndirect=!isAdminHR&&cls.includes('function-seg')&&cls.includes('indirect');
      const isDirect=cls.includes('function-seg')&&(cls.includes('direct')||cls.includes('edited')||isAdminHR);
      const isOffClock=cls.includes('off-clock'); const isOnClock=cls.includes('on-clock');
      if(!isIndirect&&!isDirect&&!isOffClock&&!isOnClock)return;
      if(isOnClock&&baseDay===null&&startDay!==null)baseDay=startDay;
      segments.push({title,startMin,endMin,startDay,endDay,isIndirect,isDirect,isOffClock,isOnClock});
    });
    if(!segments.length){cells.forEach(c=>{c.textContent='—';c.classList.add('bpc-dim');});return null;}
    if(baseDay===null)baseDay=segments[0].startDay||1;
    const segs=segments.map(s=>{
      const absStart=toAbsolute(s.startMin,s.startDay||baseDay,baseDay);
      const absEnd=s.endMin!==null?toAbsolute(s.endMin,s.endDay||s.startDay||baseDay,baseDay):null;
      return{...s,absStart,absEnd};
    });
    const idleHours=calcIdleHours(doc);
    return buildResults(segs,cells,idleHours);
  }

  function buildResults(segs,cells,idleHours){
    const shift=SHIFTS[activeShift];
    const SCAN_PROCESSES=/^(CRET(?!\s*WSpider)|VRET\s*(Pick|Pack)|Stow|AR)(\s|$)/i;

    // Cell 0: Process list
    const procOrder={}, procDur={};
    segs.forEach(s=>{
      if(!s.isDirect)return;
      const key=abbreviate(s.title), dur=s.absEnd!==null?s.absEnd-s.absStart:0;
      procDur[key]=(procDur[key]||0)+dur;
      if(procOrder[key]===undefined||s.absStart<procOrder[key])procOrder[key]=s.absStart;
    });
    const processList=Object.keys(procOrder).sort((a,b)=>procOrder[a]-procOrder[b]).map(k=>[k,procDur[k]]);
    const topProcess=processList.length?processList[0][0]:'N/A';
    cells[0].className+=' bpc-cell-process';
    cells[0].innerHTML=processList.map(([name,dur])=>{
      if(/time\s*off\s*task/i.test(name))return`<span style="color:#c0392b;font-weight:700">${name} <small style="color:#e88">${fmtMins(dur)}</small></span>`;
      let col='#333';
      if(/^(CRET|PA|Problem Solve|Audit|Refurbish|PIT)/i.test(name))col='#784212';
      else if(/^VRET/i.test(name))col='#1a5276';
      else if(/^AR$/i.test(name))col='#4a235a';
      return`<span style="color:${col};font-weight:700">${name} <small style="color:#aaa;font-weight:400">${fmtMins(dur)}</small></span>`;
    }).join('');
    cells[0].dataset.process=topProcess;

    // Cell 1: Time on Task Q1–Q4
    const hasScanProcess=processList.some(([name])=>SCAN_PROCESSES.test(name));
    cells[1].className+=' bpc-cell-breaks';
    if(!hasScanProcess){
      cells[1].innerHTML='<span style="color:#bbb;font-size:10px">N/A</span>';
    } else {
      const firstOnClock=segs.filter(s=>s.isOnClock).sort((a,b)=>a.absStart-b.absStart)[0];
      const shiftStartMin=toMin(shift.shiftStart);
      const shiftStartAbs=(activeShift==='night'&&shiftStartMin<720)?shiftStartMin+1440:shiftStartMin;
      let lateArrivalHtml='';
      if(firstOnClock){
        const lateBy=Math.round(firstOnClock.absStart-shiftStartAbs);
        if(lateBy>3)lateArrivalHtml=`<div style="color:#e67e22;font-weight:700;font-size:10px;margin-bottom:3px">⏰ Late — ${lateBy}m</div>`;
      }
      const shiftEndRaw=toMin(shift.shiftEnd);
      const shiftEndAbs=(activeShift==='night'&&shiftEndRaw<shiftStartMin)?shiftEndRaw+1440:shiftEndRaw;
      const breakAbsTimes=shift.breaks.map(b=>{
        const bs=toMin(b.start),be=toMin(b.end);
        return{start:(activeShift==='night'&&bs<720)?bs+1440:bs,end:(activeShift==='night'&&be<720)?be+1440:be};
      });
      const quarters=[
        {label:'Q1',start:shiftStartAbs,       end:breakAbsTimes[0].start},
        {label:'Q2',start:breakAbsTimes[0].end,end:breakAbsTimes[1].start},
        {label:'Q3',start:breakAbsTimes[1].end,end:breakAbsTimes[2].start},
        {label:'Q4',start:breakAbsTimes[2].end,end:shiftEndAbs},
      ];
      const qLines=quarters.map(q=>{
        const directInQ=segs.filter(s=>{
          if(!s.isDirect)return false;
          if(!SCAN_PROCESSES.test(abbreviate(s.title)))return false;
          const ss=s.absStart,se=s.absEnd??ss;
          return ss<q.end&&se>q.start;
        });
        if(!directInQ.length)return`<div class="bpc-break-line"><span class="bpc-break-label">${q.label}</span><span style="color:#bbb">—</span></div>`;
        let firstScanRaw;
        if(q.label==='Q1'){
          const clockInTime=firstOnClock?firstOnClock.absStart:shiftStartAbs;
          const openingIdle=segs.filter(s=>s.isIndirect&&s.absStart>=clockInTime-1&&s.absStart<=clockInTime+2).sort((a,b)=>a.absStart-b.absStart)[0];
          const scanWindowStart=openingIdle?(openingIdle.absEnd??openingIdle.absStart):clockInTime;
          const afterIdle=directInQ.filter(s=>s.absStart>=scanWindowStart);
          firstScanRaw=afterIdle.length?Math.min(...afterIdle.map(s=>s.absStart)):Math.min(...directInQ.map(s=>s.absStart));
        } else {
          const startsInQ=directInQ.filter(s=>s.absStart>=q.start);
          firstScanRaw=startsInQ.length?Math.min(...startsInQ.map(s=>s.absStart)):Math.min(...directInQ.map(s=>s.absStart));
        }
        const endsInQ=directInQ.filter(s=>{const se=s.absEnd??s.absStart;return se<=q.end&&Math.abs(se-shiftEndAbs)>0.5;});
        const lastScanRaw=endsInQ.length?Math.max(...endsInQ.map(s=>s.absEnd??s.absStart)):Math.max(...directInQ.map(s=>s.absEnd??s.absStart));
        const qGapStart=q.label==='Q1'?firstScanRaw:q.start;
        const gapsInQ=segs.filter(s=>{
          if(!s.isIndirect)return false;
          const ss=s.absStart,se=s.absEnd??ss;
          return ss>=qGapStart&&ss<q.end&&se<=q.end&&(se-ss)>5;
        });
        const lateStart=firstScanRaw-q.start>5;
        const earlyStop=q.end-lastScanRaw>5;
        const flagStart=q.label!=='Q1'&&q.label!=='Q4'&&lateStart;
        const flagStop=q.label!=='Q4'&&earlyStop;
        const hasFlag=flagStart||flagStop;
        let gapStr='';
        if(gapsInQ.length){
          const gapMins=gapsInQ.map(s=>Math.round((s.absEnd??s.absStart)-s.absStart));
          gapStr=` · <span style="color:#d68910">${gapsInQ.length} gap${gapsInQ.length>1?'s':''} (${gapMins.join('m, ')}m)</span>`;
        }
        const col=hasFlag?'#c0392b':'#1e8449';
        return`<div class="bpc-break-line" style="color:${col}"><span class="bpc-break-label">${q.label}</span>1st: ${absToHHMM(firstScanRaw)}${flagStart?' ⚠️':''} · Last: ${absToHHMM(lastScanRaw)}${flagStop?' ⚠️':''}${gapStr}</div>`;
      });
      cells[1].innerHTML=lateArrivalHtml+qLines.join('');
    }

    // Cell 2: Unscheduled idle
    const idleOut=segs.filter(s=>{
      if(!s.isIndirect)return false;
      return!shift.breaks.some(brk=>{
        const bsRaw=toMin(brk.start),beRaw=toMin(brk.end);
        const bsAbs=(activeShift==='night'&&bsRaw<720)?bsRaw+1440:bsRaw;
        const beAbs=(activeShift==='night'&&beRaw<720)?beRaw+1440:beRaw;
        const ss=s.absStart,se=s.absEnd??ss;
        return ss>=bsAbs-EARLY_TOL-5&&se<=beAbs+LATE_TOL+5;
      });
    });
    if(!idleOut.length){cells[2].textContent='—';cells[2].dataset.sort='0';cells[2].classList.add('bpc-dim');}
    else{
      const totalMins=Math.round(idleOut.reduce((sum,s)=>sum+((s.absEnd??s.absStart)-s.absStart),0));
      cells[2].textContent=totalMins+'m'; cells[2].dataset.sort=String(totalMins); cells[2].classList.add('bpc-warn');
    }
    return{idleHours};
  }
  function init(){injectStyles();detectShift();addToolbar();}
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else{init();setTimeout(init,1500);}
  function getAssociateTPH(d) {
    return getAssociateAvgTPH(d);
  }

  function getGapClassificationsSafe() {
    const result = [];
    whdPopupData.forEach(d => {
      (d.qResults || []).forEach(q => {
        (q.gaps || []).forEach(g => {
          const titleB = asinTitleCache.get(g.asinBefore) || '';
          const titleA = asinTitleCache.get(g.asinAfter) || '';
          const bestTitle = titleA || titleB;
          const det = classifyAsinItem(g.asinAfter || g.asinBefore, bestTitle);
          result.push({
            name:d.name,
            gapMins:g.mins,
            asinBefore:g.asinBefore,
            asinAfter:g.asinAfter,
            timeBefore:g.timeBefore,
            timeAfter:g.timeAfter,
            titleBefore:titleB,
            titleAfter:titleA,
            bestTitle,
            classification:det.cls || 'unknown',
            quarter:q.label,
            detailUrl:d.detailUrl,
          });
        });
      });
    });
    return result;
  }

  function buildSuggestions(target, totalUnits, avgUph) {
    const suggestions = [];
    const shiftHrsLeft = (() => {
      const now = new Date();
      const endH = activeShift === 'day' ? 18 : 4;
      const end = new Date(now);
      end.setHours(endH, 15, 0, 0);
      if (end < now) end.setDate(end.getDate() + 1);
      return Math.max(0, (end - now) / 3600000);
    })();

    const expected = getExpectedTPHValue();
    const projected = target > 0 ? Math.round(totalUnits + avgUph * shiftHrsLeft) : 0;
    const unitsLeft = target > 0 ? Math.max(0, target - totalUnits) : 0;

    if (target > 0) {
      if (totalUnits >= target) suggestions.push({urgency:'green', text:`Target reached: ${totalUnits}/${target} units complete.`});
      else if (projected >= target * 0.95) suggestions.push({urgency:'amber', text:`Close to target. Need ${unitsLeft} more units. Projected EOD: ${projected}/${target}.`});
      else suggestions.push({urgency:'red', text:`Behind target by ${unitsLeft} units. Projected EOD: ${projected}/${target}.`});
    }

    if (avgUph >= expected) suggestions.push({urgency:'green', text:`Team Avg TPH ${avgUph.toFixed(1)} is on/above expected ${expected.toFixed(2)}.`});
    else if (avgUph >= expected * 0.85) suggestions.push({urgency:'amber', text:`Team Avg TPH ${avgUph.toFixed(1)} is slightly below expected ${expected.toFixed(2)}. Monitor item mix and gaps.`});
    else suggestions.push({urgency:'red', text:`Team Avg TPH ${avgUph.toFixed(1)} is well below expected ${expected.toFixed(2)}. Check low performers and scan gaps.`});

    const gapCls = getGapClassificationsSafe();
    const techGaps = gapCls.filter(g => ['tech','tech-adjacent'].includes(g.classification) && g.gapMins >= WHD.GAP_MIN);
    const nonTechGaps = gapCls.filter(g => g.classification === 'non-tech' && g.gapMins >= WHD.GAP_MIN);
    const unknownGaps = gapCls.filter(g => g.classification === 'unknown' && g.gapMins >= WHD.GAP_MIN);

    if (techGaps.length) {
      const names = [...new Set(techGaps.map(g => g.name))].join(', ');
      suggestions.push({urgency:'blue', text:`Tech/testing item gaps detected for ${names}. Lower TPH may be expected.`});
    }

    if (nonTechGaps.length) {
      const byPerson = {};
      nonTechGaps.forEach(g => { (byPerson[g.name] ||= []).push(g); });
      Object.entries(byPerson).forEach(([name,gaps]) => {
        const mins = gaps.reduce((s,g)=>s+g.gapMins,0);
        suggestions.push({urgency:'red', text:`${name} has ${gaps.length} non-tech scan gap(s), total ${mins}m. Review/coaching may be needed.`});
      });
    }

    if (unknownGaps.length && !techGaps.length && !nonTechGaps.length) {
      suggestions.push({urgency:'amber', text:`${unknownGaps.length} scan gap(s) detected while titles are still loading. Reopen/refresh popup after titles load.`});
    }

    whdPopupData.forEach(d => {
      const aaTph = getAssociateAvgTPH(d);
      if (aaTph > 0 && aaTph < expected * 0.7) {
        const hasTech = gapCls.some(g => g.name === d.name && ['tech','tech-adjacent'].includes(g.classification));
        suggestions.push({urgency: hasTech ? 'blue' : 'red', text: hasTech
          ? `${d.name} is low at ${aaTph.toFixed(1)} TPH, but tech/testing items are detected.`
          : `${d.name} is low at ${aaTph.toFixed(1)} TPH with no tech explanation found.`});
      }
    });

    return suggestions;
  }

  function refreshSuggestions(popupEl) {
    const box = popupEl.querySelector('#whd-suggestions-box');
    if (!box) return;
    const target = getTargetValue();
    const totalUnits = whdPopupData.reduce((s,d)=>s+getAssociateUnits(d),0);
    const avgUph = getTeamAverageTPH();
    const suggs = buildSuggestions(target, totalUnits, avgUph);
    box.innerHTML = suggs.length ? suggs.map(s => {
      const st = URGENCY_STYLE[s.urgency] || URGENCY_STYLE.amber;
      const icons = {red:'▲', amber:'◎', green:'✓', blue:'ℹ'};
      return `<div style="background:${st.bg};border:1px solid ${st.border};border-left:4px solid ${st.border};border-radius:0 8px 8px 0;padding:10px 13px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:13px;color:${st.icon};flex-shrink:0;margin-top:1px">${icons[s.urgency] || '◎'}</span>
        <div>
          <span style="font-size:10px;font-weight:700;color:${st.icon};text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:2px">${st.label}</span>
          <span style="font-size:12px;color:#212529;line-height:1.5">${s.text}</span>
        </div>
      </div>`;
    }).join('') : `<div style="color:#adb5bd;font-size:12px;padding:8px">All associates on track — no issues detected.</div>`;
  }

    // v17 final UI polish: calmer colors, better dark/bright theme support, readable ASIN/title rows.
    (function injectV17FinalStyle(){
      if (document.getElementById('whd-v17-final-style')) return;
      const s=document.createElement('style');
      s.id='whd-v17-final-style';
      s.textContent=`
        #whd-popup { letter-spacing:.005em; }
        #whd-popup .whd-bridge-line { font-size:12px; line-height:1.35; border-radius:10px; padding:9px 12px; margin-top:10px; display:flex; align-items:center; justify-content:space-between; gap:12px; background:#f8fafc; border:1px solid #cbd5e1; color:#334155; font-weight:850; }
        #whd-popup .whd-bridge-line.warn { background:#fff7ed; border-color:#fed7aa; color:#9a3412; }
        #whd-popup .whd-bridge-line.good { background:#f0fdf4; border-color:#bbf7d0; color:#166534; }
        #whd-popup .whd-bridge-pill { white-space:nowrap; background:white; border:1px solid #e2e8f0; border-radius:999px; padding:4px 8px; font-size:11px; color:#475569; }
        #whd-popup .whd-mix-wrap { display:flex; align-items:center; gap:20px; flex-wrap:wrap; }
        #whd-popup .whd-donut { width:154px; height:154px; border-radius:50%; position:relative; box-shadow:inset 0 0 0 1px rgba(148,163,184,.28),0 10px 25px rgba(15,23,42,.10); flex:0 0 auto; }
        #whd-popup .whd-donut > div { position:absolute; inset:38px; border-radius:50%; background:#fff; display:flex; align-items:center; justify-content:center; flex-direction:column; box-shadow:0 0 0 1px rgba(148,163,184,.22); }
        #whd-popup .whd-donut b { font-size:22px; font-weight:950; color:#0f172a; line-height:1; }
        #whd-popup .whd-donut span { font-size:10px; color:#64748b; font-weight:900; text-transform:uppercase; }
        #whd-popup .whd-mix-legend { display:grid; grid-template-columns:repeat(2,minmax(170px,1fr)); gap:8px 12px; flex:1; min-width:340px; }
        #whd-popup .whd-mix-row { display:grid; grid-template-columns:12px 1fr 42px 46px; align-items:center; gap:8px; font-size:12px; background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:7px 9px; color:#334155; }
        #whd-popup .whd-mix-dot { width:11px; height:11px; border-radius:50%; display:inline-block; }
        #whd-popup .whd-mix-label { font-weight:850; }
        #whd-popup .whd-mix-pct { font-size:11px; color:#64748b; font-weight:950; text-align:right; }
      `;
      document.head.appendChild(s);
    })();
  // Fixes false category matches such as kitchen/appliances being marked as Clothing.
  // Rules use priority + word-boundary matching instead of broad includes like "bag" or "watch".
  // Replaces the older popup page with a cleaner manager-level dashboard while
  // preserving the existing PPR, WHD rollup, ASIN/title, gap, target and CSV logic.

  (function injectControlRoomStyles(){
    if (document.getElementById('whd-control-room-style')) return;
    const s = document.createElement('style');
    s.id = 'whd-control-room-style';
    s.textContent = `
      #whd-popup-backdrop{position:fixed;inset:0;background:rgba(2,6,23,.62);z-index:999998;backdrop-filter:blur(5px)}
      #whd-popup.cr-shell{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(1660px,99vw);height:min(940px,99vh);z-index:999999;border-radius:24px;overflow:hidden;display:flex;flex-direction:column;font-family:Inter,Segoe UI,Arial,sans-serif;background:#f6f8fb;color:#0f172a;box-shadow:0 30px 90px rgba(2,6,23,.45);border:1px solid rgba(148,163,184,.35)}
      #whd-popup.expanded{top:0!important;left:0!important;transform:none!important;width:100vw!important;height:100vh!important;border-radius:0!important}
      #whd-popup .cr-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 22px;background:linear-gradient(135deg,#0f172a,#1e3a8a 58%,#f97316);color:white;flex-shrink:0}
      #whd-popup .cr-brand{display:flex;align-items:center;gap:14px}.cr-logo{width:56px;height:56px;border-radius:18px;background:rgba(255,255,255,.16);display:flex;align-items:center;justify-content:center;font-weight:950;border:1px solid rgba(255,255,255,.28)}
      #whd-popup h1{font-size:18px;margin:0;font-weight:950;letter-spacing:-.02em}#whd-popup p{margin:4px 0 0}.cr-brand p{font-size:12px;color:#dbeafe;font-weight:800}.cr-actions{display:flex;gap:8px;flex-wrap:wrap}.cr-actions button,#whd-popup .cr-target button,#whd-popup .cr-panel-head button{border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.13);color:inherit;border-radius:12px;padding:9px 12px;font-weight:900;cursor:pointer}.cr-actions button:hover{background:rgba(255,255,255,.22)}
      .cr-command-main span,.cr-kpi span,.cr-target label{display:block;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:950}.cr-command-main strong{font-size:34px;line-height:1;font-weight:950}.cr-command-main em,.cr-kpi small{display:block;font-style:normal;color:#64748b;font-size:12px;font-weight:850;margin-top:5px}.cr-kpi b{display:block;font-size:22px;margin-top:5px}.cr-kpi.good b{color:#16a34a}.cr-kpi.warn b{color:#d97706}.cr-kpi.bad b{color:#dc2626}
      .cr-bar{height:9px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin:9px 0}.cr-bar i{display:block;height:100%;border-radius:999px;background:#64748b}.cr-bar i.good{background:#22c55e}.cr-bar i.warn{background:#f59e0b}.cr-bar i.bad{background:#ef4444}.cr-target{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.cr-target label{grid-column:1/-1}.cr-target input{border:1px solid #cbd5e1;border-radius:12px;padding:9px;background:#fff;color:#0f172a;font-weight:900;width:100%}.cr-target button,.cr-panel-head button{background:#2563eb!important;color:white!important;border-color:#2563eb!important}
      @media(max-width:1200px){#whd-popup .cr-command{grid-template-columns:1fr 1fr}.cr-body{grid-template-columns:1fr}.cr-card-grid{grid-template-columns:1fr}.cr-strip{grid-template-columns:repeat(2,1fr)}}
    `;
    document.head.appendChild(s);
  })();
  // Main priority: AA → items → gaps. Removes bridge/pie chart sections.
  // Big gaps >15 mins are warned in Shift Summary. Larger fonts for shift use.

  const WHD_BIG_GAP_MIN = 15;

  function whdAllScansSorted(d) {
    return (d?.scanList || d?.scans || []).filter(s => s && s.asin).slice().sort((a,b)=>Number(a.time||0)-Number(b.time||0));
  }

  function whdItemTitle(asin) {
    if (!asin) return '—';
    const meta = (typeof asinCategoryCache !== 'undefined' && asinCategoryCache.get) ? (asinCategoryCache.get(asin) || {}) : {};
    return meta.title || asinTitleCache.get(asin) || 'Loading title…';
  }

  function whdItemCat(asin) {
    if (!asin) return {family:'—', type:'', icon:'', cls:'unknown'};
    const title = whdItemTitle(asin);
    try { return classifyAsinItem(asin, title && title !== 'Loading title…' ? title : ''); }
    catch(_) { return {family:'Loading', type:'Category', icon:'⏳', cls:'unknown'}; }
  }

  function whdItemCell(asin, extra='') {
    if (!asin) return '—';
    const title = whdItemTitle(asin);
    return `<div class="whd-item-cell">
      <a class="whd-asin" href="${esc(fcResearchUrl(asin))}" target="_blank">${esc(asin)}</a>
      <a class="whd-title" data-asin-title="${esc(asin)}" href="https://www.amazon.com.au/dp/${esc(asin)}" target="_blank">${esc(title)}</a>
      ${extra ? `<div class="whd-item-extra">${extra}</div>` : ''}
    </div>`;
  }

  function whdCatPill(asin) {
    const cat = whdItemCat(asin);
    return `<span class="whd-cat-pill" data-asin-classify="${esc(asin||'')}">${esc((cat.icon||'') + ' ' + (cat.family||'—') + (cat.type ? ' | '+cat.type : ''))}</span>`;
  }

  function whdGapsForAA(d) {
    const out = [];
    (d?.qResults || []).forEach(q => (q.gaps || []).forEach(g => {
      out.push(Object.assign({}, g, {
        aa: d.name || 'AA',
        q: q.label || '',
        fromAsin: (g.asinBefore || '').toUpperCase(),
        toAsin: (g.bridgeAsin || g.asinAfter || '').toUpperCase(),
      }));
    }));
    return out.sort((a,b)=>Number(b.mins||0)-Number(a.mins||0));
  }

  function whdGapTimeNote(g) {
    if (!g || !g.breakAdjusted) return '';
    const raw = Number(g.rawMins || 0);
    return raw ? `Break adjusted from ${raw}m raw gap` : 'Break adjusted';
  }

  function whdMainCategoryForAA(d) {
    const counts = {};
    whdAllScansSorted(d).forEach(s => {
      const cat = whdItemCat(s.asin);
      const name = cat.family || 'Loading';
      const qty = Number(s.qty || 1) || 1;
      counts[name] = (counts[name] || 0) + qty;
    });
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    return top ? `${top[0]} (${top[1]})` : 'Loading…';
  }

  function whdCategorySummaryHtml() {
    const counts = {};
    whdPopupData.forEach(d => whdAllScansSorted(d).forEach(s => {
      const cat = whdItemCat(s.asin);
      const key = (cat.icon ? cat.icon + ' ' : '') + (cat.family || 'Loading');
      counts[key] = (counts[key] || 0) + (Number(s.qty || 1) || 1);
    }));
    const rows = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,12);
    if (!rows.length) return `<div class="whd-muted-big">Categories loading from ASIN titles…</div>`;
    return `<div class="whd-category-grid">${rows.map(([k,v])=>`<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>`;
  }

  function whdCategoryPieHtml() {
    const counts = {};
    let total = 0;
    whdPopupData.forEach(d => whdAllScansSorted(d).forEach(s => {
      const cat = whdItemCat(s.asin);
      const key = (cat.icon ? cat.icon + ' ' : '') + (cat.family || 'Loading');
      const qty = Number(s.qty || 1) || 1;
      counts[key] = (counts[key] || 0) + qty;
      total += qty;
    }));
    const rows = Object.entries(counts).filter(([k])=>!/Loading/i.test(k)).sort((a,b)=>b[1]-a[1]).slice(0,7);
    if (!rows.length) return `<div class="whd-muted-big">Category pie loading from ASIN titles…</div>`;
    const colors = ['#2563eb','#f59e0b','#16a34a','#dc2626','#7c3aed','#0891b2','#db2777'];
    let start = 0;
    const stops = rows.map(([_,v],i)=>{
      const pct = total ? (v/total*100) : 0;
      const end = start + pct;
      const seg = `${colors[i%colors.length]} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
      start = end;
      return seg;
    }).join(', ');
    return `<div class="whd-cat-viz"><div class="whd-cat-pie" style="background:conic-gradient(REPLACE_SEGMENTS)"><strong>${total}</strong><span>items</span></div><div class="whd-cat-legend">${rows.map(([k,v],i)=>`<div><i style="background:${colors[i%colors.length]}"></i><b>${esc(k)}</b><span>${v}</span></div>`).join('')}</div></div>`.replace('REPLACE_SEGMENTS', stops);
  }

  function whdSizeBarHtml() {
    let s=0,m=0,l=0;
    whdPopupData.forEach(d => {
      const c = getSizeCounts(d);
      s += Number(c.small||0); m += Number(c.medium||0); l += Number(c.large||0);
    });
    const max = Math.max(1,s,m,l);
    const row = (label,val,cls) => `<div class="whd-size-row"><span>${label}</span><div><i class="${cls}" style="width:${Math.max(3, val/max*100)}%"></i></div><b>${val}</b></div>`;
    return `<div class="whd-size-bars">${row('Small',s,'small')}${row('Medium',m,'medium')}${row('Large',l,'large')}</div>`;
  }

  function whdPprPlanSentence(actualUnits, planUnits, customTarget) {
    actualUnits = Number(actualUnits || 0);
    planUnits = Number(planUnits || 0);
    const manualTarget = Number(customTarget || 0);
    const activeTarget = manualTarget || planUnits;
    if (!activeTarget) return 'Enter a daily target or wait for PPR planned units to calculate how many items are needed.';
    const diff = Math.round(activeTarget - actualUnits);
    const label = manualTarget ? 'updated target' : 'WHD planned target';
    if (diff > 0) return `Sort approximately ${diff.toLocaleString()} more item${diff===1?'':'s'} to meet the ${label}.`;
    return `Currently ahead of the ${label} by ${Math.abs(diff).toLocaleString()} item${Math.abs(diff)===1?'':'s'}.`;
  }

  function whdSupportLine(ppr) {
    const actual = Number(ppr.actualSupportHours || 0);
    const plan = Number(ppr.plannedSupportHours || 0);
    let diff = actual - plan;
    let label = 'Support hrs';
    if (!actual && !plan) {
      const ah = Number(ppr.actualHours || 0), ph = Number(ppr.planHours || 0);
      diff = ah - ph;
      label = 'Hours gap';
    }
    if (!Number.isFinite(diff) || (!actual && !plan && !ppr.actualHours && !ppr.planHours)) return `${label}: —`;
    const sign = diff >= 0 ? '+' : '';
    return `${label}: ${sign}${diff.toFixed(1)} hrs`;
  }

  function whdShiftCommentary() {
    const counts = {};
    let total = 0;
    whdPopupData.forEach(d => whdAllScansSorted(d).forEach(s => {
      if (!s.asin) return;
      const cat = whdItemCat(s.asin);
      const family = cat.family || 'Loading';
      const qty = Number(s.qty || 1) || 1;
      counts[family] = (counts[family] || 0) + qty;
      total += qty;
    }));
    const entries = Object.entries(counts).filter(([k]) => k && k !== 'Loading').sort((a,b)=>b[1]-a[1]);
    if (!entries.length) return 'Item categories are still loading; review ASINs and big gaps first.';
    const [topName, topCount] = entries[0];
    const pct = total ? Math.round(topCount / total * 100) : 0;
    if (/tech|electronics|computer|gaming/i.test(topName)) return `Tech-heavy shift: ${topName} is leading the mix (${topCount} items, ${pct}%). Lower TPH may be expected if testing/inspection is required.`;
    if (/appliance|kitchen/i.test(topName)) return `Kitchen/appliance-heavy shift: ${topName} is leading the mix (${topCount} items, ${pct}%). Review large gaps separately from item category.`;
    if (/tools|diy|home improvement/i.test(topName)) return `DIY/tools-heavy shift: ${topName} is leading the mix (${topCount} items, ${pct}%). Review large gaps separately from item category.`;
    return `Main item mix today: ${topName} (${topCount} items, ${pct}%). Review any >${WHD_BIG_GAP_MIN} min gaps from the AA gap dropdown.`;
  }

  function whdPreloadVisibleItems(root) {
    try {
      const priority = [];
      const all = [];
      whdPopupData.forEach(d => {
        whdGapsForAA(d).forEach(g => {
          if (g.fromAsin) priority.push(g.fromAsin);
          if (g.toAsin) priority.push(g.toAsin);
        });
        whdAllScansSorted(d).forEach(s => { if (s.asin) all.push(s.asin); });
      });
      // Gap ASINs load first and must get titles. Then load every AA item ASIN in background.
      const ordered = [...new Set([...priority, ...all])].filter(Boolean).slice(0, 600);
      let idx = 0, active = 0;
      const max = 7;
      const pump = () => {
        while (active < max && idx < ordered.length) {
          const asin = ordered[idx++];
          active++;
          fetchAsinMeta(asin, meta => {
            active--;
            if (root && document.body.contains(root)) {
              updateAsinTitleAndTypeInPopup(root, asin, meta?.title || asinTitleCache.get(asin) || '');
              const catWrap = root.querySelector('#whd-category-summary');
              if (catWrap) catWrap.innerHTML = whdCategorySummaryHtml();
              const cmt = root.querySelector('#whd-shift-commentary');
              if (cmt) cmt.textContent = whdShiftCommentary();
            }
            pump();
          });
        }
      };
      pump();
    } catch(e) { console.warn('[WHD preload items]', e); }
  }

  function whdAASizeMiniHtml(d) {
    const c = getSizeCounts(d) || {};
    return `<small class="whd-size-mini">S ${Number(c.small||0)} &nbsp; M ${Number(c.medium||0)} &nbsp; L ${Number(c.large||0)}</small>`;
  }

  function whdQuarterCardsHtml() {
    const rows = getOverallQuarterBridgeData ? getOverallQuarterBridgeData() : [];
    if (!rows.length) return `<section class="whd-quarter-strip whd-quarter-grid"><div class="whd-quarter-card"><b>Q1-Q4</b><small>Quarter data loading</small></div></section>`;
    return `<section class="whd-quarter-strip whd-quarter-grid">${rows.map(r => {
      const pct = r.target ? Math.min(140, Math.round((Number(r.actual||0) / Math.max(1, Number(r.target||0))) * 100)) : 0;
      const gapCount = whdPopupData.reduce((sum,d)=>sum + ((d.qResults||[]).find(q=>q.label===r.label)?.gaps?.length || 0),0);
      const cls = r.target && Number(r.actual||0) >= Number(r.target||0) ? 'hit' : (r.target ? 'miss' : 'neutral');
      return `<div class="whd-quarter-card ${cls}">
        <div class="whd-quarter-top"><b>${esc(r.label)}</b><span>${esc(absToHHMM(r.start))}–${esc(absToHHMM(r.end))}</span></div>
        <div class="whd-quarter-main"><strong>${Number(r.actual||0).toLocaleString()}</strong><em>${Number(r.target||0) ? '/ ' + Number(r.target||0).toLocaleString() : '/ —'} target</em></div>
        <div class="whd-quarter-bar"><i style="width:${pct}%"></i></div>
        <small>Gap mins: ${Number(r.gapMins||0)} • Gap count: ${gapCount}</small>
      </div>`;
    }).join('')}</section>`;
  }

  function whdTotalGapCount() {
    return whdPopupData.reduce((sum,d)=>sum + whdGapsForAA(d).length,0);
  }

  function whdQuarterWebData() {
    const rows = getOverallQuarterBridgeData ? getOverallQuarterBridgeData() : [];
    return rows.map(r => {
      const gapCount = whdPopupData.reduce((sum,d)=>sum + ((d.qResults||[]).find(q=>q.label===r.label)?.gaps?.length || 0),0);
      return {...r, gapCount};
    });
  }

  showWHDPopup = function showWHDPopupReadableOps() {
    document.getElementById('whd-popup-overlay')?.remove();
    const ppr = _pprWHDMetrics || {};
    const expected = 9.61;
    const actualRate = Number(getPPRActualWHDTPH() || ppr.actualTPH || 0);
    const planRate = Number(getPPRPlanWHDTPH() || ppr.planTPH || expected);
    const actualUnits = Number(ppr.actualUnits || 0) || whdPopupData.reduce((sum,d)=>sum + Number(d?.perf?.units || getAssociateProcessed(d) || 0),0);
    const planUnits = Number(ppr.planUnits || 0);
    const manualTarget = getTargetValue();
    const activeTargetUnits = manualTarget || planUnits;
    // Planned hours/support hours intentionally hidden from the dashboard.
    const sizeMixTopHtml = whdSizeBarHtml();
    const pctPlan = (actualRate && planRate) ? Math.round(actualRate / planRate * 100) : 0;
    const teamAvg = getTeamAvgTPH(whdPopupData);
    const dateStr = new URLSearchParams(location.search).get('startDateIntraday') || new Date().toLocaleDateString();

    const sorted = whdPopupData.slice().sort((a,b)=>getAssociateAvgTPH(b)-getAssociateAvgTPH(a));
    const allGaps = sorted.flatMap(whdGapsForAA);
    const bigGaps = allGaps.filter(g => Number(g.mins||0) >= WHD_BIG_GAP_MIN).sort((a,b)=>Number(b.mins||0)-Number(a.mins||0));
    const totalGapCount = allGaps.length;
    const popupHc = sorted.length;
    const popupQuarterRows = (typeof whdQuarterWebData === 'function') ? whdQuarterWebData() : [];
    const popupShiftHours = popupQuarterRows.reduce((sum,r)=>sum + Math.max(0, Number(r.end||0)-Number(r.start||0))/60,0) || 9;
    // Main-target bridge only: do not request HC just because a quarter is behind.
    // If PPR actual rate is available it is already TEAM TPH, so do not multiply it by HC.
    const popupAvgAaTph = Number(teamAvg || 0);
    const popupTeamTph = Number(actualRate || (popupAvgAaTph * Math.max(1, popupHc)) || 0);
    const popupProjection = popupTeamTph ? Math.round(popupTeamTph * popupShiftHours) : 0;
    const popupPerHcTph = popupHc ? (popupTeamTph / Math.max(1, popupHc)) : popupAvgAaTph;
    const popupReqHc = activeTargetUnits && popupPerHcTph ? Math.ceil(activeTargetUnits / Math.max(1, popupPerHcTph * popupShiftHours)) : 0;
    const popupHcGap = Math.max(0, popupReqHc - popupHc);
    const popupProjectionText = `Current HC ${popupHc || '—'} • total projection ${popupProjection ? popupProjection.toLocaleString() : '—'} items${activeTargetUnits ? ' / target ' + activeTargetUnits.toLocaleString() : ''}.`;
    const popupMix = getItemMixCounts ? getItemMixCounts() : {};
    const popupTechMix = Number((popupMix.tech||0) + (popupMix.gaming||0) + (popupMix.appliances||0));
    const popupLargeMix = sorted.reduce((sum,d)=>sum + Number((getSizeCounts(d)||{}).large||0),0);
    const popupItemBridge = (popupTechMix || popupLargeMix)
      ? `Performance may be impacted by item nature: ${popupTechMix ? popupTechMix.toLocaleString() + ' tech/electric/appliance items' : 'tech/electric items'}${popupLargeMix ? ' and ' + popupLargeMix.toLocaleString() + ' large/bulky items' : ''}. Longer testing/handling time is expected for those item types.`
      : `Performance may be impacted by tech/electric testing or large/bulky item handling when those items are in the mix.`;
    const popupSmartSummary = `${popupItemBridge} Team rate is ${popupTeamTph ? popupTeamTph.toFixed(1) : '—'} TPH${activeTargetUnits ? ', target ' + activeTargetUnits.toLocaleString() + ' items' : ''}. Total gap count ${totalGapCount}; big gaps ${bigGaps.length}.`;
    const quarterCardsHtml = whdQuarterCardsHtml();

    const warningHtml = bigGaps.length ? bigGaps.slice(0,10).map(g => {
      const d = sorted.find(x => String(x.name||'') === String(g.aa||'')) || {};
      const toAsin = (g.toAsin || g.bridgeAsin || g.asinAfter || '').toUpperCase();
      return `<div class="whd-warning-row whd-warning-card">
        <a class="whd-warn-aa" href="${esc(d.detailUrl||'#')}" target="_blank">${aaAvatarHtml(d,36)}<b>${esc(g.aa||d.name||'AA')}</b></a>
        <span>${esc(g.mins)}m</span>
        <em>${esc(g.timeBefore||'—')} → ${esc(g.timeAfter||'—')} ${g.q ? '• '+esc(g.q) : ''}</em>
        <div class="whd-warn-item">${toAsin ? whdItemCell(toAsin) + whdCatPill(toAsin) : '—'}</div>
        <a class="whd-review-link" href="${esc(d.detailUrl||'#')}" target="_blank">Review</a>
      </div>`;
    }).join('') : `<div class="whd-good-line">No large scan gaps over ${WHD_BIG_GAP_MIN} minutes detected.</div>`;

    const aaRows = sorted.map((d, idx) => {
      const tph = getAssociateAvgTPH(d);
      const units = getAssociateProcessed(d);
      const gaps = whdGapsForAA(d);
      const biggest = gaps[0] || null;
      const recentItems = whdAllScansSorted(d).slice().reverse();
      const gapTarget = `whd_gap_${idx}_${String(d.name||'aa').replace(/[^a-z0-9]/gi,'_')}`;
      const itemTarget = `whd_items_${idx}_${String(d.name||'aa').replace(/[^a-z0-9]/gi,'_')}`;
      const status = gaps.some(g=>Number(g.mins||0)>=WHD_BIG_GAP_MIN) ? 'review' : 'stable';
      const beforeProcessingAsin = biggest ? (biggest.toAsin || biggest.bridgeAsin || biggest.asinAfter || '') : '';
      const gapDisplay = biggest
        ? `<b class="${Number(biggest.mins)>=WHD_BIG_GAP_MIN?'bad':''}">${esc(biggest.mins)}m</b><small>${esc(biggest.timeBefore||'—')} → ${esc(biggest.timeAfter||'—')}${biggest.q ? ' • '+esc(biggest.q) : ''}</small>`
        : `<b style="color:#16a34a">0m</b><small>No gap found</small>`;

      const beforeProcessingCell = beforeProcessingAsin
        ? `<div>${whdItemCell(beforeProcessingAsin)}${whdCatPill(beforeProcessingAsin)}</div>`
        : `<span style="color:#94a3b8;font-weight:900">No before-processing item</span>`;

      const gapRows = gaps.map(g => {
        const asin = g.toAsin || g.bridgeAsin || g.asinAfter || '';
        return `<tr class="${Number(g.mins||0)>=WHD_BIG_GAP_MIN?'biggap':''}">
          <td><b>${esc(g.mins)}m</b><small>${esc(g.timeBefore||'—')} → ${esc(g.timeAfter||'—')} ${g.q? '• '+esc(g.q):''}</small></td>
          <td>${asin ? whdItemCell(asin) : '—'}${asin ? whdCatPill(asin) : ''}</td>
          <td><a class="whd-review-link" href="${esc(d.detailUrl||'#')}" target="_blank">Review</a></td>
        </tr>`;
      }).join('') || `<tr><td colspan="3" class="whd-muted-big">No ${WHD.GAP_MIN}+ min gaps.</td></tr>`;

      const sizeMiniHtml = whdAASizeMiniHtml(d);

      const itemRows = recentItems.map((s, n) => `<tr>
        <td>${esc(absToHHMM(s.time))}</td><td>${n+1}</td><td>${whdItemCell(s.asin)}</td><td>${whdCatPill(s.asin)}</td><td>${esc(normSize(s.size||''))}</td><td>${esc(s.qty||1)}</td>
      </tr>`).join('') || `<tr><td colspan="6" class="whd-muted-big">No item scans loaded.</td></tr>`;

      return `<tr class="whd-aa-main ${status}" data-aa-row data-status="${status}" data-name="${esc(String(d.name||'').toLowerCase())}">
        <td><div class="whd-aa-person">${aaAvatarHtml(d,38)}<a href="${esc(d.detailUrl||'#')}" target="_blank" class="whd-aa-name">${esc(d.name||'AA')}</a></div></td>
        <td><b>${tph ? tph.toFixed(1) : '—'}</b><small>Expected 9.61</small></td>
        <td>${gapDisplay}</td>
        <td>${beforeProcessingCell}</td>
        <td style="text-align:center"><b>${units}</b><small>processed</small>${sizeMiniHtml}<button class="whd-row-btn light" data-toggle-row="${itemTarget}">Items</button></td>
        <td style="text-align:center"><button class="whd-row-btn" data-toggle-row="${gapTarget}">${gaps.length}</button><small>click for details</small></td>
      </tr>
      <tr id="${gapTarget}" class="whd-detail-row" style="display:none"><td colspan="6"><div class="whd-detail-box"><h3>${esc(d.name||'AA')} - Gap Details</h3><table class="whd-ops-table"><thead><tr><th>Gap</th><th>Before processing item</th><th>Action</th></tr></thead><tbody>${gapRows}</tbody></table></div></td></tr>
      <tr id="${itemTarget}" class="whd-detail-row" style="display:none"><td colspan="6"><div class="whd-detail-box"><h3>${esc(d.name||'AA')} all processed items</h3><table class="whd-ops-table"><thead><tr><th>Time</th><th>#</th><th>ASIN / Title</th><th>Category</th><th>Size</th><th>Qty</th></tr></thead><tbody>${itemRows}</tbody></table></div></td></tr>`;
    }).join('') || `<tr><td colspan="6" class="whd-muted-big">No WHD associates loaded yet. Keep popup open or press Refresh.</td></tr>`;

    const overlay = document.createElement('div');
    overlay.id = 'whd-popup-overlay';
    overlay.innerHTML = `<div id="whd-popup-backdrop"></div>
      <div id="whd-popup" class="whd-readable">
        <header class="whd-head"><div><h1>AR Performance Dashboard</h1><p>${esc(dateStr)} • AA, items, categories, and scan gaps</p></div><div class="whd-actions"><button id="whd-open-page">🌐 Web Page View</button><button id="whd-theme-toggle">🌙 Dark</button><button id="whd-refresh-all">🔄 Refresh</button><button id="whd-download-csv">Export CSV</button><button id="whd-popup-close">✕</button></div></header>
        <section class="whd-summary-grid whd-summary-grid-v1814">
          <div class="whd-hero"><span>Total Items</span><b>${actualUnits ? actualUnits.toLocaleString() : '—'}</b><em>PPR plan ${planUnits ? planUnits.toLocaleString() : '—'}</em></div>
          <div><span>PPR Actual Rate</span><b>${actualRate ? actualRate.toFixed(2) : '—'}</b><em>${pctPlan ? pctPlan+'% of plan' : 'Loading from PPR Warehouse Deals'}</em></div>
          <div><span>Planned / Expected TPH</span><b>${planRate ? planRate.toFixed(2) : '9.61'}</b><em>Target comparison</em></div>
          <div class="whd-target-card"><span>Daily Target</span><div class="whd-target-edit"><input id="whd-target-input" type="number" min="0" step="1" value="${manualTarget || planUnits || ''}" placeholder="Target"><button id="whd-update-target">Update</button></div><em>${manualTarget ? 'Manual updated target' : 'Using PPR planned units if available'}</em></div>
          <div class="whd-size-top-card"><span>Size Mix</span>${sizeMixTopHtml}<em>Small / Medium / Large from WHD rollup/scans</em></div>
        </section>
        ${quarterCardsHtml}
        <section class="whd-target-line" id="whd-target-sentence">${esc(whdPprPlanSentence(actualUnits, planUnits, manualTarget))}</section>
        ${!ppr.ok ? `<div class="whd-alert">⚠ PPR Warehouse Deals row did not parse cleanly. Open PPR and share the Warehouse Deals row/headers if rate is blank. <a href="${esc(ppr.url||buildProcessPathRollupUrl())}" target="_blank">Open PPR</a></div>` : ''}
        <main class="whd-main">
          <section class="whd-panel whd-aa-panel"><div class="whd-panel-head"><h2>AA Items & Gaps</h2><div><input id="whd-aa-search" placeholder="Search AA"><select id="cr-risk-filter"><option value="all">All</option><option value="review">Big gaps only</option><option value="stable">Stable only</option></select></div></div><table class="whd-aa-table"><thead><tr><th>Associate</th><th>TPH</th><th>GAP</th><th>Before processing</th><th>Total Items</th><th>Total Gaps <small class="whd-head-mini">Total: ${totalGapCount}</small></th></tr></thead><tbody>${aaRows}</tbody></table></section>
          <section class="whd-panel"><div class="whd-panel-head"><h2>Shift Summary</h2><span>Only big gaps over ${WHD_BIG_GAP_MIN} minutes</span></div><div id="whd-shift-commentary" class="whd-commentary">${esc(popupSmartSummary)}</div><div class="whd-warning-list">${warningHtml}</div></section>
          <section class="whd-panel whd-category-panel"><div class="whd-panel-head"><h2>Category Summary</h2><span>No pie chart</span></div><div id="whd-category-summary">${whdCategorySummaryHtml()}</div></section>
        </main>
        <footer class="whd-footer">Gap means time between two scans. Scheduled breaks are excluded/adjusted. Time is reviewed before the next scanned item, not blamed on the category.</footer>
      </div>`;
    document.body.appendChild(overlay);

    if (!document.getElementById('whd-readable-v1811-style')) {
      const style = document.createElement('style');
      style.id = 'whd-readable-v1811-style';
      style.textContent = `
        #whd-popup-backdrop{position:fixed;inset:0;background:rgba(2,6,23,.62);z-index:999998;backdrop-filter:blur(4px)}
        #whd-popup.whd-readable{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;width:min(1700px,98.5vw);height:min(900px,96vh);background:#f8fafc;color:#0f172a;border-radius:22px;box-shadow:0 28px 90px rgba(2,6,23,.45);font-family:Segoe UI,Arial,sans-serif;display:flex;flex-direction:column;overflow:hidden;border:1px solid #cbd5e1;font-size:16px}
        .whd-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 18px;background:linear-gradient(135deg,#0f172a,#1d4ed8 60%,#f97316);color:white;flex-shrink:0}.whd-head h1{margin:0;font-size:22px;font-weight:950}.whd-head p{margin:4px 0 0;font-size:13px;color:#dbeafe;font-weight:800}.whd-actions{display:flex;gap:8px;flex-wrap:wrap}.whd-actions button,.whd-row-btn,.whd-review-btn{border:0;border-radius:12px;padding:8px 11px;font-size:13px;font-weight:900;cursor:pointer;background:#2563eb;color:white}.whd-actions button{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.28)}.whd-row-btn{padding:8px 11px;margin:2px;background:#0f172a}.whd-row-btn.light{background:#475569}.whd-review-btn,.whd-review-link{background:#f97316;color:white!important;text-decoration:none;display:inline-block}.whd-review-link{border:0;border-radius:12px;padding:8px 11px;font-size:13px;font-weight:900;cursor:pointer}
        .whd-summary-grid{display:grid;grid-template-columns:1.05fr repeat(6,minmax(0,1fr));gap:7px;padding:8px 14px;background:white;border-bottom:1px solid #e2e8f0}.whd-summary-grid>div{background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:9px}.whd-summary-grid span{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:950;color:#64748b}.whd-summary-grid b{display:block;font-size:19px;margin-top:3px;font-weight:950}.whd-compact-card b{font-size:20px!important}.whd-summary-grid .whd-hero b{font-size:28px}.whd-summary-grid em{display:block;font-style:normal;font-size:12px;color:#64748b;margin-top:3px;font-weight:800}.whd-target-edit{display:flex;gap:6px;margin-top:8px}.whd-target-edit input{width:100%;min-width:80px;border:1px solid #cbd5e1;border-radius:10px;padding:9px 10px;font-size:17px;font-weight:950}.whd-target-edit button{border:0;background:#2563eb;color:white;border-radius:10px;padding:9px 10px;font-size:12px;font-weight:950;cursor:pointer}.support-plus b{color:#dc2626}.support-minus b{color:#16a34a}.whd-target-line{margin:8px 14px 0;padding:9px 12px;border-radius:14px;background:#eff6ff;border:1px solid #93c5fd;color:#1e3a8a;font-size:13px;font-weight:950}.whd-alert{margin:10px 18px;padding:12px;border-radius:12px;background:#fff7ed;border:1px solid #fdba74;color:#9a3412;font-weight:900}
        .whd-main{padding:10px 14px;overflow:auto;display:flex;flex-direction:column;gap:10px}.whd-panel{background:white;border:1px solid #e2e8f0;border-radius:16px;padding:10px;box-shadow:0 12px 30px rgba(15,23,42,.05)}.whd-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}.whd-panel-head h2{font-size:18px;margin:0;font-weight:950}.whd-panel-head span{font-size:14px;color:#64748b;font-weight:850}.whd-panel-head input,.whd-panel-head select{font-size:14px;border:1px solid #cbd5e1;border-radius:10px;padding:8px 10px;margin-left:6px}
        .whd-aa-table,.whd-ops-table{width:100%;border-collapse:collapse;font-size:14px}.whd-aa-table th,.whd-aa-table td,.whd-ops-table th,.whd-ops-table td{border-bottom:1px solid #e2e8f0;padding:8px 8px;text-align:left;vertical-align:top}.whd-aa-table th,.whd-ops-table th{font-size:11px;text-transform:uppercase;color:#64748b;font-weight:950;position:sticky;top:0;background:white;z-index:1}.whd-aa-main.review{background:#fff7ed}.whd-aa-main b.bad{color:#dc2626}.whd-aa-name{font-size:13px;font-weight:950;text-decoration:none}.whd-aa-table small,.whd-ops-table small{display:block;font-size:12px;color:#64748b;font-weight:800;margin-top:3px}.whd-detail-box{background:#f8fafc;border:1px solid #cbd5e1;border-radius:14px;padding:9px;margin:2px 0 10px}.whd-detail-box h3{font-size:17px;margin:0 0 8px;font-weight:950}.whd-ops-table tr.biggap{background:#fff7ed}
        .whd-item-cell{min-width:260px}.whd-asin{display:inline-block;font-family:Consolas,monospace;font-size:13px;font-weight:950;background:#e0f2fe;color:#075985!important;padding:3px 8px;border-radius:999px;text-decoration:none;margin-bottom:4px}.whd-title{display:block;font-size:13px;font-weight:850;color:#334155;text-decoration:none;max-width:520px;white-space:normal;line-height:1.3}.whd-item-extra{font-size:12px;color:#92400e;margin-top:3px;font-weight:900}.whd-cat-pill{display:inline-block;font-size:12px;font-weight:950;background:#eef2ff;color:#1e40af;border-radius:999px;padding:5px 9px;white-space:normal}.whd-commentary{font-size:13px;font-weight:950;color:#1e3a8a;background:#eff6ff;border:1px solid #93c5fd;border-radius:14px;padding:12px 14px;margin-bottom:12px}.whd-warning-list{display:grid;gap:8px}.whd-warning-row{display:grid;grid-template-columns:180px 70px 130px 150px 1fr;align-items:start;gap:10px;padding:10px;border-radius:14px;background:#fff7ed;border:1px solid #fdba74}.whd-warning-row b{font-size:17px}.whd-warning-row span{font-size:13px;font-weight:950;color:#dc2626}.whd-warning-row em{font-style:normal;color:#64748b;font-weight:850}.whd-warning-row strong{font-size:14px;color:#92400e}.whd-good-line,.whd-muted-big{font-size:16px;color:#64748b;font-weight:850;padding:12px}.whd-bottom-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.whd-category-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.whd-category-grid div{background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:12px}.whd-category-grid b{font-size:24px;margin-right:9px}.whd-category-grid span{font-size:15px;font-weight:900;color:#334155}.whd-size-bars{display:grid;gap:14px}.whd-size-row{display:grid;grid-template-columns:90px 1fr 70px;gap:10px;align-items:center}.whd-size-row span,.whd-size-row b{font-size:13px;font-weight:950}.whd-size-row div{height:22px;background:#e2e8f0;border-radius:999px;overflow:hidden}.whd-size-row i{display:block;height:100%;border-radius:999px}.whd-size-row i.small{background:#0ea5e9}.whd-size-row i.medium{background:#f59e0b}.whd-size-row i.large{background:#ef4444}.whd-size-top-card .whd-size-bars{gap:8px;margin-top:8px}.whd-size-top-card .whd-size-row{grid-template-columns:62px 1fr 42px;gap:7px}.whd-size-top-card .whd-size-row span,.whd-size-top-card .whd-size-row b{font-size:13px}.whd-size-top-card .whd-size-row div{height:13px}.whd-category-panel{width:100%;box-sizing:border-box}.whd-footer{padding:8px 14px;border-top:1px solid #e2e8f0;font-size:14px;color:#64748b;font-weight:850}
        .whd-aa-person{display:flex;align-items:center;gap:9px;min-width:0}.whd-aa-person .whd-aa-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.whd-aa-person .aa-avatar,.whd-aa-person .aa-avatar-fallback{flex-shrink:0}

        .whd-warning-card{grid-template-columns:210px 70px 130px minmax(0,1fr) 82px!important;align-items:center!important}.whd-warn-aa{display:flex;align-items:center;gap:8px;text-decoration:none;color:#0f172a;min-width:0}.whd-warn-aa b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px!important}.whd-warn-aa .aa-avatar,.whd-warn-aa .aa-avatar-fallback{flex:0 0 36px}.whd-warn-item{min-width:0}.whd-warn-item .whd-item-cell{min-width:0!important}.whd-warn-item .whd-title{max-width:100%!important;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.whd-warn-item .whd-cat-pill{margin-top:4px}
        .whd-quarter-strip.whd-quarter-grid{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:8px!important;padding:8px 14px;background:var(--whd-popup-bg,#f8fafc);border-bottom:1px solid var(--whd-popup-line,#e2e8f0)}.whd-quarter-card{background:var(--whd-popup-card,#fff)!important;border:1px solid var(--whd-popup-line,#e2e8f0)!important;border-radius:14px!important;padding:9px!important;min-width:0!important;overflow:hidden!important;box-shadow:0 8px 18px rgba(15,23,42,.06)}.whd-quarter-top{display:flex;justify-content:space-between;gap:6px;align-items:center}.whd-quarter-top b{font-size:13px!important;white-space:nowrap}.whd-quarter-top span,.whd-quarter-card small{color:var(--whd-popup-muted,#64748b)!important;font-size:11px!important;font-weight:900!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}.whd-quarter-main{display:flex!important;align-items:baseline!important;gap:6px!important;margin-top:2px!important}.whd-quarter-main strong{font-size:22px!important;line-height:1!important;white-space:nowrap!important;font-variant-numeric:tabular-nums;color:var(--whd-popup-text,#0f172a)!important}.whd-quarter-main em{font-style:normal;color:var(--whd-popup-muted,#64748b)!important;font-size:11px!important;font-weight:850!important;white-space:nowrap!important}.whd-quarter-bar{height:7px;background:var(--whd-popup-bar,#e2e8f0);border-radius:99px;overflow:hidden;margin:6px 0}.whd-quarter-bar i{display:block;height:100%;background:#2563eb;border-radius:99px}.whd-quarter-card.hit .whd-quarter-bar i{background:#16a34a}.whd-quarter-card.miss .whd-quarter-bar i{background:#f59e0b}
        #whd-popup[data-theme="dark"]{--whd-popup-bg:#07111f;--whd-popup-card:#0f172a;--whd-popup-soft:#162235;--whd-popup-line:#334155;--whd-popup-text:#f8fafc;--whd-popup-muted:#cbd5e1;--whd-popup-bar:#334155;background:var(--whd-popup-bg)!important;color:var(--whd-popup-text)!important;border-color:var(--whd-popup-line)!important}#whd-popup[data-theme="dark"] .whd-summary-grid,#whd-popup[data-theme="dark"] .whd-main,#whd-popup[data-theme="dark"] .whd-footer{background:var(--whd-popup-bg)!important;border-color:var(--whd-popup-line)!important;color:var(--whd-popup-text)!important}#whd-popup[data-theme="dark"] .whd-summary-grid>div,#whd-popup[data-theme="dark"] .whd-panel,#whd-popup[data-theme="dark"] .whd-detail-box,#whd-popup[data-theme="dark"] .whd-category-grid div,#whd-popup[data-theme="dark"] .drop,#whd-popup[data-theme="dark"] .whd-quarter-card{background:var(--whd-popup-card)!important;border-color:var(--whd-popup-line)!important;color:var(--whd-popup-text)!important}#whd-popup[data-theme="dark"] .whd-aa-table th,#whd-popup[data-theme="dark"] .whd-ops-table th{background:var(--whd-popup-soft)!important;color:var(--whd-popup-muted)!important}#whd-popup[data-theme="dark"] .whd-aa-table td,#whd-popup[data-theme="dark"] .whd-ops-table td{border-color:var(--whd-popup-line)!important}#whd-popup[data-theme="dark"] .whd-aa-main.review,#whd-popup[data-theme="dark"] .whd-ops-table tr.biggap,#whd-popup[data-theme="dark"] .whd-warning-row{background:#2a1a12!important;border-color:#92400e!important}#whd-popup[data-theme="dark"] .whd-title,#whd-popup[data-theme="dark"] .whd-category-grid span,#whd-popup[data-theme="dark"] .whd-warn-aa{color:var(--whd-popup-text)!important}#whd-popup[data-theme="dark"] small,#whd-popup[data-theme="dark"] em,#whd-popup[data-theme="dark"] .whd-panel-head span,#whd-popup[data-theme="dark"] .whd-good-line,#whd-popup[data-theme="dark"] .whd-muted-big{color:var(--whd-popup-muted)!important}#whd-popup[data-theme="dark"] .whd-target-line,#whd-popup[data-theme="dark"] .whd-commentary{background:#10233f!important;border-color:#1d4ed8!important;color:#dbeafe!important}#whd-popup[data-theme="dark"] input,#whd-popup[data-theme="dark"] select{background:#0b1220!important;color:#f8fafc!important;border-color:#334155!important}

        /* Strong popup dark mode coverage for inline/old elements */
        #whd-popup[data-theme="dark"] .whd-aa-table,
        #whd-popup[data-theme="dark"] .whd-ops-table,
        #whd-popup[data-theme="dark"] .whd-detail-row,
        #whd-popup[data-theme="dark"] .whd-detail-row td,
        #whd-popup[data-theme="dark"] .whd-aa-main,
        #whd-popup[data-theme="dark"] .whd-category-summary,
        #whd-popup[data-theme="dark"] #whd-category-summary,
        #whd-popup[data-theme="dark"] .whd-category-panel,
        #whd-popup[data-theme="dark"] .whd-warning-card,
        #whd-popup[data-theme="dark"] .whd-warning-list {
          background:#0f172a!important;color:#f8fafc!important;border-color:#334155!important;
        }
        #whd-popup[data-theme="dark"] a,
        #whd-popup[data-theme="dark"] .whd-aa-name,
        #whd-popup[data-theme="dark"] .whd-item-title,
        #whd-popup[data-theme="dark"] [data-asin-title] a,
        #whd-popup[data-theme="dark"] [data-asin-title] {
          color:#dbeafe!important;
        }
        #whd-popup[data-theme="dark"] .whd-summary-grid span,
        #whd-popup[data-theme="dark"] .whd-summary-grid em,
        #whd-popup[data-theme="dark"] .whd-quarter-top span,
        #whd-popup[data-theme="dark"] .whd-quarter-card small,
        #whd-popup[data-theme="dark"] .whd-footer {
          color:#cbd5e1!important;
        }

        @media(max-width:1250px){.whd-warning-card{grid-template-columns:1fr!important}.whd-warn-aa b{white-space:normal}}
        @media(max-width:1250px){.whd-summary-grid{grid-template-columns:repeat(2,1fr)}.whd-quarter-strip{grid-template-columns:repeat(2,1fr)}.whd-bottom-grid{grid-template-columns:1fr}.whd-warning-row{grid-template-columns:1fr}.whd-head{flex-direction:column;align-items:flex-start}}
      `;
      document.head.appendChild(style);
    }

    const popup = overlay.querySelector('#whd-popup');
    const savedPopupTheme = localStorage.getItem('ar_whd_theme') || 'light';
    if (popup) popup.setAttribute('data-theme', savedPopupTheme);
    const popupThemeBtn = overlay.querySelector('#whd-theme-toggle');
    if (popupThemeBtn) popupThemeBtn.textContent = savedPopupTheme === 'dark' ? '☀️ Bright' : '🌙 Dark';
    // Popup dark/bright theme toggle: this was missing in the rebuilt V1 popup.
    // It applies the data-theme directly to #whd-popup, saves the choice, and keeps the web page theme in sync.
    popupThemeBtn?.addEventListener('click', () => {
      const current = popup?.getAttribute('data-theme') || localStorage.getItem('ar_whd_theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      if (popup) popup.setAttribute('data-theme', next);
      localStorage.setItem('ar_whd_theme', next);
      popupThemeBtn.textContent = next === 'dark' ? '☀️ Bright' : '🌙 Dark';
    });
    const applyFilter = () => {
      const q = (overlay.querySelector('#whd-aa-search')?.value || '').toLowerCase().trim();
      const f = overlay.querySelector('#cr-risk-filter')?.value || 'all';
      overlay.querySelectorAll('[data-aa-row]').forEach(row => {
        const name = row.getAttribute('data-name') || '';
        const st = row.getAttribute('data-status') || '';
        const ok = (!q || name.includes(q)) && (f === 'all' || st === f);
        row.style.display = ok ? '' : 'none';
      });
    };
    overlay.querySelector('#whd-aa-search')?.addEventListener('input', applyFilter);
    overlay.querySelector('#cr-risk-filter')?.addEventListener('change', applyFilter);
    overlay.querySelectorAll('[data-toggle-row]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-toggle-row');
      const row = id ? overlay.querySelector('#' + CSS.escape(id)) : null;
      if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
    }));
    overlay.querySelectorAll('.whd-review-btn').forEach(btn => btn.addEventListener('click', () => openGapReviewModal(btn)));
    overlay.querySelector('#whd-open-page')?.addEventListener('click', openWHDFullPage);
    overlay.querySelector('#whd-refresh-all')?.addEventListener('click', refreshWHDDataKeepOpen);
    overlay.querySelector('#whd-download-csv')?.addEventListener('click', downloadWHDCSV);
    overlay.querySelector('#whd-popup-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#whd-popup-backdrop')?.addEventListener('click', () => overlay.remove());

    overlay.querySelector('#whd-update-target')?.addEventListener('click', () => {
      const input = overlay.querySelector('#whd-target-input');
      setTargetValue(input?.value || '0');
      const currentTarget = getTargetValue();
      const line = overlay.querySelector('#whd-target-sentence');
      if (line) line.textContent = whdPprPlanSentence(actualUnits, planUnits, currentTarget);
      const card = input?.closest('.whd-target-card');
      const em = card?.querySelector('em');
      if (em) em.textContent = currentTarget ? 'Manual updated target' : 'Using PPR planned units if available';
    });
    overlay.querySelector('#whd-target-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') overlay.querySelector('#whd-update-target')?.click();
    });

    loadAsinTitlesInPopup(overlay);
    whdPreloadVisibleItems(overlay);
  };

  openWHDFullPage = function openWHDFullPageBeautifulOpsV1() {
    const ppr = _pprWHDMetrics || {};
    const actualUnits = Number(ppr.actualUnits || 0) || whdPopupData.reduce((sum,d)=>sum + Number(d?.perf?.units || getAssociateProcessed(d) || 0),0);
    const planUnits = Number(ppr.planUnits || 0);
    const actualRate = Number(getPPRActualWHDTPH() || ppr.actualTPH || 0);
    const planRate = Number(getPPRPlanWHDTPH() || ppr.planTPH || WHD.UPH_TARGET || 9.61);
    const manualTarget = getTargetValue ? getTargetValue() : 0;
    const target = Number(manualTarget || planUnits || 0);
    const allGaps = whdPopupData.flatMap(whdGapsForAA);
    const bigGaps = allGaps.filter(g => Number(g.mins||0) >= WHD_BIG_GAP_MIN);
    const quarterRows = whdQuarterWebData();
    const dateStr = new URLSearchParams(location.search).get('startDateIntraday') || new Date().toLocaleDateString();
    const sorted = whdPopupData.slice().sort((a,b)=>getAssociateAvgTPH(b)-getAssociateAvgTPH(a));
    const hc = sorted.length;
    const totalShiftHours = quarterRows.reduce((sum,r)=>sum + Math.max(0, Number(r.end||0)-Number(r.start||0))/60,0) || 9;
    const effectiveTph = actualRate || (sorted.reduce((sum,d)=>sum+Number(getAssociateAvgTPH(d)||0),0) / Math.max(1,hc));
    const projectedFullShift = Math.round(effectiveTph * hc * totalShiftHours);
    const requiredHc = target && effectiveTph ? Math.ceil(target / Math.max(1, effectiveTph * totalShiftHours)) : 0;
    const hcGap = Math.max(0, requiredHc - hc);
    const lowPerformers = sorted.filter(d => Number(getAssociateAvgTPH(d)||0) > 0 && Number(getAssociateAvgTPH(d)||0) < planRate).length;

    const smartSummary = (() => {
      const gapText = bigGaps.length ? `${bigGaps.length} big gap${bigGaps.length===1?'':'s'} over ${WHD_BIG_GAP_MIN}m need review.` : `No big gaps over ${WHD_BIG_GAP_MIN}m detected.`;
      if (!target || !effectiveTph || !hc) return `Target view is still loading. Current loaded HC is ${hc}, current WHD TPH is ${effectiveTph ? effectiveTph.toFixed(1) : '—'}. ${gapText}`;
      if (projectedFullShift >= target) {
        return `We are on line for the target with current HC and current TPH. Loaded HC ${hc} × current TPH ${effectiveTph.toFixed(1)} across ${totalShiftHours.toFixed(1)} working hours projects about ${projectedFullShift} items against target ${target}. Keep monitoring gaps, item mix, and low performers. ${gapText}`;
      }
      const shortage = target - projectedFullShift;
      if (lowPerformers > 0) {
        return `We are not on line for the target yet. Current HC ${hc} × current TPH ${effectiveTph.toFixed(1)} projects about ${projectedFullShift}/${target}, short by about ${shortage} items. First check individual TPH performance (${lowPerformers} AA${lowPerformers===1?'':'s'} below expected ${planRate.toFixed(1)}), scan gaps, and category mix. If performance cannot bridge the gap, consider adding ${Math.min(2, Math.max(1,hcGap || 1))} HC based on workload need.`;
      }
      return `We are not on line for the target yet. Current HC ${hc} × current TPH ${effectiveTph.toFixed(1)} projects about ${projectedFullShift}/${target}, short by about ${shortage} items. Performance is close, so review work allocation and item mix first. If the gap remains, add ${Math.min(2, Math.max(1,hcGap || 1))} HC as needed.`;
    })();

    const quarterHtml = quarterRows.map(r => {
      const pct = r.target ? Math.min(140, Math.round(Number(r.actual||0) / Math.max(1, Number(r.target||0)) * 100)) : 0;
      const cls = r.target && Number(r.actual||0) >= Number(r.target||0) ? 'hit' : (r.target ? 'miss' : 'neutral');
      return `<div class="qcard ${cls}"><div class="qtop"><b>${esc(r.label)}</b><span>${esc(absToHHMM(r.start))}–${esc(absToHHMM(r.end))}</span></div><div class="qnums"><strong>${Number(r.actual||0).toLocaleString()}</strong><em>/ ${Number(r.target||0).toLocaleString()}</em></div><div class="bar"><i style="width:${pct}%"></i></div><small>Gap ${Number(r.gapMins||0)}m • Count ${Number(r.gapCount||0)}</small></div>`;
    }).join('');

    const aaRows = sorted.map((d, idx) => {
      const tph = getAssociateAvgTPH(d);
      const units = getAssociateProcessed(d);
      const gaps = whdGapsForAA(d);
      const biggest = gaps[0] || null;
      const recentItems = whdAllScansSorted(d).slice().reverse();
      const status = gaps.some(g=>Number(g.mins||0)>=WHD_BIG_GAP_MIN) ? 'review' : 'stable';
      const gapId = `web_gap_${idx}`;
      const itemId = `web_items_${idx}`;
      const beforeAsin = biggest ? (biggest.toAsin || biggest.bridgeAsin || biggest.asinAfter || '') : '';
      const gapDisplay = biggest ? `<b class="${Number(biggest.mins)>=WHD_BIG_GAP_MIN?'bad':''}">${esc(biggest.mins)}m</b><small>${esc(biggest.timeBefore||'—')} → ${esc(biggest.timeAfter||'—')}${biggest.q ? ' • '+esc(biggest.q) : ''}</small>` : `<b class="good">0m</b><small>No gap</small>`;
      const sizes = getSizeCounts(d) || {};
      const beforeCell = beforeAsin ? `${whdItemCell(beforeAsin)}${whdCatPill(beforeAsin)}` : `<span class="muted">No gap item</span>`;
      const gapRows = gaps.map(g => {
        const asin = g.toAsin || g.bridgeAsin || g.asinAfter || '';
        return `<tr class="${Number(g.mins||0)>=WHD_BIG_GAP_MIN?'biggap':''}"><td><b>${esc(g.mins)}m</b><small>${esc(g.timeBefore||'—')} → ${esc(g.timeAfter||'—')} ${g.q?'• '+esc(g.q):''}</small></td><td>${asin?whdItemCell(asin):'—'}${asin?whdCatPill(asin):''}</td><td><a class="review" href="${esc(d.detailUrl||'#')}" target="_blank">Review</a></td></tr>`;
      }).join('') || `<tr><td colspan="3" class="muted">No ${WHD.GAP_MIN}+ min gaps.</td></tr>`;
      const itemRows = recentItems.map((s,n)=>`<tr><td>${esc(absToHHMM(s.time))}</td><td>${n+1}</td><td>${whdItemCell(s.asin)}</td><td>${whdCatPill(s.asin)}</td><td>${esc(normSize(s.size||''))}</td><td>${esc(s.qty||1)}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">No items loaded.</td></tr>`;
      return `<tr class="aa ${status}" data-aa-row data-status="${status}" data-name="${esc(String(d.name||'').toLowerCase())}"><td><a href="${esc(d.detailUrl||'#')}" target="_blank" class="aaName">${esc(d.name||'AA')}</a></td><td><b>${tph? tph.toFixed(1):'—'}</b><small>Expected ${planRate.toFixed(2)}</small></td><td>${gapDisplay}</td><td class="before">${beforeCell}</td><td class="center"><b>${units}</b><small>processed</small><small class="sizePill">S ${Number(sizes.small||0)} &nbsp; M ${Number(sizes.medium||0)} &nbsp; L ${Number(sizes.large||0)}</small><button data-toggle-row="${itemId}">Items</button></td><td class="center"><button data-toggle-row="${gapId}">${gaps.length}</button><small>click details</small></td></tr><tr id="${gapId}" class="detail" style="display:none"><td colspan="6"><div class="box"><h3>${esc(d.name||'AA')} - Gap Details</h3><table><thead><tr><th>Gap</th><th>Gap item</th><th>Action</th></tr></thead><tbody>${gapRows}</tbody></table></div></td></tr><tr id="${itemId}" class="detail" style="display:none"><td colspan="6"><div class="box"><h3>${esc(d.name||'AA')} - Processed Items</h3><table><thead><tr><th>Time</th><th>#</th><th>ASIN / Title</th><th>Category</th><th>Size</th><th>Qty</th></tr></thead><tbody>${itemRows}</tbody></table></div></td></tr>`;
    }).join('') || `<tr><td colspan="6" class="muted">No WHD associates loaded.</td></tr>`;

    const categoryHtml = whdCategorySummaryHtml();
    const sizeHtml = whdSizeBarHtml();

    const aaCards = sorted.map((d, idx) => {
      const tph = getAssociateAvgTPH(d);
      const units = getAssociateProcessed(d);
      const gaps = whdGapsForAA(d);
      const biggest = gaps[0] || null;
      const recentItems = whdAllScansSorted(d).slice().reverse();
      const status = gaps.some(g=>Number(g.mins||0)>=WHD_BIG_GAP_MIN) ? 'review' : 'stable';
      const gapId = `web_card_gap_${idx}`;
      const itemId = `web_card_items_${idx}`;
      const beforeAsin = biggest ? (biggest.toAsin || biggest.bridgeAsin || biggest.asinAfter || '') : '';
      const sizes = getSizeCounts(d) || {};
      const gapDisplay = biggest ? `<b class="${Number(biggest.mins)>=WHD_BIG_GAP_MIN?'bad':''}">${esc(biggest.mins)}m</b><small>${esc(biggest.timeBefore||'—')} → ${esc(biggest.timeAfter||'—')}${biggest.q ? ' • '+esc(biggest.q) : ''}</small>` : `<b class="good">0m</b><small>No gap</small>`;
      const beforeCell = beforeAsin ? `${whdItemCell(beforeAsin)}${whdCatPill(beforeAsin)}` : `<span class="muted">No gap item</span>`;
      const gapRows = gaps.map(g => {
        const asin = g.toAsin || g.bridgeAsin || g.asinAfter || '';
        return `<tr class="${Number(g.mins||0)>=WHD_BIG_GAP_MIN?'biggap':''}"><td><b>${esc(g.mins)}m</b><small>${esc(g.timeBefore||'—')} → ${esc(g.timeAfter||'—')} ${g.q?'• '+esc(g.q):''}</small></td><td>${asin?whdItemCell(asin):'—'}${asin?whdCatPill(asin):''}</td><td><a class="review" href="${esc(d.detailUrl||'#')}" target="_blank">Review</a></td></tr>`;
      }).join('') || `<tr><td colspan="3" class="muted">No ${WHD.GAP_MIN}+ min gaps.</td></tr>`;
      const itemRows = recentItems.map((s,n)=>`<tr><td>${esc(absToHHMM(s.time))}</td><td>${n+1}</td><td>${whdItemCell(s.asin)}</td><td>${whdCatPill(s.asin)}</td><td>${esc(normSize(s.size||''))}</td><td>${esc(s.qty||1)}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">No items loaded.</td></tr>`;
      return `<div class="aaCard ${status}" data-aa-row data-status="${status}" data-name="${esc(String(d.name||'').toLowerCase())}">
        <div class="aaCell associate"><label>Associate</label><a href="${esc(d.detailUrl||'#')}" target="_blank" class="aaName">${esc(d.name||'AA')}</a></div>
        <div class="aaCell tph"><label>TPH</label><b>${tph? tph.toFixed(1):'—'}</b><small>Expected ${planRate.toFixed(2)}</small></div>
        <div class="aaCell gap"><label>Gap</label>${gapDisplay}</div>
        <div class="aaCell before"><label>Before processing</label>${beforeCell}</div>
        <div class="aaCell items center"><label>Total Items</label><b>${units}</b><small>processed</small><small class="sizePill">S ${Number(sizes.small||0)} &nbsp; M ${Number(sizes.medium||0)} &nbsp; L ${Number(sizes.large||0)}</small><button data-toggle-row="${itemId}">Items</button></div>
        <div class="aaCell gaps center"><label>Total Gaps</label><button data-toggle-row="${gapId}">${gaps.length}</button><small>click details</small></div>
        <div id="${gapId}" class="cardDetail" style="display:none"><div class="box"><h3>${esc(d.name||'AA')} - Gap Details</h3><table><thead><tr><th>Gap</th><th>Gap item</th><th>Action</th></tr></thead><tbody>${gapRows}</tbody></table></div></div>
        <div id="${itemId}" class="cardDetail" style="display:none"><div class="box"><h3>${esc(d.name||'AA')} - Processed Items</h3><table><thead><tr><th>Time</th><th>#</th><th>ASIN / Title</th><th>Category</th><th>Size</th><th>Qty</th></tr></thead><tbody>${itemRows}</tbody></table></div></div>
      </div>`;
    }).join('') || `<div class="muted">No WHD associates loaded.</div>`;
    const pprLine = esc(whdPprPlanSentence(actualUnits, planUnits, manualTarget));
    const warningHtml = bigGaps.length ? bigGaps.slice(0,10).map(g => `<div class="warn"><b>${esc(g.aa)}</b><strong>${esc(g.mins)}m</strong><span>${esc(g.timeBefore||'—')} → ${esc(g.timeAfter||'—')}</span><em>${g.toAsin ? whdItemCell(g.toAsin) : ''}</em></div>`).join('') : `<div class="ok">No large scan gaps over ${WHD_BIG_GAP_MIN} minutes detected.</div>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Popup blocked. Allow popups for this page to open the full AR Performance Dashboard.'); return; }
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>AR Pulse Dashboard V1</title><style>
      :root{--bg:#eef4ff;--card:#fff;--soft:#f8fafc;--text:#0f172a;--muted:#64748b;--line:#dbe4f0;--blue:#2563eb;--red:#dc2626;--green:#16a34a;--amber:#d97706;--shadow:0 10px 26px rgba(15,23,42,.08)}*{box-sizing:border-box}html,body{width:100%;max-width:100%;overflow-x:hidden}body{margin:0;padding:10px;background:linear-gradient(180deg,#eef4ff,var(--bg));color:var(--text);font-family:Inter,Segoe UI,Arial,sans-serif}.shell{width:100%;max-width:100%;margin:0 auto}.hero{background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:16px;padding:10px;box-shadow:var(--shadow)}.top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap}h1{margin:0;font-size:22px;letter-spacing:-.04em}.sub{color:var(--muted);font-weight:800;font-size:12px;margin-top:2px}.actions{display:flex;gap:7px;flex-wrap:wrap}.actions button,.aa button{border:0;border-radius:10px;padding:8px 11px;background:var(--blue);color:white;font-weight:950;cursor:pointer}.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:8px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px;min-width:0}.kpi span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:950}.kpi b{display:block;font-size:21px;margin-top:2px;white-space:nowrap}.kpi em{font-style:normal;color:var(--muted);font-size:11px;font-weight:850}.quarters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:8px}.qcard{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:7px;min-width:0}.qcard.hit{border-color:#86efac;background:#f0fdf4}.qcard.miss{border-color:#facc15;background:#fffbeb}.qtop{display:flex;justify-content:space-between;gap:6px}.qcard b{font-size:14px}.qcard span,.qcard small{color:var(--muted);font-size:11px;font-weight:900}.qnums{display:flex;align-items:baseline;gap:5px;margin-top:1px}.qcard strong{font-size:19px}.qcard em{font-style:normal;color:var(--muted);font-weight:900;font-size:11px}.bar{height:5px;background:#e2e8f0;border-radius:99px;margin:4px 0;overflow:hidden}.bar i{display:block;height:100%;background:var(--blue);border-radius:99px}.note{background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:12px;padding:8px 10px;font-weight:950;font-size:13px}.targetNote{margin-top:8px}.main{display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px}.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:9px;box-shadow:0 8px 22px rgba(15,23,42,.05);min-width:0}.panelHead{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:5px;flex-wrap:wrap}.panel h2{margin:0;font-size:17px}.tools{display:flex;gap:7px;flex-wrap:wrap}.tools input,.tools select{border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-weight:850;background:var(--card);color:var(--text)}.tableWrap{width:100%;overflow-x:hidden}.aaGrid{display:grid;gap:8px;width:100%;max-width:100%;overflow:hidden}.aaGridHead{display:grid;grid-template-columns:minmax(130px,1.05fr) minmax(70px,.55fr) minmax(90px,.7fr) minmax(260px,2.2fr) minmax(110px,.8fr) minmax(100px,.7fr);gap:10px;align-items:center;background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:8px 10px;color:var(--muted);text-transform:uppercase;font-size:10px;font-weight:950}.aaCard{display:grid;grid-template-columns:minmax(130px,1.05fr) minmax(70px,.55fr) minmax(90px,.7fr) minmax(260px,2.2fr) minmax(110px,.8fr) minmax(100px,.7fr);gap:10px;align-items:start;border:1px solid var(--line);border-radius:14px;padding:10px;background:var(--card);max-width:100%;overflow:hidden}.aaCard.review{background:#fff7ed}.aaCell{min-width:0;overflow-wrap:anywhere}.aaCell label{display:none;color:var(--muted);font-size:10px;text-transform:uppercase;font-weight:950;margin-bottom:3px}.aaCell b{font-size:15px}.aaCell.gap b.bad{color:var(--red)}.cardDetail{grid-column:1/-1;min-width:0}.cardDetail table{table-layout:auto}.cardDetail .whd-title{max-width:520px!important}@media(max-width:900px){.aaGridHead{display:none}.aaCard{grid-template-columns:1fr 1fr}.aaCell label{display:block}.aaCell.before,.cardDetail{grid-column:1/-1}.kpis{grid-template-columns:repeat(2,1fr)}}table{width:100%;max-width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}th,td{border-bottom:1px solid var(--line);padding:7px 6px;text-align:left;vertical-align:top;word-break:break-word}th{color:var(--muted);text-transform:uppercase;font-size:10px;background:var(--soft)}th:nth-child(1){width:15%}th:nth-child(2){width:9%}th:nth-child(3){width:11%}th:nth-child(4){width:38%}th:nth-child(5){width:14%}th:nth-child(6){width:13%}.aa.review{background:#fff7ed}.aaName{font-size:14px;font-weight:950}.aa b.bad{color:var(--red)}.good{color:var(--green)}small{display:block;color:var(--muted);font-size:10px;font-weight:800;margin-top:2px}.center{text-align:center}.headMini{display:inline-block;margin-left:5px;color:var(--blue);font-size:10px!important;text-transform:none}.sizePill{background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:3px 6px;color:var(--text);font-weight:950;white-space:nowrap}.detail .box{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:8px}.box h3{margin:0 0 8px;font-size:14px}.before{min-width:0}.whd-asin{display:inline-block;font-family:Consolas,monospace;font-size:11px;font-weight:950;background:#e0f2fe;color:#075985!important;padding:2px 7px;border-radius:999px;text-decoration:none;margin-bottom:3px}.whd-title{display:block;font-size:11px!important;font-weight:800;color:#334155;text-decoration:none;max-width:100%!important;white-space:normal!important;line-height:1.25;overflow-wrap:anywhere}.whd-cat-pill{display:inline-block;font-size:11px!important;font-weight:950;background:#eef2ff;color:#1e40af;border-radius:999px;padding:3px 7px;margin-top:3px}.warns{display:grid;gap:6px}.warn{display:grid;grid-template-columns:150px 55px 115px minmax(0,1fr);gap:8px;align-items:start;background:#fff7ed;border:1px solid #fdba74;border-radius:12px;padding:8px;font-size:12px}.warn strong{color:var(--red);font-size:15px}.ok,.muted{color:var(--muted);font-weight:900;padding:8px}.bottom{display:grid;grid-template-columns:1.15fr .85fr;gap:8px}.mixRow{display:grid;grid-template-columns:.9fr 1.1fr;gap:8px}.whd-category-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:7px}.whd-category-grid div{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:9px}.whd-category-grid b{font-size:18px;margin-right:5px}.whd-size-bars{display:grid;gap:8px}.whd-size-row{display:grid;grid-template-columns:70px 1fr 48px;gap:8px;align-items:center}.whd-size-row span,.whd-size-row b{font-size:13px;font-weight:950}.whd-size-row div{height:14px;background:var(--soft);border-radius:99px;overflow:hidden}.whd-size-row i{display:block;height:100%;border-radius:99px}.whd-size-row i.small{background:#0ea5e9}.whd-size-row i.medium{background:#f59e0b}.whd-size-row i.large{background:#ef4444}.review{display:inline-block;border:0;border-radius:9px;padding:7px 10px;background:var(--blue);color:white!important;font-weight:950;text-decoration:none}.whd-cat-viz{display:grid;grid-template-columns:145px 1fr;gap:10px;align-items:center;margin:2px 0 8px}.whd-cat-pie{width:130px!important;height:130px!important;border-radius:50%;display:grid;place-items:center;box-shadow:inset 0 0 0 12px rgba(255,255,255,.45),0 10px 25px rgba(15,23,42,.10)}.whd-cat-pie strong{font-size:24px}.whd-cat-pie span{font-weight:950;color:var(--muted);font-size:10px}.whd-cat-legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:6px}.whd-cat-legend div{display:grid;grid-template-columns:12px 1fr 35px;gap:6px;align-items:center;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:6px}.whd-cat-legend i{width:12px;height:12px;border-radius:50%}.whd-cat-legend b{font-size:11px}.whd-cat-legend span{text-align:right;font-weight:950;font-size:11px}@media(max-width:1050px){.kpis{grid-template-columns:repeat(2,1fr)}.quarters,.bottom,.mixRow{grid-template-columns:1fr}table{font-size:11px}th:nth-child(4){width:32%}.warn{grid-template-columns:1fr}}@media print{body{background:#fff}.actions{display:none}.hero,.panel{box-shadow:none}}

      .webTableWrap{width:100%;max-width:100%;overflow:hidden}.web-aa-table{width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse}.web-aa-table th,.web-aa-table td{padding:8px 7px;border-bottom:1px solid var(--line);vertical-align:top;overflow:hidden}.web-aa-table th{font-size:10px;color:var(--muted);text-transform:uppercase;background:var(--soft);font-weight:950}.web-aa-table .aaName{display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.web-aa-table .before{max-width:100%;overflow:hidden}.web-aa-table .whd-title{display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden!important;max-width:100%!important;line-height:1.22!important;font-size:11px!important}.web-aa-table .whd-cat-pill{max-width:100%;white-space:nowrap!important;overflow:hidden;text-overflow:ellipsis}.web-aa-table .sizePill{display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.web-aa-table button{border:0;border-radius:10px;padding:7px 10px;background:var(--blue);color:white;font-weight:950;cursor:pointer}@media(max-width:1100px){.web-aa-table{font-size:11px}.web-aa-table th,.web-aa-table td{padding:6px 5px}.web-aa-table .whd-title{font-size:10px!important}.web-aa-table .aaName{font-size:12px}}
      .web-card-summary{display:flex;justify-content:space-between;gap:10px;align-items:center;background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin-bottom:10px;color:var(--muted);font-size:12px;font-weight:950;flex-wrap:wrap}.web-card-summary b{background:var(--blue);color:white;border-radius:999px;padding:3px 9px;margin-left:5px}.aaCardsWeb{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:10px;width:100%;max-width:100%;overflow:hidden}.aaCardsWeb .aaCard{display:grid!important;grid-template-columns:1fr 86px!important;gap:10px!important;align-items:start!important;border:1px solid var(--line)!important;border-radius:16px!important;padding:12px!important;background:var(--card)!important;box-shadow:0 8px 20px rgba(15,23,42,.06);min-width:0!important;overflow:hidden!important}.aaCardsWeb .aaCard.review{background:#fff7ed!important}.aaCardsWeb .aaCell{min-width:0!important;overflow:hidden!important}.aaCardsWeb .aaCell label{display:block!important;font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:950;margin-bottom:3px}.aaCardsWeb .associate{grid-column:1/2}.aaCardsWeb .tph{grid-column:2/3;text-align:right}.aaCardsWeb .gap{grid-column:1/2}.aaCardsWeb .before{grid-column:1/-1!important;background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:8px}.aaCardsWeb .items{grid-column:1/2;text-align:left!important}.aaCardsWeb .gaps{grid-column:2/3;text-align:center!important}.aaCardsWeb .cardDetail{grid-column:1/-1!important;max-width:100%;overflow:auto}.aaCardsWeb .whd-title{display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden!important;white-space:normal!important;line-height:1.25!important;max-width:100%!important}.aaCardsWeb .whd-cat-pill{display:inline-block;max-width:100%;white-space:nowrap!important;overflow:hidden;text-overflow:ellipsis}.aaCardsWeb button{border:0;border-radius:10px;padding:7px 11px;background:var(--blue);color:white;font-weight:950;cursor:pointer;margin-top:5px}.aaCardsWeb .aaName{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:15px;font-weight:950}.aaCardsWeb table{table-layout:fixed;width:100%;font-size:11px}.aaCardsWeb td,.aaCardsWeb th{word-break:break-word}.aaCardsWeb .box{max-height:360px;overflow:auto}@media(max-width:800px){.aaCardsWeb{grid-template-columns:1fr}.aaCardsWeb .aaCard{grid-template-columns:1fr!important}.aaCardsWeb .tph,.aaCardsWeb .gaps{grid-column:1/-1;text-align:left!important}.kpis{grid-template-columns:1fr 1fr}.quarters{grid-template-columns:1fr 1fr}.whd-cat-viz{grid-template-columns:1fr}.whd-cat-pie{margin:auto}}

        @media(max-width:800px){body{padding-left:14px!important;padding-right:14px!important}}

    </style></head><body><div class="shell"><section class="hero"><div class="top"><div><h1>AR Performance Dashboard</h1><div class="sub">V1 • ${esc(dateStr)} • full-page view for AA performance, items, category mix, and scan gaps</div></div><div class="actions"><button id="webThemeToggle" type="button">🌙 Dark</button><button onclick="window.print()">Print / Save PDF</button><button id="topCsv">CSV</button></div></div><div class="kpis"><div class="kpi"><span>Total Items</span><b>${actualUnits ? actualUnits.toLocaleString() : '—'}</b><em>PPR plan ${planUnits ? planUnits.toLocaleString() : '—'}</em></div><div class="kpi"><span>PPR Actual TPH</span><b>${actualRate ? actualRate.toFixed(2) : '—'}</b><em>Warehouse Deals Total</em></div><div class="kpi"><span>Plan TPH</span><b>${planRate ? planRate.toFixed(2) : '9.61'}</b><em>Expected pace</em></div><div class="kpi"><span>Daily Target</span><b>${target || '—'}</b><em>used for Q1-Q4</em></div><div class="kpi"><span>Current HC</span><b>${hc}</b><em>projected ${projectedFullShift || '—'} items</em></div></div><div class="quarters">${quarterHtml}</div><div class="note targetNote">${esc(smartSummary)}</div></section><main class="main"><section class="panel"><div class="panelHead"><h2>AA Items & Gaps</h2><div class="tools"><input id="search" placeholder="Search AA"><select id="filter"><option value="all">All</option><option value="review">Big gaps only</option><option value="stable">Stable only</option></select></div></div><div class="web-card-summary"><span>Total Gaps <b>${allGaps.length}</b></span><span>Click any AA card for item and gap details</span></div><div class="aaCardsWeb">${aaCards}</div></section><section class="bottom"><div class="panel"><h2>Shift Summary</h2><div class="note">${esc(smartSummary)}</div><div class="warns">${warningHtml}</div></div><div class="panel"><h2>Size Mix</h2>${sizeHtml}</div></section><section class="panel"><h2>Category Mix</h2>${whdCategoryPieHtml()}</section></main></div><script>
      document.querySelectorAll('[data-toggle-row]').forEach(btn=>btn.addEventListener('click',()=>{const id=btn.getAttribute('data-toggle-row');const row=document.getElementById(id); if(row) row.style.display=row.style.display==='none'?'':'none';}));
      const apply=()=>{const q=(document.getElementById('search').value||'').toLowerCase().trim();const f=document.getElementById('filter').value;document.querySelectorAll('[data-aa-row]').forEach(r=>{const ok=(!q||(r.getAttribute('data-name')||'').includes(q))&&(f==='all'||(r.getAttribute('data-status')||'')===f);r.style.display=ok?'':'none';});};
    </script></body></html>`);
    w.document.close();
  };
  openWHDFullPage = function () {
    const dateStr = (new URLSearchParams(location.search).get('startDateIntraday') || '').replace(/\//g,'-') || new Date().toISOString().slice(0,10);
    const sorted = whdPopupData.slice().sort((a,b)=>Number(getAssociateUnits(b)||0)-Number(getAssociateUnits(a)||0));
    const ppr = _pprWHDMetrics || {};
    const manualTarget = (typeof getTargetValue === 'function') ? Number(getTargetValue() || 0) : Number(localStorage.getItem('whd_daily_target') || 0);
    const planUnits = Number(ppr.planUnits || 0);
    const target = manualTarget || planUnits || 500;
    const actualUnits = Number(ppr.actualUnits || 0) || sorted.reduce((s,d)=>s+Number(getAssociateUnits(d)||0),0);
    const planRate = Number(ppr.planTPH || WHD.UPH_TARGET || 9.61);
    const actualRate = Number(ppr.actualTPH || 0);
    const hc = sorted.filter(d => Number(getAssociateUnits(d)||0) > 0 || whdAllScansSorted(d).length).length || sorted.length || 0;
    const avgAaTph = hc ? sorted.reduce((s,d)=>s+Number(getAssociateAvgTPH(d)||0),0) / hc : 0;
    const teamRate = actualRate || (avgAaTph * Math.max(1,hc));
    const shift = SHIFTS[activeShift] || SHIFTS.night;
    const sMin = toMin(shift.shiftStart), eMin = toMin(shift.shiftEnd);
    const shiftMins = (eMin <= sMin ? eMin + 1440 : eMin) - sMin;
    const breakMins = (shift.breaks || []).reduce((sum,b)=>{
      const bs=toMin(b.start), be=toMin(b.end); return sum + ((be <= bs ? be + 1440 : be) - bs);
    },0);
    const totalShiftHours = Math.max(1, (shiftMins - breakMins) / 60);
    const projected = Math.round(teamRate * totalShiftHours);
    const requiredHc = avgAaTph ? Math.ceil(target / Math.max(1, avgAaTph * totalShiftHours)) : 0;
    const hcNeeded = Math.max(0, requiredHc - hc);
    const allGaps = sorted.flatMap(d => whdGapsForAA(d).map(g => Object.assign({aaObj:d}, g))).sort((a,b)=>Number(b.mins||0)-Number(a.mins||0));
    const bigGaps = allGaps.filter(g => Number(g.mins||0) >= WHD_BIG_GAP_MIN);
    const lowPerformers = sorted.filter(d => Number(getAssociateAvgTPH(d)||0) > 0 && Number(getAssociateAvgTPH(d)||0) < planRate).length;

    const isOnLine = target && projected >= target;
    const mix = getItemMixCounts ? getItemMixCounts() : {};
    const techMix = Number((mix.tech||0) + (mix.gaming||0) + (mix.appliances||0));
    const largeMix = sorted.reduce((sum,d)=>sum + Number((getSizeCounts(d)||{}).large||0),0);
    const itemBridge = (techMix || largeMix)
      ? `Performance may be impacted by item nature: ${techMix ? techMix.toLocaleString() + ' tech/electric/appliance items' : 'tech/electric items'}${largeMix ? ' and ' + largeMix.toLocaleString() + ' large/bulky items' : ''}. Longer testing/handling time is expected for those item types.`
      : `Performance may be impacted by tech/electric testing or large/bulky item handling when those items are in the mix.`;
    const smartSummary = `${itemBridge} Team rate is ${teamRate ? teamRate.toFixed(1) : '—'} TPH${target ? ', target ' + target.toLocaleString() + ' items' : ''}. Total gap count ${allGaps.length}; big gaps ${bigGaps.length}.`;

    function qAbs(v) { const m = toMin(v); return activeShift === 'night' && m < 720 ? m + 1440 : m; }
    const sAbs = qAbs(shift.shiftStart), eAbs = qAbs(shift.shiftEnd);
    const brks = shift.breaks.map(b=>({start:qAbs(b.start), end:qAbs(b.end)}));
    const quarters = [
      {label:'Q1', start:sAbs, end:brks[0]?.start || sAbs},
      {label:'Q2', start:brks[0]?.end || sAbs, end:brks[1]?.start || sAbs},
      {label:'Q3', start:brks[1]?.end || sAbs, end:brks[2]?.start || sAbs},
      {label:'Q4', start:brks[2]?.end || sAbs, end:eAbs},
    ];
    const totalQ = quarters.reduce((s,q)=>s+Math.max(0,q.end-q.start),0) || 1;
    const quarterHtml = quarters.map(q => {
      let actual=0, gapMins=0, gapCount=0;
      sorted.forEach(d => {
        whdAllScansSorted(d).forEach(sc => { if (Number(sc.time)>=q.start && Number(sc.time)<q.end) actual += Number(sc.qty||1)||1; });
        whdGapsForAA(d).forEach(g => { if (Number(g.start)>=q.start && Number(g.start)<q.end) { gapMins += Number(g.mins||0); gapCount++; } });
      });
      const qTarget = target ? Math.round(target * ((q.end-q.start)/totalQ)) : 0;
      const pct = qTarget ? Math.min(100, Math.round(actual/qTarget*100)) : 0;
      const cls = qTarget && actual >= qTarget ? 'hit' : 'miss';
      return `<div class="q ${cls}"><div><b>${esc(q.label)}</b><span>${esc(absToHHMM(q.start))}–${esc(absToHHMM(q.end))}</span></div><strong>${actual}</strong><em>/ ${qTarget || '—'} target</em><i><u style="width:${pct}%"></u></i><small>${gapCount} gaps • ${gapMins}m</small></div>`;
    }).join('');

    function personHtml(d, size=48) {
      const href = esc(d.detailUrl || '#');
      return `<a class="person" href="${href}" target="_blank">${aaAvatarHtml(d,size)}<span>${esc(d.name||'AA')}<small>${getAAEmployeeId(d) ? 'ID '+esc(getAAEmployeeId(d)) : 'Open FCLM profile'}</small></span></a>`;
    }
    function itemLine(asin) {
      if (!asin) return `<span class="muted">No ASIN loaded</span>`;
      const title = whdItemTitle(asin);
      return `<div class="itemLine"><div class="itemText"><a class="asin" href="${esc(fcResearchUrl(asin))}" target="_blank">${esc(asin)}</a><a class="title" href="https://www.amazon.com.au/dp/${esc(asin)}" target="_blank" data-asin-title="${esc(asin)}">${esc(title)}</a></div>${whdCatPill(asin)}</div>`;
    }

    const warningHtml = bigGaps.slice(0,12).map(g => {
      const d = g.aaObj || {};
      const asin = (g.toAsin || g.bridgeAsin || g.asinAfter || g.fromAsin || g.asinBefore || '').toUpperCase();
      return `<div class="warnCard" data-aa-row data-status="review" data-name="${esc(String(d.name||'').toLowerCase())}">
        ${personHtml(d,42)}
        <div class="warnGap"><b>${esc(g.mins)}m</b><span>${esc(g.timeBefore||'—')} → ${esc(g.timeAfter||'—')} ${g.q ? '• '+esc(g.q) : ''}</span></div>
        <div class="warnItem">${itemLine(asin)}</div>
        <a class="reviewBtn" href="${esc(d.detailUrl||'#')}" target="_blank">Review</a>
      </div>`;
    }).join('') || `<div class="ok">No big gaps over ${WHD_BIG_GAP_MIN} minutes detected.</div>`;

    const aaCards = sorted.map((d, idx) => {
      const tph = Number(getAssociateAvgTPH(d)||0);
      const units = Number(getAssociateUnits(d)||0);
      const sizes = getSizeCounts(d) || {};
      const gaps = whdGapsForAA(d);
      const biggest = gaps[0] || null;
      const recentItems = whdAllScansSorted(d).slice().reverse();
      const beforeAsin = biggest ? (biggest.toAsin || biggest.bridgeAsin || biggest.asinAfter || '') : '';
      const status = gaps.some(g=>Number(g.mins||0)>=WHD_BIG_GAP_MIN) ? 'review' : 'stable';
      const itemId = `items_${idx}`;
      const gapId = `gaps_${idx}`;
      const itemRows = recentItems.map((s,n)=>`<tr><td>${esc(absToHHMM(s.time))}</td><td>${n+1}</td><td>${itemLine(s.asin)}</td><td>${esc(normSize(s.size||''))}</td><td>${esc(s.qty||1)}</td></tr>`).join('') || `<tr><td colspan="5">No items loaded.</td></tr>`;
      const gapRows = gaps.map(g => {
        const asin = (g.toAsin || g.bridgeAsin || g.asinAfter || '').toUpperCase();
        return `<tr><td><b>${esc(g.mins)}m</b><small>${esc(g.timeBefore||'—')} → ${esc(g.timeAfter||'—')} ${g.q ? '• '+esc(g.q) : ''}</small></td><td>${itemLine(asin)}</td><td><a class="reviewBtn small" href="${esc(d.detailUrl||'#')}" target="_blank">Review</a></td></tr>`;
      }).join('') || `<tr><td colspan="3">No ${WHD.GAP_MIN}+ min gaps.</td></tr>`;
      return `<article class="aaCard ${status}" data-aa-row data-status="${status}" data-name="${esc(String(d.name||'').toLowerCase())}">
        <div class="aaTop">${personHtml(d,54)}<div class="status ${status}">${status==='review'?'Review':'Stable'}</div></div>
        <div class="metrics"><div><span>TPH</span><b>${tph ? tph.toFixed(1) : '—'}</b><em>Plan ${planRate.toFixed(1)}</em></div><div><span>Total items</span><b>${units}</b><em>S ${Number(sizes.small||0)} • M ${Number(sizes.medium||0)} • L ${Number(sizes.large||0)}</em></div><div><span>Total gaps</span><b>${gaps.length}</b><em>${Number(d.totalGapMins||0)}m total</em></div></div>
        <div class="before"><span>Gap item</span>${beforeAsin ? itemLine(beforeAsin) : '<em>No gap item</em>'}</div>
        <div class="cardActions"><button data-toggle-row="${itemId}">Items</button><button data-toggle-row="${gapId}">Gaps</button><a class="reviewBtn" href="${esc(d.detailUrl||'#')}" target="_blank">FCLM</a></div>
        <div id="${itemId}" class="drop" style="display:none"><h3>Processed Items</h3><div class="tableBox"><table><thead><tr><th>Time</th><th>#</th><th>ASIN / Title / Category</th><th>Size</th><th>Qty</th></tr></thead><tbody>${itemRows}</tbody></table></div></div>
        <div id="${gapId}" class="drop" style="display:none"><h3>Gap Details</h3><div class="tableBox"><table><thead><tr><th>Gap</th><th>Item before processing</th><th>Action</th></tr></thead><tbody>${gapRows}</tbody></table></div></div>
      </article>`;
    }).join('');

    const w = window.open('', '_blank');
    if (!w) { alert('Popup blocked. Allow popups for FCLM to open the full dashboard.'); return; }
    w.document.write(`<!DOCTYPE html><html><head><title>AR Performance Dashboard</title><meta charset="UTF-8"><style>
      :root{--bg:#f4f7fb;--card:#ffffff;--soft:#f8fafc;--line:#e2e8f0;--text:#0f172a;--muted:#64748b;--blue:#2563eb;--green:#16a34a;--amber:#f59e0b;--red:#dc2626;--shadow:0 12px 30px rgba(15,23,42,.08)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif;overflow-x:hidden}.shell{width:calc(100% - 22px);max-width:1440px;margin:0 auto;padding:10px}.hero,.panel{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:12px;margin-bottom:10px}.top{display:flex;justify-content:space-between;gap:12px;align-items:center}.top h1{font-size:24px;margin:0;letter-spacing:-.03em}.sub{font-size:12px;color:var(--muted);font-weight:850;margin-top:3px}.actions{display:flex;gap:7px;flex-wrap:wrap}.actions button,.cardActions button,.reviewBtn{border:0;background:var(--blue);color:#fff!important;border-radius:10px;padding:8px 11px;font-weight:950;text-decoration:none;cursor:pointer}.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}.kpi,.q{background:var(--soft);border:1px solid var(--line);border-radius:14px;padding:9px;min-width:0}.kpi span,.q span,.metrics span,.before>span{display:block;font-size:10px;color:var(--muted);font-weight:950;text-transform:uppercase;letter-spacing:.06em}.kpi b{display:block;font-size:21px;margin-top:2px}.kpi em,.q em,.metrics em{display:block;font-style:normal;color:var(--muted);font-size:11px;font-weight:850}.quarters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px}.q div{display:flex;justify-content:space-between;gap:6px}.q strong{font-size:20px}.q i{display:block;height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin:6px 0}.q u{display:block;height:100%;background:var(--blue);border-radius:99px}.q.hit u{background:var(--green)}.q.miss u{background:var(--amber)}.note{background:#eff6ff;border:1px solid #93c5fd;color:#1e3a8a;border-radius:14px;padding:10px 12px;font-size:13px;font-weight:900;line-height:1.35;margin-top:8px}.panelHead{display:flex;justify-content:space-between;gap:10px;align-items:center}.panel h2{margin:0 0 8px;font-size:17px}.tools{display:flex;gap:7px;flex-wrap:wrap}.tools input,.tools select{border:1px solid var(--line);border-radius:10px;padding:9px 10px;font-weight:900;background:#fff}.aaGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:10px;width:100%;overflow:hidden}.aaCard{background:#fff;border:1px solid var(--line);border-left:5px solid var(--green);border-radius:18px;padding:11px;min-width:0;overflow:hidden}.aaCard.review{border-left-color:var(--red);background:#fff7ed}.aaTop,.person,.itemLine,.warnCard{display:flex;align-items:center;gap:9px;min-width:0}.aaTop{justify-content:space-between}.person{text-decoration:none;color:var(--text);font-weight:950;min-width:0}.person span{display:block;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.person small{display:block;color:var(--muted);font-size:10px;font-weight:850}.status{font-size:11px;font-weight:950;border-radius:999px;padding:5px 8px;background:#dcfce7;color:#166534}.status.review{background:#fee2e2;color:#991b1b}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:10px}.metrics div{background:var(--soft);border:1px solid var(--line);border-radius:13px;padding:8px;min-width:0}.metrics b{font-size:19px}.before{background:var(--soft);border:1px solid var(--line);border-radius:13px;padding:8px;margin-top:8px;min-width:0}.itemLine{justify-content:space-between;align-items:flex-start;width:100%;gap:10px;min-width:0}.itemText{min-width:0;display:grid;gap:4px;max-width:100%}.asin{font-family:Consolas,monospace;font-size:12px;font-weight:950;background:#e0f2fe;color:#075985!important;padding:2px 7px;border-radius:999px;text-decoration:none;width:max-content;max-width:100%}.title{font-size:12px;font-weight:850;color:#334155;text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.25;word-break:normal;overflow-wrap:anywhere}.whd-cat-pill{flex:0 0 auto;max-width:240px;white-space:normal;overflow:visible;text-overflow:clip;font-size:10px!important;padding:4px 7px!important;margin:0!important;line-height:1.15}.cardActions{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}.drop{margin-top:9px;background:#fff;border:1px solid var(--line);border-radius:13px;padding:8px}.drop h3{font-size:13px;margin:0 0 6px}.tableBox{overflow:auto;max-height:330px;border-radius:10px}table{width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed}th,td{border-bottom:1px solid var(--line);padding:7px;text-align:left;vertical-align:top;word-break:break-word}th{background:var(--soft);color:var(--muted);font-size:10px;text-transform:uppercase}.summaryGrid{display:grid;grid-template-columns:1.15fr .85fr;gap:10px}.shiftPanel{width:100%;overflow:visible}.mixPanel{overflow:visible}.mixHead{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px}.mixHead h2{margin:0}.mixHead span{color:var(--muted);font-weight:900;font-size:11px}.mixTwo{display:grid;grid-template-columns:minmax(280px,.72fr) minmax(460px,1.28fr);gap:12px;align-items:start}.mixBox{background:var(--soft);border:1px solid var(--line);border-radius:16px;padding:10px;min-width:0;overflow:visible}.mixBox h3{margin:0 0 8px;font-size:14px}.catBox .whd-cat-viz{grid-template-columns:150px minmax(0,1fr)!important;gap:12px!important}.catBox .whd-cat-pie{width:140px!important;height:140px!important}.catBox .whd-cat-legend{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))!important;gap:8px!important;max-height:none!important;overflow:visible!important}.catBox .whd-cat-legend div{min-width:0}.catBox .whd-cat-legend span{white-space:normal!important;line-height:1.15}.warns{display:grid;gap:8px}.warnCard{display:grid;grid-template-columns:minmax(230px,.9fr) 100px minmax(360px,1.7fr) 86px;align-items:center;background:#fff7ed;border:1px solid #fdba74;border-radius:14px;padding:10px;overflow:visible;gap:10px}.warnGap b{display:block;color:var(--red);font-size:18px}.warnGap span{font-size:11px;color:var(--muted);font-weight:900}.reviewBtn.small{font-size:10px;padding:6px 8px}.mix{display:grid;grid-template-columns:1fr;gap:10px}.whd-cat-viz{display:grid;grid-template-columns:145px 1fr;gap:10px;align-items:center}.whd-cat-pie{width:130px!important;height:130px!important;border-radius:50%;display:grid;place-items:center;box-shadow:inset 0 0 0 12px rgba(255,255,255,.45),0 10px 25px rgba(15,23,42,.10)}.whd-cat-legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px}.whd-cat-legend div{display:grid;grid-template-columns:12px 1fr 34px;gap:6px;align-items:center;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:6px}.whd-cat-legend i{width:12px;height:12px;border-radius:50%}.whd-size-bars{display:grid;gap:8px}.whd-size-row{display:grid;grid-template-columns:70px 1fr 45px;gap:8px;align-items:center}.whd-size-row div{height:14px;background:#e2e8f0;border-radius:999px;overflow:hidden}.whd-size-row i{display:block;height:100%;border-radius:999px}.whd-size-row i.small{background:#0ea5e9}.whd-size-row i.medium{background:#f59e0b}.whd-size-row i.large{background:#ef4444}.ok,.muted{color:var(--muted);font-weight:900;padding:8px}@media(max-width:1000px){.kpis{grid-template-columns:repeat(2,1fr)}.quarters{grid-template-columns:repeat(2,1fr)}.summaryGrid{grid-template-columns:1fr}.mixTwo{grid-template-columns:1fr}.warnCard{grid-template-columns:1fr}.aaGrid{grid-template-columns:1fr}.whd-cat-viz,.catBox .whd-cat-viz{grid-template-columns:1fr!important}.whd-cat-pie,.catBox .whd-cat-pie{margin:auto}}.shiftDetails summary{cursor:pointer;font-weight:950;background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:9px 10px;margin-bottom:8px}.shiftDetails[open] summary{margin-bottom:8px}.whd-category-grid,.whd-cat-legend{max-height:none!important;overflow:visible!important}.summaryGrid .whd-cat-viz{grid-template-columns:170px 1fr!important}.summaryGrid .whd-cat-legend{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(190px,1fr))!important;gap:8px!important}.summaryGrid .whd-cat-pie{width:150px!important;height:150px!important}body[data-theme="dark"]{--bg:#07111f;--card:#0f172a;--soft:#162235;--line:#334155;--text:#f8fafc;--muted:#cbd5e1;--shadow:0 12px 30px rgba(0,0,0,.35);background:#07111f!important;color:#f8fafc!important}body[data-theme="dark"] .hero,body[data-theme="dark"] .panel,body[data-theme="dark"] .aaCard,body[data-theme="dark"] .kpi,body[data-theme="dark"] .q,body[data-theme="dark"] .drop,body[data-theme="dark"] .mixBox,body[data-theme="dark"] .whd-cat-legend div{background:#0f172a!important;border-color:#334155!important;color:#f8fafc!important}body[data-theme="dark"] .note{background:#10233f!important;border-color:#1d4ed8!important;color:#dbeafe!important}body[data-theme="dark"] .title,body[data-theme="dark"] .person,body[data-theme="dark"] .whd-title{color:#f8fafc!important}body[data-theme="dark"] small,body[data-theme="dark"] em,body[data-theme="dark"] .sub,body[data-theme="dark"] .mixHead span{color:#cbd5e1!important}body[data-theme="dark"] input,body[data-theme="dark"] select{background:#0b1220!important;color:#f8fafc!important;border-color:#334155!important}body[data-theme="dark"] th{background:#162235!important;color:#cbd5e1!important}body[data-theme="dark"] td{border-color:#334155!important}body[data-theme="dark"] .aaCard.review,body[data-theme="dark"] .warnCard{background:#2a1a12!important;border-color:#92400e!important}body[data-theme="dark"] .qcard,body[data-theme="dark"] .whd-quarter-card{background:#0f172a!important;border-color:#334155!important;color:#f8fafc!important}body[data-theme="dark"] .whd-quarter-main strong{color:#f8fafc!important}@media print{.actions,.tools,.cardActions{display:none}.hero,.panel{box-shadow:none}}

        @media(max-width:800px){body{padding-left:14px!important;padding-right:14px!important}}

    </style></head><body><div class="shell">
      <section class="hero"><div class="top"><div><h1>AR Performance Dashboard</h1><div class="sub">V1.4 polish • ${esc(dateStr)} • photo cards, clickable shift commentary, item categories</div></div><div class="actions"><button id="webThemeToggle" type="button">🌙 Dark</button><button onclick="window.print()">Print / Save PDF</button></div></div>
        <div class="kpis"><div class="kpi"><span>Total Items</span><b>${actualUnits.toLocaleString()}</b><em>Target ${target || '—'}</em></div><div class="kpi"><span>Team TPH</span><b>${teamRate ? teamRate.toFixed(1) : '—'}</b><em>${actualRate ? 'PPR actual rate' : 'AA avg × HC'}</em></div><div class="kpi"><span>HC & Projection</span><b>${hc} HC</b><em>Total projection ${projected ? projected.toLocaleString() : '—'} items</em></div><div class="kpi"><span>Total Gaps</span><b>${allGaps.length}</b><em>${bigGaps.length} big gaps</em></div></div>
        <div class="quarters">${quarterHtml}</div><div class="note">${esc(smartSummary)}</div>
      </section>
      <main><section class="panel"><div class="panelHead"><h2>AA Cards</h2><div class="tools"><input id="search" placeholder="Search AA"><select id="filter"><option value="all">All</option><option value="review">Review only</option><option value="stable">Stable only</option></select></div></div><div class="aaGrid">${aaCards}</div></section>
      <section class="panel shiftPanel"><h2>Shift Commentary</h2><details class="shiftDetails" open><summary>View shift commentary and gap review</summary><div class="note">${esc(smartSummary)}</div><div class="warns">${warningHtml}</div></details></section><section class="panel mixPanel"><div class="mixHead"><h2>Size & Category Mix</h2><span>One combined view to avoid duplicate category sections</span></div><div class="mixTwo"><div class="mixBox"><h3>Size Mix</h3>${whdSizeBarHtml()}</div><div class="mixBox catBox"><h3>Category Mix</h3>${whdCategoryPieHtml()}</div></div></section></main>
    </div><script>
      const savedTheme=(window.opener&&window.opener.localStorage?window.opener.localStorage.getItem('ar_whd_theme'):localStorage.getItem('ar_whd_theme'))||'light';document.body.setAttribute('data-theme',savedTheme);const themeBtn=document.getElementById('webThemeToggle');if(themeBtn)themeBtn.textContent=savedTheme==='dark'?'☀️ Bright':'🌙 Dark';if(themeBtn)themeBtn.addEventListener('click',()=>{const next=document.body.getAttribute('data-theme')==='dark'?'light':'dark';document.body.setAttribute('data-theme',next);themeBtn.textContent=next==='dark'?'☀️ Bright':'🌙 Dark';try{localStorage.setItem('ar_whd_theme',next);window.opener&&window.opener.localStorage&&window.opener.localStorage.setItem('ar_whd_theme',next);}catch(e){}});
      document.querySelectorAll('[data-toggle-row]').forEach(btn=>btn.addEventListener('click',()=>{const el=document.getElementById(btn.getAttribute('data-toggle-row')); if(el) el.style.display=el.style.display==='none'?'':'none';}));
      const apply=()=>{const q=(document.getElementById('search').value||'').toLowerCase().trim();const f=document.getElementById('filter').value;document.querySelectorAll('[data-aa-row]').forEach(r=>{const ok=(!q||(r.getAttribute('data-name')||'').includes(q))&&(f==='all'||(r.getAttribute('data-status')||'')===f);r.style.display=ok?'':'none';});};
      document.getElementById('search').addEventListener('input',apply);document.getElementById('filter').addEventListener('change',apply);
    </script></body></html>`);
    w.document.close();
  };

})();

/* === V1.8.1 POPUP + WEB THEME FIX === */
(function(){
  function injectARThemeFix(){
    if(document.getElementById('ar-v181-theme-fix-style')) return;
    const css = `
      :root{
        --ar-light-bg:#f6f8fc;--ar-light-card:#ffffff;--ar-light-soft:#f1f5f9;--ar-light-text:#111827;--ar-light-muted:#475569;--ar-light-border:#dbe3ef;
        --ar-dark-bg:#07111f;--ar-dark-card:#0f172a;--ar-dark-soft:#162235;--ar-dark-text:#f8fafc;--ar-dark-muted:#cbd5e1;--ar-dark-border:#334155;
      }
    `;
    const style=document.createElement('style');
    style.id='ar-v181-theme-fix-style';
    style.textContent=css;
    document.head.appendChild(style);
  }
  injectARThemeFix();
  setInterval(()=>{
    const overlay=document.getElementById('whd-popup-overlay');
    if(overlay){
    }
  },700);
})();

/* === V1.8.3 RESPONSIVE SUMMARY GRID FIT PATCH === */
(function(){
  const STYLE_ID = 'ar-v183-summary-grid-fit';
  function installSummaryGridFit(){
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      /* Main popup + web containers should never force horizontal scroll */
      .ar-web-page, .ar-web-dashboard, .whd-web-page, .whd-dashboard-page,
      #arWebPage, #ar-dashboard-page, #whdWebPage,
      .ar-popup, .whd-popup, #arPopup, #whdPopup,
      [class*="popup"], [class*="dashboard"] {
        max-width: 100% !important;
        box-sizing: border-box !important;
      }

      /* Summary grid: popup + webpage */
      .ar-summary-grid,
      .whd-summary-grid,
      .ar-kpi-grid,
      .whd-kpi-grid,
      .ar-metric-grid,
      .whd-metric-grid,
      .summary-grid,
      .kpi-grid,
      .metric-grid,
      [class*="summary-grid"],
      [class*="kpi-grid"],
      [class*="metric-grid"] {
        display: grid !important;
        grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)) !important;
        gap: 8px !important;
        width: 100% !important;
        max-width: 100% !important;
        overflow: visible !important;
        box-sizing: border-box !important;
        align-items: stretch !important;
      }

      /* Bigger web page can use slightly wider cards */
      .ar-web-page .ar-summary-grid,
      .ar-web-dashboard .ar-summary-grid,
      .whd-web-page .whd-summary-grid,
      .whd-dashboard-page .whd-summary-grid,
      #arWebPage [class*="summary-grid"],
      #whdWebPage [class*="summary-grid"] {
        grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)) !important;
        gap: 10px !important;
      }

      /* Popup cards must be compact */
      .ar-popup .ar-summary-grid,
      .whd-popup .whd-summary-grid,
      #arPopup [class*="summary-grid"],
      #whdPopup [class*="summary-grid"],
      [class*="popup"] [class*="summary-grid"],
      [class*="popup"] [class*="kpi-grid"],
      [class*="popup"] [class*="metric-grid"] {
        grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)) !important;
        gap: 7px !important;
      }

      /* Summary cards */
      .ar-summary-card,
      .whd-summary-card,
      .ar-kpi-card,
      .whd-kpi-card,
      .ar-metric-card,
      .whd-metric-card,
      .summary-card,
      .kpi-card,
      .metric-card,
      [class*="summary-card"],
      [class*="kpi-card"],
      [class*="metric-card"] {
        min-width: 0 !important;
        width: auto !important;
        max-width: 100% !important;
        padding: 9px 10px !important;
        border-radius: 12px !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
      }

      /* Text should wrap/fit nicely inside cards */
      .ar-summary-card *,
      .whd-summary-card *,
      .ar-kpi-card *,
      .whd-kpi-card *,
      .ar-metric-card *,
      .whd-metric-card *,
      .summary-card *,
      .kpi-card *,
      .metric-card *,
      [class*="summary-card"] *,
      [class*="kpi-card"] *,
      [class*="metric-card"] * {
        min-width: 0 !important;
        max-width: 100% !important;
        overflow-wrap: anywhere !important;
        word-break: normal !important;
        box-sizing: border-box !important;
      }

      /* Compact typography inside summary cards */
      .ar-summary-card h1, .ar-summary-card h2, .ar-summary-card h3,
      .whd-summary-card h1, .whd-summary-card h2, .whd-summary-card h3,
      .summary-card h1, .summary-card h2, .summary-card h3,
      [class*="summary-card"] h1, [class*="summary-card"] h2, [class*="summary-card"] h3 {
        font-size: clamp(15px, 1.3vw, 20px) !important;
        line-height: 1.12 !important;
        margin: 0 0 3px 0 !important;
      }

      .ar-summary-card b, .ar-summary-card strong,
      .whd-summary-card b, .whd-summary-card strong,
      .summary-card b, .summary-card strong,
      [class*="summary-card"] b, [class*="summary-card"] strong {
        font-size: clamp(14px, 1.2vw, 19px) !important;
        line-height: 1.1 !important;
      }

      .ar-summary-card small,
      .whd-summary-card small,
      .summary-card small,
      [class*="summary-card"] small {
        display: block !important;
        font-size: 10.5px !important;
        line-height: 1.2 !important;
        white-space: normal !important;
      }

      /* Force top summary/quarter rows to fit */
      .ar-quarter-grid,
      .whd-quarter-grid,
      .quarter-grid,
      [class*="quarter-grid"] {
        display: grid !important;
        grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
        gap: 8px !important;
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
      }

      [class*="popup"] .ar-quarter-grid,
      [class*="popup"] .whd-quarter-grid,
      [class*="popup"] .quarter-grid,
      [class*="popup"] [class*="quarter-grid"] {
        gap: 6px !important;
      }

      @media (max-width: 900px) {
        .ar-quarter-grid,
        .whd-quarter-grid,
        .quarter-grid,
        [class*="quarter-grid"] {
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        }
      }

      @media (max-width: 520px) {
        .ar-summary-grid,
        .whd-summary-grid,
        .ar-kpi-grid,
        .whd-kpi-grid,
        .ar-metric-grid,
        .whd-metric-grid,
        .summary-grid,
        .kpi-grid,
        .metric-grid,
        [class*="summary-grid"],
        [class*="kpi-grid"],
        [class*="metric-grid"] {
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        }

        .ar-quarter-grid,
        .whd-quarter-grid,
        .quarter-grid,
        [class*="quarter-grid"] {
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        }
      }

      /* Prevent any card row from creating sideways scroll */
      .ar-web-page > *,
      .ar-web-dashboard > *,
      .whd-web-page > *,
      .whd-dashboard-page > *,
      #arWebPage > *,
      #whdWebPage > * {
        max-width: 100% !important;
        box-sizing: border-box !important;
      }
    `;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function applySummaryFitClasses(){
    const possibleGrids = [...document.querySelectorAll('div,section')].filter(el => {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const cls = String(el.className || '').toLowerCase();
      if (/summary-grid|kpi-grid|metric-grid|quarter-grid/.test(cls)) return true;
      if (txt.length < 220 && /(total\s*items|total\s*gaps|actual\s*tph|plan\s*tph|q1|q2|q3|q4)/i.test(txt)) {
        const children = [...el.children].filter(c => (c.textContent || '').trim().length > 0);
        return children.length >= 3 && children.length <= 8;
      }
      return false;
    });

    possibleGrids.forEach(el => {
      if (!/grid/i.test(String(el.className || ''))) el.classList.add('ar-summary-grid');
      [...el.children].forEach(child => {
        const t = (child.textContent || '').replace(/\s+/g,' ').trim();
        if (t.length < 120 && /(items|gaps|tph|q1|q2|q3|q4|target|processed|rate)/i.test(t)) {
          child.classList.add('ar-summary-card');
        }
      });
    });
  }

  installSummaryGridFit();
  applySummaryFitClasses();
  setInterval(applySummaryFitClasses, 1500);

/* === V1 quarter grid summary-card polish === */
(function(){
  const STYLE_ID = 'ar-v1-quarter-grid-summary-polish';
  if (document.getElementById(STYLE_ID)) return;

  const css = `
    .whd-quarter-strip,
    .whd-quarter-grid,
    .quarter-grid,
    .qGrid,
    .whd-qgrid {
      display:grid !important;
      grid-template-columns:repeat(4,minmax(0,1fr)) !important;
      gap:10px !important;
      align-items:stretch !important;
      margin-top:10px !important;
    }

    .whd-quarter-strip .whd-quarter-card,
    .whd-quarter-grid .q,
    .quarter-grid .q,
    .qGrid .q,
    .whd-qgrid .q,
    .whd-quarter-grid .quarter-card,
    .quarter-grid .quarter-card,
    .qGrid .quarter-card,
    .whd-qgrid .quarter-card {
      background:#ffffff !important;
      border:1px solid #e2e8f0 !important;
      border-radius:16px !important;
      box-shadow:0 8px 22px rgba(15,23,42,.07) !important;
      padding:11px 10px !important;
      min-width:0 !important;
      overflow:hidden !important;
      display:flex !important;
      flex-direction:column !important;
      justify-content:center !important;
      gap:4px !important;
    }

    .whd-quarter-strip .whd-quarter-card b,
    .whd-quarter-grid .q b,
    .quarter-grid .q b,
    .qGrid .q b,
    .whd-qgrid .q b,
    .whd-quarter-grid .quarter-card b,
    .quarter-grid .quarter-card b,
    .qGrid .quarter-card b,
    .whd-qgrid .quarter-card b {
      display:block !important;
      font-size:20px !important;
      line-height:1.05 !important;
      font-weight:900 !important;
      letter-spacing:-.04em !important;
      color:#0f172a !important;
      white-space:nowrap !important;
      overflow:hidden !important;
      text-overflow:clip !important;
      font-variant-numeric:tabular-nums !important;
    }

    .whd-quarter-strip .whd-quarter-card small,
    .whd-quarter-grid .q small,
    .quarter-grid .q small,
    .qGrid .q small,
    .whd-qgrid .q small,
    .whd-quarter-grid .quarter-card small,
    .quarter-grid .quarter-card small,
    .qGrid .quarter-card small,
    .whd-qgrid .quarter-card small {
      display:block !important;
      font-size:10px !important;
      line-height:1.15 !important;
      color:#64748b !important;
      font-weight:800 !important;
      text-transform:uppercase !important;
      letter-spacing:.04em !important;
      white-space:nowrap !important;
      overflow:hidden !important;
      text-overflow:ellipsis !important;
    }

    .whd-quarter-grid .q .q-title,
    .quarter-grid .q .q-title,
    .qGrid .q .q-title,
    .whd-qgrid .q .q-title,
    .whd-quarter-grid .quarter-card .q-title,
    .quarter-grid .quarter-card .q-title {
      font-size:11px !important;
      font-weight:900 !important;
      color:#334155 !important;
      white-space:nowrap !important;
    }

    .whd-quarter-grid .q.hit,
    .quarter-grid .q.hit,
    .qGrid .q.hit,
    .whd-qgrid .q.hit {
      background:#f8fafc !important;
      border-color:#dbeafe !important;
    }

    .whd-quarter-grid .q.miss,
    .quarter-grid .q.miss,
    .qGrid .q.miss,
    .whd-qgrid .q.miss {
      background:#fff7ed !important;
      border-color:#fed7aa !important;
    }

    .whd-quarter-grid .q.review,
    .quarter-grid .q.review,
    .qGrid .q.review,
    .whd-qgrid .q.review {
      background:#fffbeb !important;
      border-color:#fde68a !important;
    }

    @media (max-width:780px){
      .whd-quarter-grid,
      .quarter-grid,
      .qGrid,
      .whd-qgrid {
        grid-template-columns:repeat(2,minmax(0,1fr)) !important;
      }
    }

    @media (max-width:420px){
      .whd-quarter-grid,
      .quarter-grid,
      .qGrid,
      .whd-qgrid {
        grid-template-columns:repeat(2,minmax(0,1fr)) !important;
        gap:8px !important;
      }

      .whd-quarter-grid .q b,
      .quarter-grid .q b,
      .qGrid .q b,
      .whd-qgrid .q b,
      .whd-quarter-grid .quarter-card b,
      .quarter-grid .quarter-card b {
        font-size:18px !important;
      }
    }
  `;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
})();

})();
