'use strict';
// ============================================================
// app.js — OJC 수입품목 발주 계획 메인 로직
// ============================================================

// ── 구매처 약칭
const SUP_SHORT = {
  'Fiberwit Link Communication Co.,LTD':     'Fiberwit',
  'Shenzhen Fibercan Optical Co., Ltd':       'Fibercan(SZ)',
  'Huizhou Fibercan Industrial Co.,Ltd':      'Fibercan(HZ)',
  'CFOFC Communications (Shenzhen) Co., Ltd': 'CFOFC',
  'Henan Shijia Photons Technology Co.,Ltd':  'Shijia',
};

// ── 전역 상태
let G = {
  items:      [],      // 현재 품목 목록
  prices:     {},      // { code: {import_price,maeksan_cost,prod_cost,std_ratio,standard_cost} }
  orderPlan:  {},      // { code: {order_qty,is_confirmed,confirmed_by} }
  settings:   {},      // { std_cost_ratio, admin_pw_hash, ... }
  curFilter:  'all',
  curSearch:  '',
  curSupplier:'',
  curTrend:   '',
  showCost:   false,
  sortCol:    'urgency',
  sortDir:    'asc',
  stdRatio:   DEFAULT_STD_RATIO,
  priceModalCode: null,
  adminCallback:  null,
  uploadParsed:   null,  // 업로드 파싱된 데이터 임시 보관
  clientIP:       'unknown',
};

// ── 수치 파싱
const num = v => {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = parseFloat(String(v).replace(/[,\s]/g, ''));
  return isNaN(n) ? null : n;
};
const fmt = (v, d = 0) => {
  const n = num(String(v ?? ''));
  if (n === null) return '-';
  return n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtW = v => { // 원화 표시
  const n = num(String(v ?? ''));
  if (n === null) return '-';
  return n.toLocaleString('ko-KR') + '원';
};
function round(n, step) { return Math.ceil(n / step) * step; }

// ── IP 주소 가져오기
async function fetchIP() {
  try {
    const r = await fetch('https://api64.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
    G.clientIP = (await r.json()).ip || 'unknown';
  } catch { G.clientIP = 'unknown'; }
}

// ── SHA-256 해시
async function sha256(msg) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── 가용재고(월) 색상
function fmtAvail(v) {
  const n = num(v);
  if (n === null) return '<span class="av-na">-</span>';
  const cls = n < 0 ? 'av-crit' : n < 2 ? 'av-crit' : n < 4 ? 'av-warn' : 'av-ok';
  return `<span class="${cls}">${n.toFixed(1)}개월</span>`;
}

// ── 발주 알고리즘
function calcUrgency(item) {
  const avg = num(item.avg_cur) || num(item.avg_prev) || 0;
  if (avg === 0) return 'na';
  const avail = num(item.avail_mo_incl);
  if (avail === null) return 'na';
  if (avail < 2) return 'urgent';
  if (avail < 4) return 'warning';
  return 'ok';
}

function calcRecQty(item) {
  const avg = num(item.avg_cur) || num(item.avg_prev) || 0;
  if (avg === 0) return 0;
  const stock = Math.max(0, num(item.stock) ?? 0);
  const inc   = Math.max(0, num(item.incoming) ?? 0);
  const need  = avg * TARGET_MONTHS - stock - inc;
  if (need <= 0) return 0;
  const step = need > 50000 ? 10000 : need > 10000 ? 5000 : need > 2000 ? 1000 : need > 500 ? 100 : 10;
  return round(need, step);
}

function calcProjAvail(item, orderQty) {
  const avg = num(item.avg_cur) || num(item.avg_prev) || 0;
  if (avg === 0) return null;
  const stock = Math.max(0, num(item.stock) ?? 0);
  const inc   = Math.max(0, num(item.incoming) ?? 0);
  return (stock + inc + (orderQty || 0)) / avg;
}

function calcTiming(item) {
  const urgency = item._urgency;
  if (urgency === 'na')      return { text: '—',       cls: 't-na' };
  if (urgency === 'urgent')  return { text: '즉시',    cls: 't-now' };
  const lt   = (num(item.leadtime) || DEFAULT_LEADTIME) / 30;
  const avail = num(item.avail_mo_incl) ?? 0;
  const left  = avail - lt;
  if (urgency === 'warning') return { text: left < 1 ? '1개월 내' : `${Math.floor(left)}개월 내`, cls: 't-soon' };
  return { text: `${Math.floor(left)}개월+ 여유`, cls: 't-later' };
}

// ── 원가 비교 판정
// 맥산생산원가 vs 수입가격
function cmpMaeksan(code) {
  const imp = num(G.prices[code]?.import_price);
  const mac = num(G.prices[code]?.maeksan_cost);
  if (imp === null || mac === null) return { text: '—', cls: 'cmp-na' };
  if (mac > imp) return { text: '✅ 수입 유리', cls: 'cmp-import' }; // 맥산원가 더 비쌈 → 수입이 이득
  if (mac < imp) return { text: '🔵 생산 유리', cls: 'cmp-prod' };  // 맥산원가 더 쌈 → 생산이 이득
  return { text: '= 동일', cls: 'cmp-na' };
}

// 표준원가 vs 수입가격 (기존 비교)
function cmpCost(item) {
  const imp = num(G.prices[item.code]?.import_price);
  const std = num(G.prices[item.code]?.standard_cost);
  if (imp === null || std === null) return { text: '—', cls: 'cmp-na' };
  if (std > imp) return { text: '✅ 수입 유리', cls: 'cmp-import' }; // 표준원가 더 비쌈 → 수입이 이득
  if (std < imp) return { text: '🔵 생산 유리', cls: 'cmp-prod' };  // 표준원가 더 쌈 → 생산이 이득
  return { text: '= 동일', cls: 'cmp-na' };
}

// ── 표준원가 계산
function calcStdCost(prodCost, ratio) {
  const p = num(prodCost), r = num(ratio) ?? G.stdRatio;
  if (p === null) return null;
  return p * r;
}

// ============================================================
// 데이터 로드
// ============================================================
async function loadData() {
  setHeaderSub('데이터 로딩 중…');
  // Supabase에서 시도
  if (DB.isReady()) {
    const [sbItems, sbPrices, sbPlan, sbSettings] = await Promise.all([
      DB.loadLatestItems(),
      DB.loadPrices(),
      DB.loadOrderPlan(),
      DB.getSettings(),
    ]);
    if (sbSettings) {
      G.settings  = sbSettings;
      G.stdRatio  = num(sbSettings.std_cost_ratio) ?? DEFAULT_STD_RATIO;
    }
    G.prices    = sbPrices || {};
    G.orderPlan = sbPlan   || {};
    // Supabase에 품목 있으면 사용, 없으면 static fallback
    G.items = (sbItems && sbItems.length > 0)
      ? sbItems.map(normalizeItem)
      : (typeof RAW_DATA !== 'undefined' ? RAW_DATA.map(normalizeItem) : []);
  } else {
    // static fallback
    G.items = (typeof RAW_DATA !== 'undefined') ? RAW_DATA.map(normalizeItem) : [];
    // localStorage 발주 계획
    try { G.orderPlan = JSON.parse(localStorage.getItem('ojc_order_plan') || '{}'); } catch {}
  }
  updateStats();
  renderTable();
  renderCostTab();
  renderConfirmedTab();
  setHeaderSub(`품목 ${G.items.length}건 · 기준일 2026-03-27`);
  document.getElementById('ratioDisplay').textContent = G.stdRatio;
  document.getElementById('ratioLabel').textContent   = `×${G.stdRatio}`;
  updateSyncBadge(DB.isReady());
}

// static data → 내부 형식 통일
function normalizeItem(it) {
  // Supabase items: avg_cur / avg_prev
  // RAW_DATA: avg26 / avg2425
  return {
    code:         it.code,
    name:         it.name,
    spec:         it.spec || '',
    supplier:     it.supplier || '',
    stock:        it.stock     ?? it.stock,
    incoming:     it.incoming  ?? it.incoming,
    leadtime:     it.leadtime  ?? 60,
    safety_stock: it.safety_stock ?? it.safetyStock ?? 0,
    avg_prev:     num(it.avg_prev  ?? it.avg2425) ?? 0,
    avg_cur:      num(it.avg_cur   ?? it.avg26)   ?? 0,
    trend:        it.trend || '',
    avail_mo:     num(it.avail_mo     ?? it.availMo)     ?? null,
    avail_mo_incl:num(it.avail_mo_incl?? it.availMoIncl) ?? null,
    _urgency:     null,
    _recQty:      null,
  };
}

// 파생 필드 보정 (upload 후 avail_mo가 없는 경우)
function enrichItem(it) {
  const avg = it.avg_cur || it.avg_prev || 0;
  if (it.avail_mo === null && avg > 0)
    it.avail_mo = (num(it.stock) ?? 0) / avg;
  if (it.avail_mo_incl === null && avg > 0)
    it.avail_mo_incl = ((num(it.stock) ?? 0) + (num(it.incoming) ?? 0)) / avg;
  it._urgency = calcUrgency(it);
  it._recQty  = calcRecQty(it);
  return it;
}

// ============================================================
// 필터 / 정렬
// ============================================================
const URG_ORD = { urgent:0, warning:1, ok:2, na:3 };

function getFiltered() {
  return G.items.map(enrichItem).filter(it => {
    const conf = !!G.orderPlan[it.code]?.is_confirmed;
    if (G.curFilter === 'urgent'    && it._urgency !== 'urgent')  return false;
    if (G.curFilter === 'warning'   && it._urgency !== 'warning') return false;
    if (G.curFilter === 'ok'        && it._urgency !== 'ok')      return false;
    if (G.curFilter === 'confirmed' && !conf)                     return false;
    if (G.curSupplier && it.supplier !== G.curSupplier)           return false;
    if (G.curTrend    && it.trend.trim() !== G.curTrend)          return false;
    if (G.curSearch) {
      const q = G.curSearch.toLowerCase();
      if (!it.code.toLowerCase().includes(q) && !it.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function getSorted(rows) {
  return [...rows].sort((a, b) => {
    let va, vb;
    if (G.sortCol === 'urgency') { va = URG_ORD[a._urgency]??9; vb = URG_ORD[b._urgency]??9; }
    else { va = a[G.sortCol]; vb = b[G.sortCol]; }
    const na = num(String(va??'')), nb = num(String(vb??''));
    const cmp = na !== null && nb !== null ? na-nb : String(va??'').localeCompare(String(vb??''),'ko');
    return G.sortDir === 'asc' ? cmp : -cmp;
  });
}

// ============================================================
// 통계 업데이트
// ============================================================
function updateStats() {
  const all = G.items.map(enrichItem);
  document.getElementById('cnt-all').textContent      = all.length;
  document.getElementById('cnt-urgent').textContent   = all.filter(i => i._urgency === 'urgent').length;
  document.getElementById('cnt-warning').textContent  = all.filter(i => i._urgency === 'warning').length;
  document.getElementById('cnt-ok').textContent       = all.filter(i => i._urgency === 'ok').length;
  document.getElementById('cnt-confirmed').textContent= Object.values(G.orderPlan).filter(p => p.is_confirmed).length;
}

// ============================================================
// 메인 테이블 렌더
// ============================================================
const URG_LABEL = { urgent:'🔴 즉시발주', warning:'🟡 발주검토', ok:'🟢 여유', na:'—' };
const URG_CLS   = { urgent:'urg-urgent',  warning:'urg-warning',  ok:'urg-ok',  na:'urg-na' };

function renderTable() {
  const rows  = getSorted(getFiltered());
  const tbody = document.getElementById('tbodyMain');
  const info  = document.getElementById('resultInfo');
  const conf  = Object.values(G.orderPlan).filter(p=>p.is_confirmed).length;
  info.textContent = `${rows.length}건 표시 · 전체 ${G.items.length}건 · 확정 ${conf}건`;
  document.getElementById('emptyMsg').classList.toggle('hidden', rows.length > 0);

  // 원가 칼럼 표시 여부
  document.querySelectorAll('.cost-col').forEach(el => el.classList.toggle('hidden', !G.showCost));

  if (!rows.length) {
    tbody.innerHTML = '';
    document.getElementById('tfootMain').innerHTML = '';
    return;
  }

  // 합계 HTML
  const summaryHTML = buildSummaryRow(rows);
  // 상단 합계 행 (tbody 첫번째, sticky)
  const topSummary = `<tr class="summary-row summary-top">${summaryHTML}</tr>`;
  // 하단 합계 행 (tfoot, sticky bottom)
  document.getElementById('tfootMain').innerHTML = `<tr>${summaryHTML}</tr>`;

  tbody.innerHTML = topSummary + rows.map(item => {
    const plan   = G.orderPlan[item.code] || {};
    const conf   = !!plan.is_confirmed;
    const savedQ = plan.order_qty != null ? plan.order_qty : null;
    const dispQ  = savedQ !== null ? savedQ : (item._recQty || '');
    const hasVal = dispQ !== '' && dispQ !== null && dispQ !== 0;
    const sup    = SUP_SHORT[item.supplier] || item.supplier.split(' ')[0];
    const timing = calcTiming(item);
    const trend  = item.trend.trim();
    const trendH = trend === '증가' ? '<span class="tr-inc">↑ 증가</span>'
                 : trend === '감소' ? '<span class="tr-dec">↓ 감소</span>'
                 : `<span>${trend}</span>`;
    const rowCls = conf ? 'row-confirmed' : item._urgency === 'urgent' ? 'row-urgent'
                        : item._urgency === 'warning' ? 'row-warning' : '';
    const codeE  = item.code.replace(/'/g,"\\'");
    const useQ   = savedQ !== null ? savedQ : (item._recQty || 0);
    const projA  = calcProjAvail(item, useQ);
    const projH  = projA !== null
      ? `<span class="${projA<3?'av-crit':projA<5?'av-warn':'av-ok'}" style="font-size:12px">→${projA.toFixed(1)}개월</span>`
      : '<span class="av-na">—</span>';

    // 원가 칼럼
    const pr     = G.prices[item.code] || {};
    const cmpMac = cmpMaeksan(item.code);
    const cmpStd = cmpCost(item);
    const costCols = G.showCost ? `
      <td class="cost-td">${fmt(pr.import_price)}</td>
      <td class="cost-td">${fmt(pr.maeksan_cost)}</td>
      <td class="cost-td">${fmt(pr.prod_cost)}</td>
      <td class="cost-td">${fmt(pr.standard_cost)}</td>
      <td class="cost-td"><span class="${cmpMac.cls}" style="font-size:11px">${cmpMac.text}</span></td>
      <td class="cost-td"><span class="${cmpStd.cls}" style="font-size:11px">${cmpStd.text}</span></td>` : '';

    return `<tr class="${rowCls}" data-code="${codeE}">
      <td class="ctr"><input type="checkbox" class="chk-conf" data-code="${codeE}" ${conf?'checked':''} onchange="onConfirmChk('${codeE}',this.checked)"></td>
      <td class="ctr"><span class="urg-badge ${URG_CLS[item._urgency]||'urg-na'}">${URG_LABEL[item._urgency]||'—'}</span></td>
      <td class="code">${item.code}</td>
      <td class="name" title="${item.name}">${item.name}</td>
      <td class="spec" title="${item.spec}">${item.spec||'—'}</td>
      <td class="ctr"><span class="sup-tag">${sup}</span></td>
      <td class="num">${fmt(item.avg_cur)}</td>
      <td class="num">${fmt(item.avg_prev)}</td>
      <td class="ctr">${trendH}</td>
      <td class="ctr">${item.leadtime||'—'}</td>
      <td class="num" style="${num(item.stock)<0?'color:var(--urgent)':''}">${fmt(item.stock)}</td>
      <td class="num" style="color:#0891b2">${fmt(item.incoming)}</td>
      <td class="ctr">${fmtAvail(item.avail_mo_incl)}</td>
      <td class="ctr">${projH}</td>
      <td class="num ${item._recQty?'rec-val':'av-na'}">${item._recQty?fmt(item._recQty):'—'}</td>
      <td class="ctr">
        <input type="number" class="order-input ${hasVal?'has-val':''}"
          value="${hasVal?dispQ:''}" placeholder="${item._recQty?fmt(item._recQty):'0'}"
          min="0" step="1" ${conf?'disabled':''}
          onchange="onQtyChange('${codeE}',this)"
          oninput="onQtyChange('${codeE}',this)">
      </td>
      ${costCols}
      <td class="ctr"><span class="${timing.cls}">${timing.text}</span></td>
    </tr>`;
  }).join('');
}

// ── 합계 행 HTML 생성
function buildSummaryRow(rows) {
  const sumStock    = rows.reduce((s,i) => s + Math.max(0, num(i.stock)    ?? 0), 0);
  const sumIncoming = rows.reduce((s,i) => s + Math.max(0, num(i.incoming) ?? 0), 0);
  const sumRec      = rows.reduce((s,i) => s + (i._recQty || 0), 0);
  const sumOrder    = rows.reduce((s,i) => s + (num(G.orderPlan[i.code]?.order_qty) || 0), 0);
  const availList   = rows.map(i => num(i.avail_mo_incl)).filter(v => v !== null);
  const avgAvail    = availList.length ? availList.reduce((a,b) => a+b, 0) / availList.length : null;
  const urgC = {
    urgent:  rows.filter(i => i._urgency === 'urgent').length,
    warning: rows.filter(i => i._urgency === 'warning').length,
    ok:      rows.filter(i => i._urgency === 'ok').length,
  };
  const costCols = G.showCost
    ? `<td class="cost-td">—</td><td class="cost-td">—</td><td class="cost-td">—</td><td class="cost-td">—</td><td class="cost-td">—</td><td class="cost-td">—</td>`
    : '';
  return `
    <td class="ctr"></td>
    <td class="ctr" style="font-size:10px;line-height:1.8;white-space:nowrap">
      🔴${urgC.urgent}<br>🟡${urgC.warning}<br>🟢${urgC.ok}
    </td>
    <td colspan="4" class="summary-label" style="padding-left:10px">
      합 계 &nbsp;<span style="font-weight:400;font-size:11px;color:var(--text2)">${rows.length}건</span>
    </td>
    <td colspan="4"></td>
    <td class="num sum-val">${sumStock.toLocaleString('ko-KR')}</td>
    <td class="num sum-val">${sumIncoming.toLocaleString('ko-KR')}</td>
    <td class="ctr sum-val">${avgAvail !== null ? avgAvail.toFixed(1)+'개월' : '—'}</td>
    <td></td>
    <td class="num sum-val">${sumRec.toLocaleString('ko-KR')}</td>
    <td class="num sum-val" style="color:var(--primary);font-size:13px">${sumOrder.toLocaleString('ko-KR')}</td>
    ${costCols}
    <td></td>`;
}

// ── 수량 변경
window.onQtyChange = function(code, el) {
  const v = parseInt(el.value, 10);
  const qty = !isNaN(v) && v >= 0 ? v : null;
  updateOrderPlan(code, qty, false, null);
  el.classList.toggle('has-val', qty !== null);
  // 예상 가용 즉시 갱신
  const tr = el.closest('tr');
  if (tr) {
    const item = G.items.map(enrichItem).find(i => i.code === code);
    if (item) {
      const proj = calcProjAvail(item, qty || 0);
      const td = tr.querySelectorAll('td')[13];
      if (td) td.innerHTML = proj !== null
        ? `<span class="${proj<3?'av-crit':proj<5?'av-warn':'av-ok'}" style="font-size:12px">→${proj.toFixed(1)}개월</span>`
        : '<span class="av-na">—</span>';
    }
  }
};

// ── 확정 체크박스
window.onConfirmChk = function(code, checked) {
  const plan = G.orderPlan[code] || {};
  updateOrderPlan(code, plan.order_qty ?? null, checked, checked ? '직접확정' : null);
  updateStats();
  const row = document.querySelector(`tr[data-code="${code}"]`);
  if (row) {
    row.classList.toggle('row-confirmed', checked);
    const inp = row.querySelector('.order-input');
    if (inp) inp.disabled = checked;
  }
  renderConfirmedTab();
};

function updateOrderPlan(code, qty, confirmed, by) {
  if (!G.orderPlan[code]) G.orderPlan[code] = {};
  if (qty !== undefined && qty !== null) G.orderPlan[code].order_qty = qty;
  if (confirmed !== undefined) G.orderPlan[code].is_confirmed = confirmed;
  if (by) G.orderPlan[code].confirmed_by = by;
  // 즉시 저장
  if (DB.isReady()) {
    DB.saveOrderPlan(code, qty ?? G.orderPlan[code].order_qty, confirmed, by || '사용자', G.clientIP)
      .catch(() => {});
  } else {
    localStorage.setItem('ojc_order_plan', JSON.stringify(G.orderPlan));
  }
}

// ============================================================
// 발주 확정 목록 탭
// ============================================================
function renderConfirmedTab() {
  const confirmed = G.items.map(enrichItem).filter(i => G.orderPlan[i.code]?.is_confirmed);
  const content   = document.getElementById('confirmContent');
  const summary   = document.getElementById('confirmSummaryText');
  if (!confirmed.length) {
    content.innerHTML = '<div class="confirm-empty">아직 확정된 발주가 없습니다.<br>발주 계획 탭에서 체크박스를 선택하세요.</div>';
    summary.textContent = '';
    return;
  }
  const groups = {};
  confirmed.forEach(it => {
    if (!groups[it.supplier]) groups[it.supplier] = [];
    groups[it.supplier].push(it);
  });
  let totalQty = 0, html = '';
  Object.entries(groups).forEach(([sup, items]) => {
    let gTotal = 0;
    const rows = items.map(it => {
      const qty = G.orderPlan[it.code]?.order_qty ?? it._recQty ?? 0;
      gTotal += Number(qty) || 0;
      return `<tr>
        <td class="code">${it.code}</td>
        <td>${it.name}</td>
        <td style="font-size:11px;color:var(--text2)">${it.spec||'—'}</td>
        <td style="text-align:right;font-weight:700;color:var(--primary)">${Number(qty).toLocaleString('ko-KR')}</td>
        <td style="text-align:center">${fmtAvail(it.avail_mo_incl)}</td>
        <td style="text-align:center"><span class="urg-badge ${URG_CLS[it._urgency]||'urg-na'}">${{urgent:'즉시',warning:'검토',ok:'여유',na:'—'}[it._urgency]||'—'}</span></td>
      </tr>`;
    }).join('');
    totalQty += gTotal;
    html += `<div class="supplier-group">
      <div class="sg-header">
        <span class="sg-name">${sup}</span>
        <span class="sg-count">${items.length}품목</span>
        <span class="sg-total">합계: ${gTotal.toLocaleString('ko-KR')}개</span>
      </div>
      <div class="sg-wrap"><table>
        <thead><tr><th>품목코드</th><th>품목명</th><th>규격</th><th style="text-align:right">발주수량</th><th>가용재고</th><th>긴급도</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  });
  content.innerHTML = html;
  summary.textContent = `총 ${confirmed.length}품목 · ${Object.keys(groups).length}개 구매처 · 발주수량 합계 ${totalQty.toLocaleString('ko-KR')}개`;
}

// ── CSV 내보내기
function exportConfirmCSV() {
  const confirmed = G.items.map(enrichItem).filter(i => G.orderPlan[i.code]?.is_confirmed);
  if (!confirmed.length) { showToast('확정된 발주 항목이 없습니다.'); return; }
  const BOM = '﻿';
  const header = '구매처,품목코드,품목명,규격,월평균판매,가용재고(월),권장발주량,확정발주수량,긴급도';
  const rows = confirmed.map(it => {
    const qty = G.orderPlan[it.code]?.order_qty ?? it._recQty ?? 0;
    return [`"${it.supplier}"`,`"${it.code}"`,`"${it.name}"`,`"${it.spec||''}"`,
      it.avg_cur||0, num(it.avail_mo_incl)??'', it._recQty||0, qty,
      {urgent:'즉시발주',warning:'발주검토',ok:'여유',na:'—'}[it._urgency]||'—'].join(',');
  });
  const csv = BOM + header + '\n' + rows.join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = 'OJC_발주확정_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click(); URL.revokeObjectURL(url);
  showToast('CSV 다운로드 시작');
}

// ============================================================
// 입고예정 탭
// ============================================================
function renderIncomingTab() {
  const data = typeof INCOMING_DATA !== 'undefined' ? INCOMING_DATA : [];
  document.getElementById('incomingTotal').textContent = data.length;
  const sorted = [...data].sort((a,b) => (a.etaExpected||a.eta||'').localeCompare(b.etaExpected||b.eta||''));
  document.getElementById('tbodyIncoming').innerHTML = sorted.map(it => {
    const overdue = it.etaExpected && it.etaExpected < '2026-05-29';
    return `<tr ${overdue?'style="background:#fff8f8"':''}>
      <td style="font-weight:700;color:var(--primary)">${it.poNo||'—'}</td>
      <td>${it.dept||'—'}</td><td class="code">${it.code||'—'}</td><td>${it.name||'—'}</td>
      <td style="text-align:right;font-weight:600">${it.qty?parseInt(it.qty).toLocaleString('ko-KR'):'—'}</td>
      <td>${it.orderDate||'—'}</td><td>${it.eta||'—'}</td>
      <td style="${overdue?'color:var(--warn);font-weight:700':''}">${it.etaExpected||'—'}</td>
      <td>${it.loc||'—'}</td>
      <td style="font-size:11px;color:var(--text2)">${it.note||'—'}</td>
    </tr>`;
  }).join('');
}

// ============================================================
// 원가 관리 탭
// ============================================================
function renderCostTab(query) {
  const q = (query||'').toLowerCase();
  const all = G.items.map(enrichItem);
  const filtered = q ? all.filter(i => i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)) : all;
  document.getElementById('costResultInfo').textContent = `${filtered.length}건`;
  document.getElementById('tbodyCost').innerHTML = filtered.map(it => {
    const pr      = G.prices[it.code] || {};
    const std     = calcStdCost(pr.prod_cost, pr.std_ratio);
    const cmpMac  = cmpMaeksan(it.code);   // 맥산원가 vs 수입가격
    const cmpStd  = cmpCost(it);           // 표준원가 vs 수입가격
    const updTime = pr.updated_at ? new Date(pr.updated_at).toLocaleDateString('ko-KR') : '—';
    const codeE   = it.code.replace(/'/g,"\\'");

    // 맥산원가 > 수입가격이면 수입가격 강조
    const impStyle  = (num(pr.maeksan_cost) !== null && num(pr.import_price) !== null && num(pr.maeksan_cost) > num(pr.import_price))
      ? 'font-weight:700;color:var(--ok)' : '';
    const macStyle  = (num(pr.maeksan_cost) !== null && num(pr.import_price) !== null && num(pr.maeksan_cost) < num(pr.import_price))
      ? 'font-weight:700;color:var(--primary)' : '';

    return `<tr>
      <td class="code">${it.code}</td>
      <td>${it.name}</td>
      <td style="text-align:right;${impStyle}">${fmt(pr.import_price)}</td>
      <td style="text-align:right;${macStyle}">${fmt(pr.maeksan_cost)}</td>
      <td style="text-align:right">${fmt(pr.prod_cost)}</td>
      <td style="text-align:right;font-weight:700;color:var(--primary)">${fmt(std??pr.standard_cost)}</td>
      <td style="text-align:center"><span class="${cmpMac.cls}">${cmpMac.text}</span></td>
      <td style="text-align:center"><span class="${cmpStd.cls}">${cmpStd.text}</span></td>
      <td style="font-size:11px;color:var(--text2)">${pr.updated_by?`${pr.updated_by}<br>${updTime}`:'—'}</td>
      <td><button class="hist-btn" onclick="openHistModal('${codeE}')">이력</button></td>
      <td><button class="cost-edit-btn" onclick="openPriceModal('${codeE}')">수정</button></td>
    </tr>`;
  }).join('');
}

// ============================================================
// 가격 편집 모달
// ============================================================
window.openPriceModal = function(code) {
  G.priceModalCode = code;
  const item = G.items.find(i => i.code === code) || {};
  const pr   = G.prices[code] || {};
  document.getElementById('priceModalItem').textContent = `${code}  ${item.name||''}`;
  document.getElementById('priceWorker').value  = '';
  document.getElementById('pImport').value   = pr.import_price  ?? '';
  document.getElementById('pMaeksan').value  = pr.maeksan_cost  ?? '';
  document.getElementById('pProd').value     = pr.prod_cost     ?? '';
  document.getElementById('pRatio').value    = pr.std_ratio     ?? '';
  document.getElementById('modalRatioHint').textContent = G.stdRatio;
  updateStdCostPreview();
  document.getElementById('priceModal').classList.remove('hidden');
};
window.closePriceModal = () => document.getElementById('priceModal').classList.add('hidden');

window.updateStdCostPreview = function() {
  const prod  = num(document.getElementById('pProd').value);
  const ratio = num(document.getElementById('pRatio').value) ?? G.stdRatio;
  const std   = prod !== null ? prod * ratio : null;
  document.getElementById('stdCostPreview').textContent = std !== null ? std.toLocaleString('ko-KR') + '원' : '—';
};

document.getElementById('btnSavePriceModal').addEventListener('click', async () => {
  const worker = document.getElementById('priceWorker').value.trim();
  if (!worker) { showToast('작업자 이름을 입력하세요.'); return; }
  const code = G.priceModalCode;
  const item = G.items.find(i => i.code === code) || {};
  const prod  = num(document.getElementById('pProd').value);
  const ratio = num(document.getElementById('pRatio').value) ?? G.stdRatio;
  const stdCost = prod !== null ? prod * ratio : null;
  const newPrices = {
    import_price:  num(document.getElementById('pImport').value),
    maeksan_cost:  num(document.getElementById('pMaeksan').value),
    prod_cost:     prod,
    std_ratio:     num(document.getElementById('pRatio').value),
    standard_cost: stdCost,
  };
  // 즉시 로컬 반영
  G.prices[code] = { ...G.prices[code], ...newPrices, updated_by: worker, updated_at: new Date().toISOString() };
  // Supabase 저장
  if (DB.isReady()) {
    const res = await DB.savePrice(code, item.name||'', newPrices, worker, G.clientIP);
    if (res.error) { showToast('저장 오류: ' + res.error); return; }
  }
  closePriceModal();
  renderCostTab(document.getElementById('costSearch').value);
  renderTable();
  showToast(`${code} 원가 저장 완료 (${worker})`);
});

// ============================================================
// 가격 이력 모달
// ============================================================
window.openHistModal = async function(code) {
  const item = G.items.find(i => i.code === code) || {};
  document.getElementById('histModalItem').textContent = `${code}  ${item.name||''}`;
  document.getElementById('histModalContent').innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">로딩 중…</p>';
  document.getElementById('histModal').classList.remove('hidden');
  const hist = DB.isReady() ? await DB.loadPriceHistory(code) : [];
  if (!hist.length) {
    document.getElementById('histModalContent').innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">변경 이력이 없습니다.</p>';
    return;
  }
  const rows = hist.map(h => {
    const d = new Date(h.changed_at).toLocaleString('ko-KR');
    const chg = (field, o, n) => o !== n && o !== null && n !== null
      ? `<span class="chg">${fmt(n)} <small style="color:#94a3b8">(이전: ${fmt(o)})</small></span>`
      : fmt(n ?? o);
    return `<tr>
      <td>${d}</td>
      <td style="font-weight:600">${h.changed_by}</td>
      <td style="font-size:10px;color:#94a3b8">${h.ip_address||'—'}</td>
      <td style="text-align:right">${chg('import', h.import_price_old, h.import_price_new)}</td>
      <td style="text-align:right">${chg('maeksan', h.maeksan_cost_old, h.maeksan_cost_new)}</td>
      <td style="text-align:right">${chg('prod', h.prod_cost_old, h.prod_cost_new)}</td>
      <td style="text-align:right">${chg('std', h.standard_cost_old, h.standard_cost_new)}</td>
    </tr>`;
  }).join('');
  document.getElementById('histModalContent').innerHTML = `
    <table class="hist-table">
      <thead><tr><th>변경일시</th><th>작업자</th><th>IP</th><th>수입가격</th><th>맥산원가</th><th>생산원가</th><th>표준원가</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
};
window.closeHistModal = () => document.getElementById('histModal').classList.add('hidden');

// ============================================================
// 가격 다운로드 (관리자 인증 후)
// ============================================================
document.getElementById('btnDownloadPrice').addEventListener('click', () => {
  openAdminModal('가격 데이터 다운로드를 위해 관리자 비밀번호를 입력하세요.', async (name, pw) => {
    const ok = await verifyAdmin(pw);
    if (!ok) return '비밀번호가 올바르지 않습니다.';
    await DB.logDownload('price_download', name, G.clientIP, G.items.length, 'csv');
    exportPriceCSV(name);
    return null;
  });
});

async function exportPriceCSV(actorName) {
  const BOM = '﻿';
  const header = '품목코드,품목명,규격,수입가격,맥산생산원가,생산원가,표준원가비율,표준원가,최종수정자,최종수정일시';
  const rows = G.items.map(it => {
    const pr  = G.prices[it.code] || {};
    const std = calcStdCost(pr.prod_cost, pr.std_ratio);
    return [`"${it.code}"`,`"${it.name}"`,`"${it.spec||''}"`,
      pr.import_price??'', pr.maeksan_cost??'', pr.prod_cost??'',
      pr.std_ratio??G.stdRatio, fmt(std??pr.standard_cost),
      `"${pr.updated_by||''}"`, `"${pr.updated_at||''}"`].join(',');
  });
  const csv  = BOM + header + '\n' + rows.join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a'); a.href = url;
  a.download = 'OJC_가격목록_' + actorName + '_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click(); URL.revokeObjectURL(url);
  showToast(`가격 목록 다운로드 완료 (${actorName})`);
}

// ── 가격 업로드
document.getElementById('btnUploadPrice').addEventListener('click', () => {
  document.getElementById('priceFileInput').click();
});
document.getElementById('priceFileInput').addEventListener('change', async function() {
  const file = this.files[0]; if (!file) return;
  const worker = prompt('작업자 이름을 입력하세요 (필수):');
  if (!worker?.trim()) { showToast('작업자 이름이 필요합니다.'); this.value=''; return; }
  const data = await parseFile(file);
  if (!data) { this.value=''; return; }
  const hRow = data.findIndex(r => r.some(c => String(c).includes('품목코드')));
  if (hRow < 0) { showToast('템플릿 양식이 맞지 않습니다. 품목코드 헤더를 확인하세요.'); this.value=''; return; }
  const headers = data[hRow].map(h => String(h).trim());
  const ci = k => headers.findIndex(h => h.includes(k));
  const rows = [];
  for (let r = hRow+1; r < data.length; r++) {
    const row = data[r];
    const code = String(row[ci('품목코드')]||'').trim();
    if (!code) continue;
    rows.push({
      code,
      name:         String(row[ci('품목명')]||'').trim(),
      import_price: num(row[ci('수입가격')]),
      maeksan_cost: num(row[ci('맥산')]),
      prod_cost:    num(row[ci('생산원가')]),
      std_ratio:    num(row[ci('비율')])??num(row[ci('표준원가비율')]),
    });
  }
  if (!rows.length) { showToast('업로드할 가격 데이터가 없습니다.'); this.value=''; return; }
  if (!confirm(`${rows.length}건의 가격을 업로드하겠습니까?\n작업자: ${worker}`)) { this.value=''; return; }
  // 공란 = 기존값 유지 (merge 방식)
  rows.forEach(r => {
    const existing = G.prices[r.code] || {};
    const merged   = { ...existing };
    // null 이 아닌 항목만 덮어씀
    if (r.import_price  !== null) merged.import_price  = r.import_price;
    if (r.maeksan_cost  !== null) merged.maeksan_cost  = r.maeksan_cost;
    if (r.prod_cost     !== null) merged.prod_cost     = r.prod_cost;
    if (r.std_ratio     !== null) merged.std_ratio     = r.std_ratio;
    if (r.name?.trim())           merged.item_name     = r.name;
    // 표준원가 재계산 (생산원가·비율이 있을 때만)
    const pc  = merged.prod_cost  ?? null;
    const rat = merged.std_ratio  ?? G.stdRatio;
    merged.standard_cost = pc !== null ? pc * rat : null;
    merged.updated_by = worker;
    G.prices[r.code] = merged;
  });
  if (DB.isReady()) {
    // merge=true : Supabase도 공란은 기존값 유지
    const res = await DB.uploadPrices(
      rows.map(r => ({
        ...r,
        standard_cost: (() => {
          const exist = G.prices[r.code] || {};
          const pc  = r.prod_cost  ?? exist.prod_cost  ?? null;
          const rat = r.std_ratio  ?? exist.std_ratio  ?? G.stdRatio;
          return pc !== null ? pc * rat : null;
        })(),
      })),
      worker, G.clientIP
    );
    if (res.error) { showToast('일부 오류: ' + res.error.slice(0,80)); }
  }
  renderCostTab(); renderTable();
  showToast(`가격 ${rows.length}건 업로드 완료 (${worker})`);
  this.value = '';
});

// ── 전체 이력 조회
document.getElementById('btnPriceHistory').addEventListener('click', async () => {
  openHistModal(null); // code=null 이면 전체
  document.getElementById('histModalItem').textContent = '전체 가격 변경 이력';
  document.getElementById('histModalContent').innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">로딩 중…</p>';
  const hist = DB.isReady() ? await DB.loadPriceHistory(null) : [];
  if (!hist.length) {
    document.getElementById('histModalContent').innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">변경 이력이 없습니다.</p>';
    return;
  }
  const rows = hist.map(h => {
    const d = new Date(h.changed_at).toLocaleString('ko-KR');
    return `<tr>
      <td>${d}</td><td style="font-weight:600">${h.changed_by}</td>
      <td style="font-size:10px;color:#94a3b8">${h.ip_address||'—'}</td>
      <td class="code">${h.item_code}</td><td>${h.item_name||'—'}</td>
      <td style="text-align:right">${fmt(h.import_price_new)}</td>
      <td style="text-align:right">${fmt(h.prod_cost_new)}</td>
      <td style="text-align:right;font-weight:700;color:var(--primary)">${fmt(h.standard_cost_new)}</td>
    </tr>`;
  }).join('');
  document.getElementById('histModalContent').innerHTML = `
    <table class="hist-table">
      <thead><tr><th>변경일시</th><th>작업자</th><th>IP</th><th>품목코드</th><th>품목명</th><th>수입가격</th><th>생산원가</th><th>표준원가</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
});

// ── 표준원가 비율 변경
document.getElementById('btnEditRatio').addEventListener('click', () => {
  const v = prompt('표준원가 비율을 입력하세요\n(예: 1.15 = 생산원가의 115%)', G.stdRatio);
  const n = num(v);
  if (n === null || n <= 0) { showToast('올바른 숫자를 입력하세요.'); return; }
  G.stdRatio = n;
  document.getElementById('ratioDisplay').textContent = n;
  document.getElementById('ratioLabel').textContent   = `×${n}`;
  if (DB.isReady()) DB.setSetting('std_cost_ratio', String(n), '관리자').catch(()=>{});
  renderCostTab(); renderTable();
  showToast(`표준원가 비율이 ${n}으로 변경되었습니다.`);
});

// ============================================================
// 관리자 인증 모달
// ============================================================
window.closeAdminModal = () => {
  document.getElementById('adminModal').classList.add('hidden');
  G.adminCallback = null;
};

function openAdminModal(desc, callback) {
  G.adminCallback = callback;
  document.getElementById('adminModalDesc').textContent = desc;
  document.getElementById('adminActorName').value = '';
  document.getElementById('adminPwInput').value   = '';
  document.getElementById('adminPwError').textContent = '';
  document.getElementById('adminModal').classList.remove('hidden');
}

document.getElementById('btnAdminConfirm').addEventListener('click', async () => {
  const name = document.getElementById('adminActorName').value.trim();
  const pw   = document.getElementById('adminPwInput').value;
  if (!name) { document.getElementById('adminPwError').textContent = '이름을 입력하세요.'; return; }
  if (!pw)   { document.getElementById('adminPwError').textContent = '비밀번호를 입력하세요.'; return; }
  const err = await G.adminCallback(name, pw);
  if (err) { document.getElementById('adminPwError').textContent = err; return; }
  closeAdminModal();
});

async function verifyAdmin(pw) {
  const hash = await sha256(pw);
  const stored = G.settings.admin_pw_hash || '';
  if (!stored) return true; // 비밀번호 미설정 시 통과
  return hash === stored;
}

// ============================================================
// 동기화 설정 탭
// ============================================================
document.getElementById('btnSbSave').addEventListener('click', async () => {
  const url = document.getElementById('sbUrl').value.trim();
  const key = document.getElementById('sbKey').value.trim();
  if (!url || !key) { showToast('URL과 Anon Key를 입력하세요.'); return; }
  localStorage.setItem('ojc_sb_url', url);
  localStorage.setItem('ojc_sb_key', key);
  showToast('저장 후 새로고침하면 적용됩니다.'); location.reload();
});

document.getElementById('btnChangePw').addEventListener('click', async () => {
  const curPw   = document.getElementById('currentPw').value;
  const newPw   = document.getElementById('newPw').value;
  const confirm = document.getElementById('newPwConfirm').value;
  const msg     = document.getElementById('pwMsg');
  if (!newPw)           { msg.style.color='#dc2626'; msg.textContent='새 비밀번호를 입력하세요.'; return; }
  if (newPw !== confirm) { msg.style.color='#dc2626'; msg.textContent='비밀번호가 일치하지 않습니다.'; return; }
  const curOk = await verifyAdmin(curPw);
  if (!curOk) { msg.style.color='#dc2626'; msg.textContent='현재 비밀번호가 올바르지 않습니다.'; return; }
  const newHash = await sha256(newPw);
  G.settings.admin_pw_hash = newHash;
  if (DB.isReady()) await DB.setSetting('admin_pw_hash', newHash, '관리자');
  msg.style.color='#16a34a'; msg.textContent='비밀번호가 변경되었습니다.';
  ['currentPw','newPw','newPwConfirm'].forEach(id => document.getElementById(id).value='');
});

document.getElementById('btnViewDlLog').addEventListener('click', () => {
  openAdminModal('다운로드 로그 조회를 위해 관리자 인증이 필요합니다.', async (name, pw) => {
    const ok = await verifyAdmin(pw);
    if (!ok) return '비밀번호가 올바르지 않습니다.';
    const logs = DB.isReady() ? await DB.getDownloadLog() : [];
    const cont = document.getElementById('dlLogContent');
    if (!logs.length) { cont.innerHTML = '<p style="color:#94a3b8;font-size:13px">로그가 없습니다.</p>'; return null; }
    cont.innerHTML = `<table class="hist-table" style="width:100%">
      <thead><tr><th>일시</th><th>구분</th><th>이름</th><th>IP</th><th>건수</th></tr></thead>
      <tbody>${logs.map(l=>`<tr>
        <td>${new Date(l.created_at).toLocaleString('ko-KR')}</td>
        <td>${l.action_type}</td><td style="font-weight:600">${l.actor_name}</td>
        <td style="font-size:11px;color:#94a3b8">${l.ip_address||'—'}</td>
        <td>${l.item_count||'—'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
    return null;
  });
});

// ============================================================
// 데이터 업로드 탭
// ============================================================
const APP = window.APP = {

  // ── 발주검토 템플릿 다운로드 (Excel .xlsx)
  downloadTemplate() {
    const wb = XLSX.utils.book_new();

    // ── 시트1: 데이터 입력 ──────────────────────────────────
    const note    = ['※ * 표시 항목은 필수입력. 1행(이 안내문)과 2행(헤더)은 절대 삭제 금지. 3행부터 데이터를 입력하세요.'];
    const headers = ['품목코드*','품목명*','규격','구매처','재고수량*','입고예정수량','리드타임(일)','안전재고','전년월평균판매량','당년월평균판매량*','판매추이'];
    const rows    = [note, headers];
    // 빈 입력 행 20개
    for (let i = 0; i < 20; i++) rows.push(Array(headers.length).fill(''));

    const ws1 = XLSX.utils.aoa_to_sheet(rows);
    ws1['!cols'] = [{wch:15},{wch:36},{wch:28},{wch:36},{wch:12},{wch:14},{wch:13},{wch:12},{wch:18},{wch:18},{wch:10}];
    ws1['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:headers.length-1} }];
    XLSX.utils.book_append_sheet(wb, ws1, '데이터입력');

    // ── 시트2: 작성 안내 ────────────────────────────────────
    const guide = [
      ['OJC 수입품목 발주 검토 — 데이터 입력 템플릿 작성 안내'],
      [''],
      ['컬럼명','필수여부','설명','예시값'],
      ['품목코드','★필수','고유 품목 코드 (변경 금지)','14-K-362'],
      ['품목명','★필수','품목 이름','PIGTAIL-SC/PC-SM-1C (0.9mm)'],
      ['규격','선택','규격 또는 사양 (없으면 빈칸)','1.5M'],
      ['구매처','선택','수입 구매처 회사명','Fiberwit Link Communication Co.,LTD'],
      ['재고수량','★필수','현재 창고 재고 수량 (마이너스 가능)','15293'],
      ['입고예정수량','선택','이미 발주하여 입고 예정인 수량','20000'],
      ['리드타임(일)','선택','발주 후 입고까지 걸리는 일수 (미입력 시 60일 적용)','60'],
      ['안전재고','선택','최소 유지해야 할 재고 수량','11376'],
      ['전년월평균판매량','선택','전년도 월 평균 판매 수량','3792'],
      ['당년월평균판매량','★필수','현재 연도 월 평균 판매 수량','1073'],
      ['판매추이','선택','"증가" 또는 "감소" 텍스트 입력','감소'],
      [''],
      ['★ 자동 계산 항목 (직접 입력 불필요)'],
      ['항목','계산 공식'],
      ['가용재고(월)','재고수량 ÷ 당년월평균판매량'],
      ['입고포함 가용재고(월)','(재고수량+입고예정수량) ÷ 당년월평균판매량'],
      ['권장발주량','(목표재고 6개월 × 월평균) − 현재고 − 입고예정'],
      ['긴급도','가용재고 2개월 미만=즉시발주 / 2~4개월=발주검토 / 4개월 이상=여유'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(guide);
    ws2['!cols'] = [{wch:20},{wch:10},{wch:50},{wch:40}];
    ws2['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c:3} },
      { s:{r:14,c:0}, e:{r:14,c:3} },
    ];
    XLSX.utils.book_append_sheet(wb, ws2, '작성안내');

    XLSX.writeFile(wb, 'OJC_발주검토_입력템플릿.xlsx');
    showToast('발주검토 템플릿 다운로드 완료 (Excel)');
  },

  // ── 가격 템플릿 다운로드 (Excel .xlsx)
  downloadPriceTemplate() {
    const wb = XLSX.utils.book_new();

    const note    = ['※ * 표시 항목은 필수. 1행(안내)·2행(헤더) 삭제 금지. 가격 항목은 아는 것만 입력 (빈칸 허용).'];
    const headers = ['품목코드*','품목명','수입가격','맥산생산원가','생산원가','표준원가비율(선택)'];
    const rows    = [note, headers];
    for (let i = 0; i < 20; i++) rows.push(Array(headers.length).fill(''));

    const ws1 = XLSX.utils.aoa_to_sheet(rows);
    ws1['!cols'] = [{wch:15},{wch:36},{wch:14},{wch:16},{wch:14},{wch:18}];
    ws1['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:headers.length-1} }];
    XLSX.utils.book_append_sheet(wb, ws1, '가격입력');

    const guide = [
      ['OJC 수입품목 가격 관리 — 가격 입력 템플릿 작성 안내'],
      [''],
      ['컬럼명','설명','예시'],
      ['품목코드','★필수 / 품목 고유 코드','14-K-362'],
      ['품목명','선택 / 입력 시 이름 자동 갱신','PIGTAIL-SC/PC'],
      ['수입가격','수입 단가 (원화 기준)','1200'],
      ['맥산생산원가','맥산에서 생산 시 원가 (원화)','1000'],
      ['생산원가','내부 생산원가 (원화)','850'],
      ['표준원가비율','선택 / 표준원가 = 생산원가 × 비율\n빈칸이면 전역 설정값 자동 사용','1.15'],
      [''],
      ['★ 표준원가는 업로드 후 앱에서 자동 계산됩니다'],
      ['원가비교 기준: 수입가격 < 표준원가 → 수입유리 / 수입가격 ≥ 표준원가 → 생산유리'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(guide);
    ws2['!cols'] = [{wch:18},{wch:50},{wch:30}];
    ws2['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c:2} },
      { s:{r:9,c:0}, e:{r:9,c:2} },
      { s:{r:10,c:0}, e:{r:10,c:2} },
      { s:{r:11,c:0}, e:{r:11,c:2} },
    ];
    XLSX.utils.book_append_sheet(wb, ws2, '작성안내');

    XLSX.writeFile(wb, 'OJC_가격_입력템플릿.xlsx');
    showToast('가격 템플릿 다운로드 완료 (Excel)');
  },
};

// ── 파일 파싱 (SheetJS)
async function parseFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb  = XLSX.read(e.target.result, {type:'array', cellDates:true});
        const ws  = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
        resolve(raw);
      } catch { showToast('파일 파싱 오류. xlsx·csv 형식을 확인하세요.'); resolve(null); }
    };
    reader.readAsArrayBuffer(file);
  });
}

// ── 업로드 파일 선택
document.getElementById('uploadFileInput').addEventListener('change', async function() {
  const file = this.files[0]; if (!file) return;
  const raw = await parseFile(file); if (!raw) { this.value=''; return; }

  // 헤더 행 찾기: '품목코드' 포함 행 (★ / * 등 특수문자 제거 후 비교)
  const hIdx = raw.findIndex(r =>
    r.some(c => String(c).replace(/[*★\s]/g,'').includes('품목코드'))
  );
  if (hIdx < 0) {
    showToast('헤더에 "품목코드" 컬럼이 없습니다. 다운로드한 템플릿을 사용하세요.');
    this.value = ''; return;
  }
  const headers = raw[hIdx].map(h => String(h||'').replace(/[*★]/g,'').trim());

  // 실제 데이터 행 개수 미리 계산
  const dataCount = raw.slice(hIdx+1).filter(r => {
    const code = String(r[headers.findIndex(h=>h.includes('품목코드'))]||'').trim();
    return code && !code.startsWith('※') && !code.startsWith('[');
  }).length;

  if (dataCount === 0) {
    showToast('입력된 데이터가 없습니다. 템플릿에 데이터를 입력한 후 업로드하세요.');
    this.value = ''; return;
  }

  G.uploadParsed = { raw, hIdx, headers };
  renderUploadPreview(raw, hIdx, headers, dataCount);
  document.getElementById('btnConfirmUpload').disabled = false;
  document.getElementById('uploadColMap').classList.remove('hidden');
  this.value = '';
});

function renderUploadPreview(raw, hIdx, headers, dataCount) {
  const prev = document.getElementById('uploadPreview');
  prev.classList.remove('hidden');

  // 컬럼 매핑 자동 감지 결과 표시
  const FIELD_MAP = [
    { label:'품목코드', key:'품목코드', req:true  },
    { label:'품목명',   key:'품목명',   req:true  },
    { label:'규격',     key:'규격',     req:false },
    { label:'구매처',   key:'구매처',   req:false },
    { label:'재고수량', key:'재고',     req:true  },
    { label:'입고예정', key:'입고',     req:false },
    { label:'리드타임', key:'리드',     req:false },
    { label:'안전재고', key:'안전',     req:false },
    { label:'전년판매', key:'전년',     req:false },
    { label:'당년판매', key:'당년',     req:true  },
    { label:'판매추이', key:'판매추이', req:false },
  ];
  const mapHTML = FIELD_MAP.map(f => {
    const idx = headers.findIndex(h => h.includes(f.key));
    const found = idx >= 0;
    const colName = found ? headers[idx] : '—';
    return `<div class="col-map-item">
      <label>${f.label}${f.req?' <span class="req">*필수</span>':''}</label>
      <div style="font-size:12px;padding:4px 7px;border-radius:5px;border:1px solid ${found?'#86efac':'#fca5a5'};background:${found?'#f0fdf4':'#fff5f5'};color:${found?'#166534':'#991b1b'}">
        ${found ? `✓ 열 ${idx+1}: ${colName}` : '✗ 미감지'}
      </div>
    </div>`;
  }).join('');

  // 데이터 미리보기 (첫 3행)
  const dataRows = raw.slice(hIdx+1)
    .filter(r => r.some(c => String(c).trim()))
    .filter(r => !String(r[0]||'').startsWith('※'))
    .slice(0, 3);

  prev.innerHTML = `
    <div style="padding:10px 12px;background:#eff6ff;border-bottom:1px solid #bfdbfe;font-size:12px;font-weight:600;color:var(--primary)">
      ✅ 파일 인식 완료 — 총 <strong>${dataCount}건</strong> 업로드 예정
    </div>
    <div style="padding:10px 12px">
      <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:8px">컬럼 자동 감지 결과</div>
      <div class="col-map-grid">${mapHTML}</div>
    </div>
    <div style="padding:0 12px 10px">
      <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px">데이터 미리보기 (최대 3행)</div>
      <div style="overflow-x:auto"><table>
        <thead><tr>${headers.map(h=>`<th>${h||'—'}</th>`).join('')}</tr></thead>
        <tbody>${dataRows.map(row=>`<tr>${headers.map((_,i)=>`<td>${row[i]??''}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

// ── 업로드 확정
document.getElementById('btnConfirmUpload').addEventListener('click', async () => {
  const worker = document.getElementById('uploaderName').value.trim();
  if (!worker) { showToast('작업자 이름을 입력하세요.'); return; }
  if (!G.uploadParsed) { showToast('파일을 먼저 업로드하세요.'); return; }
  const { raw, hIdx, headers } = G.uploadParsed;
  // 헤더에서 *, ★ 제거 후 키 탐색
  const ci = k => headers.findIndex(h => h.replace(/[*★]/g,'').trim().includes(k));
  const items = [];
  for (let r = hIdx+1; r < raw.length; r++) {
    const row  = raw[r];
    const code = String(row[ci('품목코드')]||'').trim();
    // 빈 행, 안내 텍스트, '[예시]' 등 스킵
    if (!code || code.startsWith('※') || code.startsWith('[') || code.startsWith('*')) continue;
    const avgP = num(row[ci('전년')]) ?? num(row[ci('avg2425')]) ?? 0;
    const avgC = num(row[ci('당년')]) ?? num(row[ci('avg26')])   ?? 0;
    const stock = num(row[ci('재고')]) ?? 0;
    const inc   = num(row[ci('입고')]) ?? 0;
    const lt    = num(row[ci('리드')]) ?? DEFAULT_LEADTIME;
    const avg   = avgC || avgP || 0;
    items.push({
      code,
      name:          String(row[ci('품목명')]||'').trim(),
      spec:          String(row[ci('규격')]||'').trim(),
      supplier:      String(row[ci('구매처')]||'').trim(),
      stock,
      incoming:      inc,
      leadtime:      lt,
      safety_stock:  num(row[ci('안전')]) ?? 0,
      avg_prev:      avgP,
      avg_cur:       avgC,
      trend:         String(row[ci('판매추이')]||'').trim(),
      avail_mo:      avg > 0 ? stock/avg : null,
      avail_mo_incl: avg > 0 ? (stock+inc)/avg : null,
    });
  }
  if (!items.length) { showToast('업로드할 품목 데이터가 없습니다.'); return; }
  if (!confirm(`${items.length}건을 업로드합니다. 기존 데이터가 교체됩니다.\n작업자: ${worker}`)) return;
  if (DB.isReady()) {
    const res = await DB.uploadItems(items, worker, G.clientIP);
    if (res.error) { showToast('업로드 오류: ' + res.error); return; }
  }
  G.items = items.map(normalizeItem);
  G.uploadParsed = null;
  document.getElementById('uploadPreview').classList.add('hidden');
  document.getElementById('uploadColMap').classList.add('hidden');
  document.getElementById('btnConfirmUpload').disabled = true;
  document.getElementById('uploaderName').value = '';
  updateStats(); renderTable(); renderCostTab();
  await loadUploadHistory();
  showToast(`✅ ${items.length}건 업로드 완료 (${worker})`);
});

async function loadUploadHistory() {
  const list = document.getElementById('uploadHistoryList');
  if (!DB.isReady()) { list.innerHTML = '<p style="font-size:12px;color:#94a3b8">Supabase 연결 후 이력이 표시됩니다.</p>'; return; }
  const sessions = await DB.getUploadSessions('item_data');
  list.innerHTML = sessions.map(s => `
    <div class="hist-row">
      <span class="hist-type">${s.session_type==='item_data'?'품목':'가격'}</span>
      <span class="hist-name">${s.uploader_name}</span>
      <span>${s.row_count}건</span>
      <span style="font-size:10px;color:#94a3b8">${s.ip_address||'—'}</span>
      <span class="hist-ts">${new Date(s.created_at).toLocaleString('ko-KR')}</span>
      ${s.is_active?'<span style="font-size:10px;background:#d1fae5;color:#065f46;border-radius:10px;padding:1px 7px">현재</span>':''}
    </div>`).join('') || '<p style="font-size:12px;color:#94a3b8">업로드 이력 없음</p>';
}

// ── Dropzone 드래그앤드롭
const dz = document.getElementById('dropzone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', async e => {
  e.preventDefault(); dz.classList.remove('drag');
  const file = e.dataTransfer.files[0]; if (!file) return;
  const inp  = document.getElementById('uploadFileInput');
  const dt   = new DataTransfer(); dt.items.add(file); inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
});

// ============================================================
// 유틸
// ============================================================
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}
function setHeaderSub(txt) { document.getElementById('headerSub').textContent = txt; }
function updateSyncBadge(ok) {
  const el = document.getElementById('syncStatus');
  el.className = 'sync-badge ' + (ok ? 'sync-ready' : 'sync-offline');
  el.textContent = ok ? '☁ 연결됨' : '☁ 오프라인';
}

function setFilter(f) {
  G.curFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter===f));
  document.querySelectorAll('.stat-card').forEach(c => c.classList.toggle('active', c.dataset.filter===f));
  renderTable();
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById('tab-' + tab).classList.remove('hidden');
  if (tab==='confirmed') renderConfirmedTab();
  if (tab==='incoming')  renderIncomingTab();
  if (tab==='cost')      renderCostTab(document.getElementById('costSearch').value);
  if (tab==='upload')    loadUploadHistory();
  if (tab==='sync')      loadSyncSettings();
}

function loadSyncSettings() {
  document.getElementById('sbUrl').value = localStorage.getItem('ojc_sb_url') || SB_URL || '';
  document.getElementById('sbKey').value = localStorage.getItem('ojc_sb_key') || SB_ANON_KEY || '';
  const box = document.getElementById('syncConnStatus');
  if (DB.isReady()) {
    box.className = 'sync-status-box sync-ok';
    box.textContent = '✅ Supabase에 정상 연결되어 있습니다. 모든 데이터가 클라우드에 자동 저장됩니다.';
  } else {
    box.className = 'sync-status-box sync-err';
    box.textContent = '⚠ Supabase 미연결 상태입니다. URL과 Anon Key를 입력 후 저장하세요.';
  }
}

// ============================================================
// 정렬 헤더
// ============================================================
function initSort() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (G.sortCol===col) G.sortDir = G.sortDir==='asc'?'desc':'asc';
      else { G.sortCol=col; G.sortDir='asc'; }
      document.querySelectorAll('th.sortable').forEach(h => h.classList.remove('sort-asc','sort-desc'));
      th.classList.add(G.sortDir==='asc'?'sort-asc':'sort-desc');
      renderTable();
    });
  });
}

// ============================================================
// 저장 / 초기화
// ============================================================
document.getElementById('btnSave').addEventListener('click', () => {
  if (!DB.isReady()) localStorage.setItem('ojc_order_plan', JSON.stringify(G.orderPlan));
  showToast('저장 완료');
});
document.getElementById('btnReset').addEventListener('click', () => {
  if (!confirm('모든 발주 확정 및 수량 입력을 초기화하겠습니까?')) return;
  G.orderPlan = {};
  if (DB.isReady()) {
    // order_plan은 각 항목별로 is_confirmed=false로 업데이트 (간단히 로컬만 초기화)
  }
  localStorage.removeItem('ojc_order_plan');
  updateStats(); renderTable(); renderConfirmedTab();
  showToast('초기화 완료');
});

// ============================================================
// 구매처 셀렉트 빌드
// ============================================================
function buildSupplierSelect() {
  const sel  = document.getElementById('supplierFilter');
  const sups = [...new Set(G.items.map(i=>i.supplier))].filter(Boolean).sort();
  sel.innerHTML = '<option value="">전체 구매처</option>';
  sups.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = SUP_SHORT[s]||s; sel.appendChild(o);
  });
}

// ============================================================
// 초기화
// ============================================================
async function init() {
  // Supabase 설정 — localStorage 우선, 없으면 config.js 값
  const savedUrl = localStorage.getItem('ojc_sb_url') || SB_URL;
  const savedKey = localStorage.getItem('ojc_sb_key') || SB_ANON_KEY;
  if (savedUrl && savedKey) {
    // config.js의 전역 변수를 덮어쓰는 방식으로 db.js init 호출
    Object.assign(window, { SB_URL: savedUrl, SB_ANON_KEY: savedKey });
  }
  DB.init();
  await fetchIP();
  await loadData();
  buildSupplierSelect();
  initSort();

  // 통계카드 클릭
  document.querySelectorAll('.stat-card').forEach(c =>
    c.addEventListener('click', () => { switchTab('plan'); setFilter(c.dataset.filter); })
  );
  // 필터버튼
  document.querySelectorAll('.filter-btn').forEach(b =>
    b.addEventListener('click', () => setFilter(b.dataset.filter))
  );
  // 탭버튼
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );
  // 셀렉트 필터
  document.getElementById('supplierFilter').addEventListener('change', e => { G.curSupplier=e.target.value; renderTable(); });
  document.getElementById('trendFilter').addEventListener('change',    e => { G.curTrend=e.target.value;    renderTable(); });
  // 검색
  document.getElementById('searchBox').addEventListener('input', e => { G.curSearch=e.target.value.trim(); renderTable(); });
  document.getElementById('costSearch').addEventListener('input', e => renderCostTab(e.target.value.trim()));
  // 원가 칼럼 토글
  document.getElementById('showCostCols').addEventListener('change', function() { G.showCost=this.checked; renderTable(); });
  // 발주확정 (벌크)
  document.getElementById('btnBulkConfirm').addEventListener('click', () => {
    const checked = [...document.querySelectorAll('.chk-conf:checked')]
      .map(c=>c.dataset.code).filter(code=>!G.orderPlan[code]?.is_confirmed);
    checked.forEach(code => {
      if (!G.orderPlan[code]) G.orderPlan[code]={};
      G.orderPlan[code].is_confirmed=true;
      if (DB.isReady()) DB.saveOrderPlan(code, G.orderPlan[code].order_qty??0, true, '일괄확정', G.clientIP).catch(()=>{});
    });
    updateStats(); renderTable(); renderConfirmedTab();
    document.getElementById('bulkBar').classList.remove('show');
    showToast(`${checked.length}건 발주 확정`);
  });
  document.getElementById('btnBulkCancel').addEventListener('click', () => {
    document.querySelectorAll('.chk-conf').forEach(c => { if (!G.orderPlan[c.dataset.code]?.is_confirmed) c.checked=false; });
    document.getElementById('bulkBar').classList.remove('show');
  });
  // 체크박스 변화 감지 (벌크바 표시)
  document.getElementById('tbodyMain').addEventListener('change', e => {
    if (!e.target.classList.contains('chk-conf')) return;
    const sel = [...document.querySelectorAll('.chk-conf:checked')]
      .filter(c => !G.orderPlan[c.dataset.code]?.is_confirmed);
    const bar = document.getElementById('bulkBar');
    if (sel.length) { bar.classList.add('show'); document.getElementById('bulkCount').textContent=`${sel.length}건 선택됨`; }
    else bar.classList.remove('show');
  });
  // 전체선택
  document.getElementById('chkAll').addEventListener('change', function() {
    document.querySelectorAll('.chk-conf').forEach(c => { if (!G.orderPlan[c.dataset.code]?.is_confirmed) c.checked=this.checked; });
    const sel = this.checked ? [...document.querySelectorAll('.chk-conf:checked')]
      .filter(c=>!G.orderPlan[c.dataset.code]?.is_confirmed).length : 0;
    const bar = document.getElementById('bulkBar');
    if (sel) { bar.classList.add('show'); document.getElementById('bulkCount').textContent=`${sel}건 선택됨`; }
    else bar.classList.remove('show');
  });
  // 발주확정 탭 export
  document.getElementById('btnExportConfirm').addEventListener('click', exportConfirmCSV);
  // 초기 정렬 표시
  const urgTh = document.querySelector('th[data-col="urgency"]');
  if (urgTh) urgTh.classList.add('sort-asc');
}

document.addEventListener('DOMContentLoaded', init);
