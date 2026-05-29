'use strict';

// ── 구매처 약칭 매핑
const SUPPLIER_SHORT = {
  'Fiberwit Link Communication Co.,LTD': 'Fiberwit',
  'Shenzhen Fibercan Optical Co., Ltd': 'Fibercan',
  'Huizhou Fibercan Industrial Co.,Ltd': 'Fibercan(HZ)',
  'CFOFC Communications (Shenzhen) Co., Ltd': 'CFOFC',
  'Henan Shijia Photons Technology Co.,Ltd': 'Shijia',
};

// ── 수치 파싱 (빈값, '-' 처리)
function parseNum(v) {
  if (!v || v === '-' || v === '') return null;
  const n = parseFloat(String(v).replace(/[,\s]/g, ''));
  return isNaN(n) ? null : n;
}

function fmt(v, decimals = 0) {
  if (v === null || v === undefined || v === '') return '-';
  const n = parseNum(String(v));
  if (n === null) return v;
  return n.toLocaleString('ko-KR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtMo(v) {
  const n = parseNum(v);
  if (n === null) return '<span class="avail-na">-</span>';
  if (n < 0) return `<span class="avail-danger">${n.toFixed(1)}</span>`;
  if (n < 2) return `<span class="avail-danger">${n.toFixed(1)}</span>`;
  if (n < 3) return `<span class="avail-warning">${n.toFixed(1)}</span>`;
  return `<span class="avail-ok">${n.toFixed(1)}</span>`;
}

// ── 가용재고 위험 판단
function isDanger(item) {
  const v = parseNum(item.availMo);
  return v !== null && v < 2;
}

function hasOrder(item) {
  return item.orderQty && item.orderQty !== '-' && item.orderQty !== '';
}

// ── 상태
let curFilter = 'all';
let curSearch = '';
let curSupplier = '';
let curOrderFilter = '';
let sortCol = '';
let sortDir = 'asc';

// ── 구매처 목록 구성
function buildSupplierList() {
  const set = new Set(RAW_DATA.map(d => d.supplier).filter(Boolean));
  const sel = document.getElementById('supplierFilter');
  [...set].sort().forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = SUPPLIER_SHORT[s] || s;
    sel.appendChild(opt);
  });
}

// ── 필터 적용
function getFiltered() {
  return RAW_DATA.filter(item => {
    if (curFilter === 'order'  && !hasOrder(item))    return false;
    if (curFilter === 'danger' && !isDanger(item))    return false;
    if (curFilter === 'inc'    && item.trend.trim() !== '증가') return false;
    if (curFilter === 'dec'    && item.trend.trim() !== '감소') return false;
    if (curSupplier && item.supplier !== curSupplier) return false;
    if (curOrderFilter === 'hasOrder' && !hasOrder(item)) return false;
    if (curOrderFilter === 'noOrder'  &&  hasOrder(item)) return false;
    if (curSearch) {
      const q = curSearch.toLowerCase();
      if (!item.code.toLowerCase().includes(q) && !item.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

// ── 정렬
function getSorted(rows) {
  if (!sortCol) return rows;
  return [...rows].sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    const na = parseNum(va), nb = parseNum(vb);
    let cmp;
    if (na !== null && nb !== null) cmp = na - nb;
    else cmp = String(va || '').localeCompare(String(vb || ''), 'ko');
    return sortDir === 'asc' ? cmp : -cmp;
  });
}

// ── 통계 업데이트
function updateStats() {
  document.getElementById('cnt-all').textContent    = RAW_DATA.length;
  document.getElementById('cnt-order').textContent  = RAW_DATA.filter(hasOrder).length;
  document.getElementById('cnt-danger').textContent = RAW_DATA.filter(isDanger).length;
  document.getElementById('cnt-inc').textContent    = RAW_DATA.filter(i => i.trend.trim() === '증가').length;
  document.getElementById('cnt-dec').textContent    = RAW_DATA.filter(i => i.trend.trim() === '감소').length;
}

// ── 테이블 렌더
function renderTable() {
  const rows = getSorted(getFiltered());
  const tbody = document.getElementById('tbodyMain');
  const empty = document.getElementById('emptyMsg');
  const info  = document.getElementById('resultInfo');

  info.textContent = `${rows.length}건 표시 중 (전체 ${RAW_DATA.length}건)`;

  if (!rows.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = rows.map((item, idx) => {
    const trendBadge = item.trend.trim() === '증가'
      ? `<span class="badge-inc">↑ 증가</span>`
      : item.trend.trim() === '감소'
        ? `<span class="badge-dec">↓ 감소</span>`
        : `<span>${item.trend}</span>`;

    const supShort = SUPPLIER_SHORT[item.supplier] || item.supplier.split(' ')[0];
    const supCell = `<span class="sup-tag">${supShort}</span>`;

    const orderCell = hasOrder(item)
      ? `<span class="order-qty">${fmt(item.orderQty)}</span>`
      : `<span class="order-qty-empty">-</span>`;

    const rowClass = isDanger(item) ? 'row-danger'
      : (parseNum(item.availMo) !== null && parseNum(item.availMo) < 3) ? 'row-warning'
      : '';

    return `<tr class="${rowClass}">
      <td class="td-center">${idx + 1}</td>
      <td class="td-code">${item.code}</td>
      <td class="td-name">${item.name}</td>
      <td class="td-spec">${item.spec || '-'}</td>
      <td class="td-center">${supCell}</td>
      <td class="td-num">${fmt(item.avg26)}</td>
      <td class="td-num">${fmt(item.avg2425)}</td>
      <td class="td-center">${trendBadge}</td>
      <td class="td-center">${item.leadtime || '-'}</td>
      <td class="td-num">${fmt(item.stock)}</td>
      <td class="td-center">${fmtMo(item.availMo)}</td>
      <td class="td-num">${fmt(item.incoming)}</td>
      <td class="td-center">${fmtMo(item.availMoIncl)}</td>
      <td class="td-center">${orderCell}</td>
    </tr>`;
  }).join('');
}

// ── 필터 버튼 상태
function setFilter(f) {
  curFilter = f;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === f);
  });
  document.querySelectorAll('.stat-card').forEach(card => {
    card.classList.toggle('active', card.dataset.filter === f);
  });
  renderTable();
}

// ── 정렬 헤더
function initSortHeaders() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortCol = col;
        sortDir = 'asc';
      }
      document.querySelectorAll('th.sortable').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderTable();
    });
  });
}

// ── 토스트
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ── 날짜 표시
function setHeaderDate() {
  const d = new Date();
  document.getElementById('headerDate').textContent =
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} 기준`;
}

// ── 초기화
function init() {
  setHeaderDate();
  buildSupplierList();
  updateStats();
  initSortHeaders();

  // stat card 클릭
  document.querySelectorAll('.stat-card').forEach(card => {
    card.addEventListener('click', () => setFilter(card.dataset.filter));
  });

  // filter btn 클릭
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  });

  // 구매처 필터
  document.getElementById('supplierFilter').addEventListener('change', e => {
    curSupplier = e.target.value;
    renderTable();
  });

  // 발주예정 필터
  document.getElementById('orderFilter').addEventListener('change', e => {
    curOrderFilter = e.target.value;
    renderTable();
  });

  // 검색
  document.getElementById('searchBox').addEventListener('input', e => {
    curSearch = e.target.value.trim();
    renderTable();
  });

  // 필터 초기화
  document.getElementById('btnResetFilter').addEventListener('click', () => {
    curFilter = 'all';
    curSearch = '';
    curSupplier = '';
    curOrderFilter = '';
    sortCol = '';
    sortDir = 'asc';
    document.getElementById('searchBox').value = '';
    document.getElementById('supplierFilter').value = '';
    document.getElementById('orderFilter').value = '';
    document.querySelectorAll('th.sortable').forEach(h => h.classList.remove('sort-asc','sort-desc'));
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
    document.querySelectorAll('.stat-card').forEach(c => c.classList.toggle('active', c.dataset.filter === 'all'));
    renderTable();
    showToast('필터가 초기화되었습니다.');
  });

  renderTable();
}

document.addEventListener('DOMContentLoaded', init);
