'use strict';
// ============================================================
// cert.js — 성적서 자동 생성기
// 참고 양식 구조 반영:
//   8행 고정 · 품목별 6열(라벨1+데이터4+갭1)씩 우측 확장
//   열너비: 라벨 14.64ch · 데이터×4 11.79ch · 갭 7.5ch
//   행높이: 전 행 20.25pt
//   LINE 행: 노란 배경(FFFF00)
// ============================================================

const CERT = (() => {

  let _items   = [];
  let _srcFile = null;

  // ── 분류 ──────────────────────────────────────────────────
  const isMM  = n => /-MM[-( ]/i.test(n || '');
  const isFot = s => (s || '').includes('_포앤티');

  function classify(name) {
    return isMM(name) ? 'MM' : 'SM';
  }

  // ── 유형별 스펙 ───────────────────────────────────────────
  const SPECS = {
    SM: { il: '≤0.2dB', pc: '≥50dB', apc: '≥60dB' },
    MM: { il: '≤0.5dB', pc: '≥20dB', apc: '-'     },
  };

  // ── 발주 확정 목록에서 불러오기 ────────────────────────────
  function loadFromApp() {
    if (typeof G === 'undefined') { showToast('앱 데이터가 로드되지 않았습니다.'); return; }
    const confirmed = G.items.filter(it => G.orderPlan[it.code]?.is_confirmed);
    if (!confirmed.length) { showToast('발주 확정된 항목이 없습니다.'); return; }
    _srcFile = null;
    _items = confirmed.map((it, i) => ({
      no:   i + 1,
      code: it.code || '',
      name: it.name || '',
      spec: it.spec || '',
      qty:  G.orderPlan[it.code]?.order_qty || 0,
      type: classify(it.name),
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
        const wb   = XLSX.read(e.target.result, { type: 'array' });
        const sn   = wb.SheetNames.find(n => /발주계획|계획|발주요청|발주/.test(n)) || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '' });
        _srcFile   = file.name;
        _items = rows
          .map((r, i) => {
            const code = String(r['품목코드'] || r['code'] || '').trim();
            const name = String(r['품목명']   || r['name'] || '').trim();
            const spec = String(r['규격']     || r['spec'] || '').trim();
            const qty  = Number(r['발주수량'] || r['수량']  || 0);
            if (!code && !name) return null;
            return { no: i+1, code, name, spec, qty, type: classify(name), fot: isFot(spec) };
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

  // ── 유형 변경 (미리보기 select에서 호출) ────────────────────
  function updateType(idx, type) {
    if (_items[idx]) _items[idx].type = type;
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

    el.innerHTML = `
      <div style="font-size:12px;color:#64748b;margin-bottom:8px">
        총 <b>${_items.length}</b>건
        ${_srcFile ? `<span style="margin-left:8px;color:#94a3b8">(${_srcFile})</span>` : ''}
        <span style="margin-left:12px;color:#94a3b8;font-size:11px">유형을 클릭해 SM/MM을 변경할 수 있습니다</span>
      </div>
      <div style="overflow:auto;max-height:320px;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#f8fafc;position:sticky;top:0;z-index:1">
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:32px">#</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:120px;text-align:left">품목코드</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);text-align:left">품목명</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);text-align:left">규격</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:64px;text-align:right">발주수량</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:80px;text-align:center">유형 (수정가능)</th>
          </tr></thead>
          <tbody>${_items.map((it, i) => `
            <tr style="border-bottom:1px solid #f1f5f9">
              <td style="padding:5px 8px;text-align:center;color:#94a3b8">${it.no}</td>
              <td style="padding:5px 8px;font-family:monospace;font-size:11px">${it.code}</td>
              <td style="padding:5px 8px">${it.name}</td>
              <td style="padding:5px 8px;color:#64748b;font-size:11px">${it.spec}</td>
              <td style="padding:5px 8px;text-align:right">${Number(it.qty).toLocaleString()}</td>
              <td style="padding:5px 8px;text-align:center">
                <select onchange="CERT.updateType(${i}, this.value)"
                  style="border:1px solid var(--border);border-radius:6px;padding:2px 6px;font-size:12px;cursor:pointer;
                         background:${it.type==='MM'?'#fef3c7':'#dbeafe'};
                         color:${it.type==='MM'?'#92400e':'#1d4ed8'};font-weight:600">
                  <option value="SM" ${it.type==='SM'?'selected':''}>SM</option>
                  <option value="MM" ${it.type==='MM'?'selected':''}>MM</option>
                </select>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    if (btn) btn.disabled = false;
  }

  // ── SheetJS 헬퍼 ──────────────────────────────────────────
  const ENC = XLSX.utils.encode_cell;

  function mkCell(v, s) {
    return { v, t: typeof v === 'number' ? 'n' : 's', s };
  }

  function addMerge(ws, r0, c0, r1, c1) {
    if (!ws['!merges']) ws['!merges'] = [];
    ws['!merges'].push({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } });
  }

  // ── 셀 스타일 ─────────────────────────────────────────────
  const BDR = {
    top:    { style: 'thin', color: { rgb: '999999' } },
    bottom: { style: 'thin', color: { rgb: '999999' } },
    left:   { style: 'thin', color: { rgb: '999999' } },
    right:  { style: 'thin', color: { rgb: '999999' } },
  };

  const S = {
    line: {  // LINE 행 — 노란 배경
      fill:      { patternType: 'solid', fgColor: { rgb: 'FFFF00' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border:    BDR,
    },
    label: {  // 라벨 열
      alignment: { horizontal: 'center', vertical: 'center' },
      border:    BDR,
    },
    value: {  // 데이터 열
      alignment: { horizontal: 'center', vertical: 'center' },
      border:    BDR,
    },
    valueL: {  // 좌측 정렬 데이터 (품목명·규격)
      alignment: { horizontal: 'left', vertical: 'center' },
      border:    BDR,
    },
  };

  // ── 블록 작성 (품목 1건 = 6열 블록) ───────────────────────
  //  sc = 시작 열 인덱스 (0-based)
  //  8행 고정: r=0(LINE) ~ r=7(반사손실)
  function writeBlock(ws, sc, item, lineNum, lotNo) {
    const d = sc + 1; // 첫 번째 데이터 열
    const sp = SPECS[item.type] || SPECS.SM;

    // ── r=0: LINE  N  (노란 배경) ──
    ws[ENC({ r: 0, c: sc })] = mkCell('LINE  ' + lineNum, S.line);
    // 나머지 4 데이터 열도 노란 배경 (시각적 일관성)
    for (let i = 1; i <= 4; i++) {
      ws[ENC({ r: 0, c: sc + i })] = mkCell('', S.line);
    }

    // ── r=1~5: 라벨 | 값 (데이터 4열 병합) ──
    const infoRows = [
      [1, '품           명', item.name,            S.valueL],
      [2, '규           격', item.spec,            S.valueL],
      [3, 'L O T   N O .', lotNo,                 S.value],
      [4, '수           량', item.qty + ' 본',     S.value],
      [5, '파  장  대  역', '1310nm ~ 1630nm',    S.value],
    ];
    infoRows.forEach(([r, label, val, vStyle]) => {
      ws[ENC({ r, c: sc })] = mkCell(label, S.label);
      ws[ENC({ r, c: d  })] = mkCell(val,   vStyle);
      // 빈 병합 셀들
      ws[ENC({ r, c: d+1 })] = mkCell('', S.value);
      ws[ENC({ r, c: d+2 })] = mkCell('', S.value);
      ws[ENC({ r, c: d+3 })] = mkCell('', S.value);
      addMerge(ws, r, d, r, d + 3);
    });

    // ── r=6: 삽입손실 | 유형(병합d:d+1) | 기준(병합d+2:d+3) ──
    ws[ENC({ r: 6, c: sc   })] = mkCell('삽  입  손  실', S.label);
    ws[ENC({ r: 6, c: d    })] = mkCell(item.type,  S.value);
    ws[ENC({ r: 6, c: d+1  })] = mkCell('',         S.value);
    ws[ENC({ r: 6, c: d+2  })] = mkCell(sp.il,      S.value);
    ws[ENC({ r: 6, c: d+3  })] = mkCell('',         S.value);
    addMerge(ws, 6, d,   6, d+1);
    addMerge(ws, 6, d+2, 6, d+3);

    // ── r=7: 반사손실 | PC | 값 | APC | 값 ──
    ws[ENC({ r: 7, c: sc   })] = mkCell('반  사  손  실', S.label);
    ws[ENC({ r: 7, c: d    })] = mkCell('PC',     S.value);
    ws[ENC({ r: 7, c: d+1  })] = mkCell(sp.pc,   S.value);
    ws[ENC({ r: 7, c: d+2  })] = mkCell('APC',   S.value);
    ws[ENC({ r: 7, c: d+3  })] = mkCell(sp.apc,  S.value);
    // 병합 없음 — 각 셀 독립
  }

  // ── 성적서 Excel 생성 ─────────────────────────────────────
  function generate() {
    if (!_items.length) { showToast('항목이 없습니다. 먼저 데이터를 불러오세요.'); return; }

    const today  = new Date();
    const ymd    = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
    const lotNo  = 'AJW' + ymd;

    const wb = XLSX.utils.book_new();
    const ws = {};

    const BLOCK = 6; // 라벨1 + 데이터4 + 갭1

    // 블록 생성
    _items.forEach((item, i) => {
      writeBlock(ws, i * BLOCK, item, i + 1, lotNo);
    });

    // 열 너비 (참고 파일 실측값)
    const cols = [];
    for (let i = 0; i < _items.length; i++) {
      cols.push({ wch: 14.64 });  // 라벨 열 (210px)
      cols.push({ wch: 11.79 });  // 데이터1
      cols.push({ wch: 11.79 });  // 데이터2
      cols.push({ wch: 11.79 });  // 데이터3
      cols.push({ wch: 11.79 });  // 데이터4
      cols.push({ wch: 7.5   });  // 갭 열 (110px)
    }
    ws['!cols'] = cols;

    // 행 높이 (참고 파일 실측값: 20.25pt)
    ws['!rows'] = Array(8).fill(null).map(() => ({ hpt: 20.25 }));

    // 시트 범위
    const lastCol = _items.length * BLOCK - 1;
    ws['!ref'] = `A1:${XLSX.utils.encode_col(lastCol)}8`;

    XLSX.utils.book_append_sheet(wb, ws, '성적서');

    const fname = _srcFile
      ? _srcFile.replace(/\.xlsx?$/i, '_성적서.xlsx')
      : `성적서_${ymd}.xlsx`;

    try {
      XLSX.writeFile(wb, fname, { cellStyles: true });
    } catch {
      XLSX.writeFile(wb, fname);
    }

    showToast(`성적서 생성 완료: ${fname}`);
  }

  // ── 탭 초기화 ─────────────────────────────────────────────
  function initTab() {
    const dz = document.getElementById('certDropzone');
    const fi = document.getElementById('certFileInput');
    if (!dz || fi?._certInited) return;
    if (fi) fi._certInited = true;
    if (dz) {
      dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', ()  => dz.classList.remove('drag'));
      dz.addEventListener('drop', e => {
        e.preventDefault(); dz.classList.remove('drag');
        const f = e.dataTransfer.files[0];
        if (f) handleFile(f);
      });
    }
    if (fi) fi.addEventListener('change', () => { if (fi.files[0]) handleFile(fi.files[0]); });
  }

  return { loadFromApp, handleFile, generate, renderPreview, initTab, updateType };
})();
