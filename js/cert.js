'use strict';
// ============================================================
// cert.js — 성적서 자동 생성기
// ============================================================

const CERT = (() => {

  let _items   = [];   // 생성 대상 항목
  let _srcFile = null; // 파일 업로드 시 원본 파일명

  // ── 분류 규칙 ──────────────────────────────────────────────
  const isMM      = n => /-MM[-( ]/i.test(n || '');
  const isFot     = s => (s || '').includes('_포엔티');
  const isSungdan = (n, s) =>
    (n || '').includes('성단용') || (s || '').includes('성단용');

  function classify(name, spec) {
    if (isMM(name))          return 'MM';
    if (isSungdan(name, spec)) return '성단용';
    return 'SM';
  }

  // ── 유형별 성적 기준값 ──────────────────────────────────────
  const SPECS = {
    SM: [
      ['삽입손실',        '≤ 0.2 dB'],
      ['반사손실 (PC)',   '≥ 50 dB'],
      ['반사손실 (APC)', '≥ 60 dB'],
    ],
    MM: [
      ['삽입손실 (MM)', '≤ 0.5 dB'],
      ['반사손실',       '≥ 20 dB'],
    ],
    '성단용': [
      ['삽입손실',        '≤ 0.1 dB'],
      ['반사손실 (PC)',   '≥ 55 dB'],
      ['반사손실 (APC)', '≥ 65 dB'],
    ],
  };

  // ── 발주 확정 목록에서 불러오기 ────────────────────────────
  function loadFromApp() {
    if (typeof G === 'undefined') {
      showToast('앱 데이터가 로드되지 않았습니다.');
      return;
    }
    const confirmed = G.items.filter(it => G.orderPlan[it.code]?.is_confirmed);
    if (!confirmed.length) {
      showToast('발주 확정된 항목이 없습니다. 발주 계획 탭에서 확정 후 사용하세요.');
      return;
    }
    _srcFile = null;
    _items = confirmed.map((it, i) => ({
      no:   i + 1,
      code: it.code  || '',
      name: it.name  || '',
      spec: it.spec  || '',
      qty:  G.orderPlan[it.code]?.order_qty || 0,
      type: classify(it.name, it.spec),
      fot:  isFot(it.spec),
    }));
    renderPreview();
    showToast(`${_items.length}건을 불러왔습니다.`);
  }

  // ── 파일 업로드 처리 ───────────────────────────────────────
  function handleFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const sn = wb.SheetNames.find(n => /발주계획|계획/.test(n)) || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '' });
        _srcFile = file.name;
        _items = rows
          .map((r, i) => {
            const code = String(r['품목코드'] || r['code'] || '').trim();
            const name = String(r['품목명']   || r['name'] || '').trim();
            const spec = String(r['규격']     || r['spec'] || '').trim();
            const qty  = Number(r['발주수량'] || r['수량']  || 0);
            if (!code) return null;
            return { no: i + 1, code, name, spec, qty, type: classify(name, spec), fot: isFot(spec) };
          })
          .filter(Boolean);
        renderPreview();
        showToast(`${_items.length}건 파싱됨`);
      } catch (err) {
        showToast('파일 파싱 실패: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ── 미리보기 렌더링 ────────────────────────────────────────
  function renderPreview() {
    const el  = document.getElementById('certPreviewArea');
    const btn = document.getElementById('btnGenerateCert');
    if (!el) return;

    if (!_items.length) {
      el.innerHTML = '<p style="text-align:center;padding:36px;color:#94a3b8">불러온 항목이 없습니다.</p>';
      if (btn) btn.disabled = true;
      return;
    }

    const typeBg  = { SM: '#dbeafe', MM: '#fef3c7', '성단용': '#dcfce7' };
    const typeFg  = { SM: '#1d4ed8', MM: '#92400e', '성단용': '#166534' };

    el.innerHTML = `
      <div style="font-size:12px;color:#64748b;margin-bottom:8px">
        총 <b>${_items.length}</b>건 · 성적서 생성 대상
        ${_srcFile ? `<span style="margin-left:8px;color:#94a3b8">(파일: ${_srcFile})</span>` : ''}
      </div>
      <div style="overflow:auto;max-height:320px;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#f8fafc;position:sticky;top:0;z-index:1">
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:32px">#</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:120px;text-align:left">품목코드</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);text-align:left">품목명</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);text-align:left">규격</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:60px;text-align:right">수량</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:64px;text-align:center">유형</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:44px;text-align:center">포스터</th>
          </tr></thead>
          <tbody>${_items.map(it => `
            <tr style="border-bottom:1px solid #f1f5f9">
              <td style="padding:5px 8px;text-align:center;color:#94a3b8">${it.no}</td>
              <td style="padding:5px 8px;font-family:monospace;font-size:11px">${it.code}</td>
              <td style="padding:5px 8px">${it.name}</td>
              <td style="padding:5px 8px;color:#64748b;font-size:11px">${it.spec}</td>
              <td style="padding:5px 8px;text-align:right">${Number(it.qty).toLocaleString()}</td>
              <td style="padding:5px 8px;text-align:center">
                <span style="background:${typeBg[it.type]||'#f1f5f9'};color:${typeFg[it.type]||'#475569'};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">${it.type}</span>
              </td>
              <td style="padding:5px 8px;text-align:center;color:#16a34a">${it.fot ? '✓' : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    if (btn) btn.disabled = false;
  }

  // ── SheetJS 헬퍼 ──────────────────────────────────────────
  function mkCell(v, s) {
    return { v, t: typeof v === 'number' ? 'n' : 's', s };
  }

  function merge(ws, r0, c0, r1, c1) {
    if (!ws['!merges']) ws['!merges'] = [];
    ws['!merges'].push({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } });
  }

  function setR(ws, R, cells) {
    // cells: { col: [value, style], ... }  col = 'A','B',...
    for (const [col, [v, s]] of Object.entries(cells)) {
      ws[col + R] = mkCell(v, s);
    }
  }

  // ── 셀 스타일 정의 ────────────────────────────────────────
  const BDR = (style = 'thin', rgb = 'CCCCCC') => ({
    top: { style, color: { rgb } }, bottom: { style, color: { rgb } },
    left: { style, color: { rgb } }, right: { style, color: { rgb } },
  });
  const AL = (h = 'center', v = 'center', wrap = false) => ({
    horizontal: h, vertical: v, wrapText: wrap,
  });

  const S = {
    title: {
      font: { bold: true, sz: 13, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '1E3A5F' } },
      alignment: AL('center', 'center'),
      border: BDR('medium', '1E3A5F'),
    },
    th: {
      font: { bold: true, sz: 9, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '1E3A5F' } },
      alignment: AL(),
      border: BDR('thin', '1E3A5F'),
    },
    label: {
      font: { bold: true, sz: 9 },
      fill: { fgColor: { rgb: 'EFF6FF' } },
      alignment: AL(),
      border: BDR(),
    },
    value: {
      font: { sz: 9 },
      alignment: AL('left'),
      border: BDR(),
    },
    boldVal: {
      font: { bold: true, sz: 9 },
      alignment: AL('left'),
      border: BDR(),
    },
    numVal: {
      font: { sz: 9 },
      alignment: AL('center'),
      border: BDR(),
    },
    pass: {
      font: { bold: true, sz: 9, color: { rgb: '166534' } },
      fill: { fgColor: { rgb: 'DCFCE7' } },
      alignment: AL(),
      border: BDR('thin', '86EFAC'),
    },
    passTotal: {
      font: { bold: true, sz: 11, color: { rgb: '166534' } },
      fill: { fgColor: { rgb: 'DCFCE7' } },
      alignment: AL(),
      border: BDR('medium', '166534'),
    },
    typeStyle(type) {
      const map = {
        SM:    { font: { bold: true, sz: 9, color: { rgb: '1D4ED8' } }, fill: { fgColor: { rgb: 'DBEAFE' } }, alignment: AL(), border: BDR() },
        MM:    { font: { bold: true, sz: 9, color: { rgb: '92400E' } }, fill: { fgColor: { rgb: 'FEF3C7' } }, alignment: AL(), border: BDR() },
        '성단용': { font: { bold: true, sz: 9, color: { rgb: '166534' } }, fill: { fgColor: { rgb: 'DCFCE7' } }, alignment: AL(), border: BDR() },
      };
      return map[type] || S.value;
    },
  };

  // ── 블록 작성 (품목 1건 = 블록 1개) ───────────────────────
  function writeBlock(ws, startRow, item, dateStr) {
    let R = startRow;
    const specs = SPECS[item.type] || SPECS.SM;

    // ① 제목 (merged A:H)
    ws['A' + R] = mkCell('품  목  성  적  서', S.title);
    merge(ws, R-1, 0, R-1, 7);
    R++;

    // ② 품목코드 / 발주수량 / 작성일자
    setR(ws, R, {
      A: ['품 목 코 드', S.label],
      B: [item.code,    S.boldVal],  // B:C merged
      C: ['',           S.value],
      D: ['발 주 수 량', S.label],
      E: [item.qty,     S.numVal],   // E:F merged
      F: ['',           S.numVal],
      G: ['작 성 일 자', S.label],
      H: [dateStr,      S.value],
    });
    merge(ws, R-1, 1, R-1, 2);
    merge(ws, R-1, 4, R-1, 5);
    R++;

    // ③ 품목명 / 유형
    setR(ws, R, {
      A: ['품  목  명', S.label],
      B: [item.name,   S.boldVal],  // B:F merged
      C: ['',          S.value],
      D: ['',          S.value],
      E: ['',          S.value],
      F: ['',          S.value],
      G: ['유  형',    S.label],
      H: [item.type,   S.typeStyle(item.type)],
    });
    merge(ws, R-1, 1, R-1, 5);
    R++;

    // ④ 규격 (merged B:H)
    setR(ws, R, {
      A: ['규  격',  S.label],
      B: [item.spec, S.value],
      C: ['',        S.value],
      D: ['',        S.value],
      E: ['',        S.value],
      F: ['',        S.value],
      G: ['',        S.value],
      H: ['',        S.value],
    });
    merge(ws, R-1, 1, R-1, 7);
    R++;

    // ⑤ 성적 헤더
    setR(ws, R, {
      A: ['항  목',   S.th],
      B: ['',         S.th],
      C: ['기 준 값', S.th],
      D: ['',         S.th],
      E: ['측 정 값', S.th],
      F: ['',         S.th],
      G: ['판  정',   S.th],
      H: ['',         S.th],
    });
    merge(ws, R-1, 0, R-1, 1);
    merge(ws, R-1, 2, R-1, 3);
    merge(ws, R-1, 4, R-1, 5);
    merge(ws, R-1, 6, R-1, 7);
    R++;

    // ⑥ 성적 항목들
    specs.forEach(([label, limit]) => {
      setR(ws, R, {
        A: [label, S.label],
        B: ['',    S.label],
        C: [limit, S.value],
        D: ['',    S.value],
        E: ['',    S.value],
        F: ['',    S.value],
        G: ['PASS', S.pass],
        H: ['',    S.pass],
      });
      merge(ws, R-1, 0, R-1, 1);
      merge(ws, R-1, 2, R-1, 3);
      merge(ws, R-1, 4, R-1, 5);
      merge(ws, R-1, 6, R-1, 7);
      R++;
    });

    // ⑦ 포스터 추가행
    if (item.fot) {
      setR(ws, R, {
        A: ['제 조 사',    S.label],
        B: ['(주)에이제이월드', S.value],
        C: ['',           S.value],
        D: ['',           S.value],
        E: ['연 락 처',   S.label],
        F: ['',           S.label],
        G: ['',           S.value],
        H: ['',           S.value],
      });
      merge(ws, R-1, 1, R-1, 3);
      merge(ws, R-1, 4, R-1, 5);
      merge(ws, R-1, 6, R-1, 7);
      R++;
    }

    // ⑧ 최종판정
    setR(ws, R, {
      A: ['최 종 판 정', S.th],
      B: ['PASS',        S.passTotal],
      C: ['',            S.passTotal],
      D: ['',            S.passTotal],
      E: ['',            S.passTotal],
      F: ['',            S.passTotal],
      G: ['',            S.passTotal],
      H: ['',            S.passTotal],
    });
    merge(ws, R-1, 1, R-1, 7);
    R++;

    // ⑨ 구분 빈 행
    R++;

    return R;
  }

  // ── 성적서 Excel 생성 ─────────────────────────────────────
  function generate() {
    if (!_items.length) {
      showToast('항목이 없습니다. 먼저 데이터를 불러오세요.');
      return;
    }

    const today   = new Date();
    const dateStr = `${today.getFullYear()}.${String(today.getMonth()+1).padStart(2,'0')}.${String(today.getDate()).padStart(2,'0')}`;
    const dateTag = dateStr.replace(/\./g, '');

    const wb = XLSX.utils.book_new();
    const ws = {};

    let row = 1;
    _items.forEach(item => {
      row = writeBlock(ws, row, item, dateStr);
    });

    ws['!ref']  = `A1:H${row}`;
    ws['!cols'] = [
      { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 12 },
      { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 18 },
    ];

    XLSX.utils.book_append_sheet(wb, ws, '성적서');

    const fname = _srcFile
      ? _srcFile.replace(/\.xlsx?$/i, '_성적서.xlsx')
      : `성적서_${dateTag}.xlsx`;

    try {
      XLSX.writeFile(wb, fname, { cellStyles: true });
    } catch {
      XLSX.writeFile(wb, fname);
    }

    showToast(`성적서 생성 완료: ${fname}`);
  }

  // ── 탭 초기화 (이벤트 등록) ───────────────────────────────
  function initTab() {
    const dz = document.getElementById('certDropzone');
    const fi = document.getElementById('certFileInput');
    if (!dz || fi?._certInited) return;
    if (fi) fi._certInited = true;

    if (dz) {
      dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', ()  => dz.classList.remove('drag'));
      dz.addEventListener('drop', e => {
        e.preventDefault();
        dz.classList.remove('drag');
        const f = e.dataTransfer.files[0];
        if (f) handleFile(f);
      });
    }
    if (fi) {
      fi.addEventListener('change', () => { if (fi.files[0]) handleFile(fi.files[0]); });
    }
  }

  return { loadFromApp, handleFile, generate, renderPreview, initTab };
})();
