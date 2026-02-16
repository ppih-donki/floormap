window.addEventListener("DOMContentLoaded", function() {
  // ====== 基本定数 ======
  const IMG_W = 1240, IMG_H = 1754;   // 元画像寸法（px）
  const GRID_X = 150, GRID_Y = 212;   // CSV設計基準
  const Z_MIN = 0.5, Z_MAX = 4.0, Z_STEP = 0.1;
  const PAN_THRESHOLD_PX = 4;

  // フロア選択肢（要件通りの順序）
  const FLOOR_OPTIONS = ["B1","B2","1F","2F","3F","4F","5F","6F","7F","8F","9F","10F"];
  // 店舗選択肢（プルダウン固定）
const STORE_OPTIONS = ["00029","00092","00107","00255","00268","00275","00276","00278","00323","00348","00356","00373","00389","00419","00442","00517","00555","00612","00620","00639","00645","00713","00726"];

  // マーカーサイズ（直径）
  const MARKER_DEFAULT = 15;
  const MARKER_MIN = 8;
  const MARKER_MAX = 40;
  const MARKER_STEP = 1;
  let markerSizePx = (() => {
    const v = parseInt(localStorage.getItem('xy:markerSizePx'),10);
    return (isFinite(v) ? Math.min(MARKER_MAX, Math.max(MARKER_MIN, v)) : MARKER_DEFAULT);
  })();

  // ====== util ======
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const is5digit = (v) => /^\d{5}$/.test(v);
  const keyOf = (store, floor) => `${store}|${floor}`;

  // CSVヘッダ "00092_1F_YYYYMMDD_HHMM" → {store,floor}
  function parseStoreFloorFromHead(head){
    const s = head.replace(/^\uFEFF/, "").trim();
    const parts = s.split("_");
    if (parts.length < 2) return {store:"", floor:""};
    return {store: parts[0], floor: parts[1]};
  }

  // 画面→コンテンツ座標（画像論理px）
  function pointerToContent(frameEl, zoom, clientX, clientY){
    const rect = frameEl.getBoundingClientRect();
    const px = clientX - rect.left + frameEl.scrollLeft;
    const py = clientY - rect.top  + frameEl.scrollTop;
    const baseScale = frameEl.clientWidth / IMG_W;
    return { x: (px / zoom) / baseScale, y: (py / zoom) / baseScale };
  }

  // 画像論理座標 → CSS left/top（マーカー直径でセンタリング）
  function contentToCssLeftTop(frameEl, contentX, contentY, diameter){
    const baseScale = frameEl.clientWidth / IMG_W;
    const half = diameter / 2;
    return { left: (contentX * baseScale - half), top: (contentY * baseScale - half) };
  }

  // ====== オートフィット用メジャー ======
  // 1) オフスクリーンspanを1個だけ使い回す
  const fitMeasureSpan = (() => {
    const span = document.createElement('span');
    span.id = '__fitMeasurer';
    Object.assign(span.style, {
      position:'absolute',
      left:'-99999px',
      top:'-99999px',
      visibility:'hidden',
      whiteSpace:'nowrap',
      lineHeight:'1',
      margin:'0',
      padding:'0',
      border:'0'
    });
    document.body.appendChild(span);
    return span;
  })();

  // 2) フォント情報（family / weight）を取得（マーカーと同一にする）
  function getMarkerFontInfo(){
    // bodyのフォントをベースに（必要なら marker クラスに指定してもOK）
    const cs = window.getComputedStyle(document.body);
    return {
      family: cs.fontFamily || 'sans-serif',
      weight: cs.fontWeight || '400'
    };
  }

  // 3) キャッシュ（text × diameter × fontKey → fontSize）
  const fitCache = new Map();
  function fontKeyFromInfo(info){
    return `${info.family}|${info.weight}`;
  }

  // ★ 追加: 桁数に応じた padding と 倍率のポリシー
  function paddingByLength(len){
    // 4桁以上は余白ゼロで収めやすくする
    if (len >= 4) return 0;
    if (len === 3) return 1;
    return 1; // 1〜2桁は既定（従来相当）
  }
  function scaleMultiplierByLength(len){
    // 多少大きく見せる試み。ただし最終的に「はみ出しNG」をチェックして安全にフォールバック
    if (len >= 4) return 1.25;
    if (len === 3) return 1.05;
    return 1.0;
  }

  // 4) 円に収まる最大フォントサイズ + 「倍率補正（安全チェック付き）」を求める
  function computeFontSizeToFit({ text, diameter, padding = 1, fontInfo }){
    const t = String(text);
    const len = t.length;

    // 桁数に応じて padding を「削減」する（呼び出し元の指定より小さくするだけ）
    const effPadding = Math.min(padding, paddingByLength(len));
    const inner = Math.max(1, diameter - effPadding*2);

    const cacheKey = `${t}|${diameter}|${fontKeyFromInfo(fontInfo)}|${effPadding}`;
    const cached = fitCache.get(cacheKey);
    if (cached) return cached;

    // まずは厳密フィット（はみ出し無し）サイズを2分探索で求める
    let low = 1, high = inner; // px
    while (high - low > 0.25){
      const mid = (low + high) / 2;
      fitMeasureSpan.textContent = t;
      fitMeasureSpan.style.fontFamily = fontInfo.family;
      fitMeasureSpan.style.fontWeight = fontInfo.weight;
      fitMeasureSpan.style.fontSize = `${mid}px`;
      fitMeasureSpan.style.lineHeight = '1';
      const rect = fitMeasureSpan.getBoundingClientRect();
      const ok = (rect.width <= inner && rect.height <= inner);
      if (ok) low = mid; else high = mid;
    }
    let fitted = Math.max(1, Math.floor(low));

    // 次に倍率補正を試みる（はみ出しNGの場合は元に戻す）
    const mult = scaleMultiplierByLength(len);
    if (mult > 1.0){
      const trial = Math.floor(fitted * mult);
      fitMeasureSpan.textContent = t;
      fitMeasureSpan.style.fontFamily = fontInfo.family;
      fitMeasureSpan.style.fontWeight = fontInfo.weight;
      fitMeasureSpan.style.fontSize = `${trial}px`;
      fitMeasureSpan.style.lineHeight = '1';
      const rect = fitMeasureSpan.getBoundingClientRect();
      const ok = (rect.width <= inner && rect.height <= inner);
      if (ok) fitted = trial; // 収まるなら採用
    }

    fitCache.set(cacheKey, fitted);
    return fitted;
  }

  // ====== DOM ======
  const storeImage = document.getElementById('storeImage');
  const mapImage   = document.getElementById('mapImage');

  const cadContainer = document.getElementById('cadContainer');
  const cadBase      = document.getElementById('cadBase');
  const cadZoomLayer = document.getElementById('cadZoomLayer');
  const cadSizer     = document.getElementById('cadSizer');

  const mapContainer = document.getElementById('mapContainer');
  const mapBase      = document.getElementById('mapBase');
  const mapZoomLayer = document.getElementById('mapZoomLayer');
  const mapSizer     = document.getElementById('mapSizer');

  const markerContainer    = document.getElementById('markerContainer');     // CAD
  const mapMarkerContainer = document.getElementById('mapMarkerContainer');  // MAP

  const coordListDiv = document.getElementById('coordList');
  const coordDisplay = document.getElementById('coordDisplay');

  const viewSelector  = document.getElementById('viewSelector');
  const floorSelector = document.getElementById('floorSelector');
  const storeSelector = document.getElementById('storeSelector');

  const btnDelLast  = document.getElementById('overlayDeleteLast');
  const btnClearAll = document.getElementById('overlayClearAll');
  const btnExport   = document.getElementById('overlayExportCSV');
  const btnImpBtn   = document.getElementById('overlayImportCSVButton');
  const inpImport   = document.getElementById('overlayImportCSV');
  const inpStart    = document.getElementById('overlayStartNumber');

  const zoomIndicator = document.getElementById('zoomIndicator');
  const zoomInBtn  = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');

  const markerMinusBtn = document.getElementById('markerSizeMinusBtn');
  const markerPlusBtn  = document.getElementById('markerSizePlusBtn');
  const markerSizeIndicator = document.getElementById('markerSizeIndicator');

  // ====== 初期値（localStorage優先） ======
  // 店舗
  let selectedStore = localStorage.getItem('xy:selectedStore') || STORE_OPTIONS[0];
  if (!STORE_OPTIONS.includes(selectedStore)) selectedStore = STORE_OPTIONS[0];
  storeSelector.value = selectedStore;

  // フロア
  let selectedFloor = localStorage.getItem('xy:selectedFloor:__global__') || floorSelector?.value || '1F';
  if (!FLOOR_OPTIONS.includes(selectedFloor)) selectedFloor = '1F';
  floorSelector.value = selectedFloor;

  // ====== データ保持（店×フロアで分離） ======
  const coordsByKey = new Map(); // key: "00092|1F" -> Array<coord>
  const undoByKey   = new Map();

  const keyOfCurrent = () => keyOf(selectedStore, selectedFloor);
  function ensureArraysForKey(k){
    if (!coordsByKey.has(k)) coordsByKey.set(k, []);
    if (!undoByKey.has(k))   undoByKey.set(k, []);
  }
  function getCoords(){ const k = keyOfCurrent(); ensureArraysForKey(k); return coordsByKey.get(k); }
  function setCoords(arr){ coordsByKey.set(keyOfCurrent(), arr); }
  function getUndo(){ const k = keyOfCurrent(); ensureArraysForKey(k); return undoByKey.get(k); }
  function setUndo(arr){ undoByKey.set(keyOfCurrent(), arr); }

  // 表示状態
  let currentView = 'cad'; // 'cad' | 'map'
  let cadZoom = 1.0, mapZoom = 1.0;

  // 安定化フラグ
  let isDraggingMarker = false; // マーカー掴み中
  let isPanningFrame   = false; // フレームパン中

  // ====== 画像の切り替え ======
  function updateImageSources(){
    if (!is5digit(selectedStore)) {
      storeImage.removeAttribute('src');
      mapImage.removeAttribute('src');
      return;
    }
    storeImage.src = `images/${selectedStore}_${selectedFloor}_cad.jpg`;
    mapImage.src   = `images/${selectedStore}_${selectedFloor}_map.jpg`;
  }

  // ====== レイアウト ======
  function layoutBase(frameEl, baseEl, zoomLayerEl){
    const frameW = frameEl.clientWidth;
    const baseScale = frameW / IMG_W;
    baseEl.style.width  = frameW + "px";
    baseEl.style.height = (IMG_H * baseScale) + "px";
    zoomLayerEl.style.transformOrigin = "0 0";
    zoomLayerEl.style.width  = frameW + "px";
    zoomLayerEl.style.height = (IMG_H * baseScale) + "px";
    return baseScale;
  }
  function updateSizer(frameEl, sizerEl, zoom){
    const frameW = frameEl.clientWidth;
    const baseScale = frameEl.clientWidth / IMG_W;
    sizerEl.style.width  = (frameEl.clientWidth * zoom) + "px";
    sizerEl.style.height = ((IMG_H * baseScale) * zoom) + "px";
  }
  function setUiLock(lock){
    if (zoomInBtn)  zoomInBtn.disabled  = !!lock;
    if (zoomOutBtn) zoomOutBtn.disabled = !!lock;
    if (markerMinusBtn) markerMinusBtn.disabled = !!lock;
    if (markerPlusBtn)  markerPlusBtn.disabled  = !!lock;
  }

  // ====== Undo ======
  function pushUndo(a){
    const st = getUndo();
    st.push(a);
    if (st.length > 50) st.shift();
    setUndo(st);
  }
  function doUndo(){
    const st = getUndo();
    if (!st.length) return;
    const a = st.pop();
    setUndo(st);

    let coords = getCoords();

    if (a.type === "add"){
      coords = coords.filter(c => c.id !== a.coordinate.id);
    } else if (a.type === "delete"){
      coords.push(a.coordinate);
      coords.sort((p,q)=>p.id-q.id);
    } else if (a.type === "move"){
      const c = coords.find(c=>c.id===a.id);
      if (c){
        c.x=a.previous.x; c.y=a.previous.y;
        c.displayX=a.previous.displayX; c.displayY=a.previous.displayY;
      }
    } else if (a.type === "clear"){
      coords = a.coordinates;
    }
    setCoords(coords);
    render();
    updateNextId();
  }
  document.addEventListener('keydown', (e)=>{
    if (e.ctrlKey && (e.key==='z' || e.key==='Z')){ e.preventDefault(); doUndo(); }
  });

  // ====== 次の発番 ======
  function updateNextId(){
    const coords = getCoords();
    inpStart.value = coords.length ? Math.max(...coords.map(c=>c.id)) + 1 : 1;
  }

  // ====== レンダリング ======
  function render(){
    const coords = getCoords();
    const fontInfo = getMarkerFontInfo();  // ← 実測と同じフォントでフィットさせる

    markerContainer.innerHTML = "";
    mapMarkerContainer.innerHTML = "";
    coordListDiv.innerHTML = "";

    if (currentView === 'cad'){
      layoutBase(cadContainer, cadBase, cadZoomLayer);
      updateSizer(cadContainer, cadSizer, cadZoom);

      coords.forEach(coord=>{
        // リスト
        const row = document.createElement('div');
        row.textContent = `${coord.id}, X:${coord.x}, Y:${coord.y} `;
        const del = document.createElement('button');
        del.textContent = '削除';
        del.style.marginLeft = '10px';
        del.addEventListener('click', ()=>{
          if (confirm("削除した番号は再採番できません。削除してよろしいですか？")){
            pushUndo({type:'delete', coordinate: {...coord}});
            const updated = getCoords().filter(x=>x.id!==coord.id);
            setCoords(updated);
            render(); updateNextId();
          }
        });
        row.appendChild(del);
        coordListDiv.appendChild(row);

        // マーカー（CAD：ドラッグ可）
        const marker = document.createElement('div');
        marker.textContent = String(coord.id);
        marker.className = 'marker';

        const pos = contentToCssLeftTop(cadContainer, coord.displayX, coord.displayY, markerSizePx);
        const fontPx = computeFontSizeToFit({
          text: String(coord.id),
          diameter: markerSizePx,
          padding: 1,           // 呼び出しは従来通り。関数内で桁数に応じて「削減」されます
          fontInfo
        });

        Object.assign(marker.style, {
          position:'absolute',
          left: pos.left + 'px',
          top:  pos.top  + 'px',
          width: markerSizePx+'px',
          height: markerSizePx+'px',
          backgroundColor: coord.flag ? 'blue' : 'red',
          color:'#fff',
          borderRadius:'50%',

          display:'flex',
          alignItems:'center',
          justifyContent:'center',
          textAlign:'center',

          fontSize: fontPx + 'px',
          lineHeight: '1',
          overflow: 'hidden',
          whiteSpace:'nowrap',

          textShadow:'none',
          pointerEvents:'auto'
        });
        markerContainer.appendChild(marker);

        // --- ドラッグ移動（逆変換方式） ---
        marker.addEventListener('mousedown', (e)=>{
          e.stopPropagation(); e.preventDefault();
          let coords = getCoords();
          const c = coords.find(x=>x.id===coord.id); if (!c) return;

          isDraggingMarker = true;
          setUiLock(true);

          const zAtStart = cadZoom;
          const p0 = pointerToContent(cadContainer, zAtStart, e.clientX, e.clientY);
          const offX = p0.x - c.displayX;
          const offY = p0.y - c.displayY;

          const prev = {id:c.id, x:c.x, y:c.y, displayX:c.displayX, displayY:c.displayY};

          if (marker.setPointerCapture && e.pointerId !== undefined) {
            try { marker.setPointerCapture(e.pointerId); } catch(_) {}
          }

          let tip = document.getElementById('markerCoordDisplay');
          if (!tip){
            tip = document.createElement('div');
            tip.id='markerCoordDisplay';
            Object.assign(tip.style,{
              position:'fixed', pointerEvents:'none', background:'rgba(0,0,0,0.7)',
              color:'#fff', padding:'2px 5px', borderRadius:'3px', fontSize:'12px'
            });
            document.body.appendChild(tip);
          }

          function onMove(ev){
            const p = pointerToContent(cadContainer, zAtStart, ev.clientX, ev.clientY);
            const newDisplayX = p.x - offX;
            const newDisplayY = p.y - offY;

            c.displayX = newDisplayX;
            c.displayY = newDisplayY;
            c.x = Math.floor(newDisplayX * GRID_X / IMG_W);
            c.y = Math.floor(newDisplayY * GRID_Y / IMG_H);

            const css = contentToCssLeftTop(cadContainer, newDisplayX, newDisplayY, markerSizePx);
            marker.style.left = css.left + 'px';
            marker.style.top  = css.top  + 'px';

            tip.style.left = (ev.clientX + 10) + 'px';
            tip.style.top  = (ev.clientY + 10) + 'px';
            tip.textContent = `X:${c.x}, Y:${c.y}`;
          }
          function onUp(){
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const tip = document.getElementById('markerCoordDisplay'); tip && tip.remove();

            isDraggingMarker = false;
            setUiLock(false);

            if (prev.x !== c.x || prev.y !== c.y || prev.displayX !== c.displayX || prev.displayY !== c.displayY){
              pushUndo({type:'move', id:c.id, previous:prev});
            }
            setCoords(coords); // 更新反映
            render();
          }
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });

        // ツールチップ（ホバー）
        marker.addEventListener('mouseenter', (e)=>{
          let text = `座標${coord.id}_X:${coord.x},Y:${coord.y}`;
          if (coord.flag && coord.date) text += `_棚画像アップロード日:${coord.date}`;
          const d = document.createElement('div');
          d.id = 'markerDisplay_'+coord.id;
          Object.assign(d.style,{
            position:'fixed', pointerEvents:'none', background:'rgba(0,0,0,0.7)',
            color:'#fff', padding:'2px 5px', borderRadius:'3px', fontSize:'12px'
          });
          d.textContent = text;
          document.body.appendChild(d);
          d.style.left = (e.clientX + 10) + 'px';
          d.style.top  = (e.clientY + 10) + 'px';
        });
        marker.addEventListener('mouseleave', ()=>{
          const d = document.getElementById('markerDisplay_'+coord.id);
          d && d.remove();
        });
      });

      // CADカーソルプレビュー
      cadContainer.onmousemove = (ev)=>{
        const p = pointerToContent(cadContainer, cadZoom, ev.clientX, ev.clientY);
        const x = Math.floor(p.x * GRID_X / IMG_W);
        const y = Math.floor(p.y * GRID_Y / IMG_H);
        coordDisplay.style.left = (ev.clientX + 10) + 'px';
        coordDisplay.style.top  = (ev.clientY + 10) + 'px';
        coordDisplay.textContent = `X:${x}, Y:${y}`;
      };

    } else {
      layoutBase(mapContainer, mapBase, mapZoomLayer);
      updateSizer(mapContainer, mapSizer, mapZoom);

      coords.forEach(coord=>{
        const row = document.createElement('div');
        row.textContent = `${coord.id}, X:${coord.x}, Y:${coord.y} `;
        const del = document.createElement('button');
        del.textContent = '削除';
        del.style.marginLeft = '10px';
        del.addEventListener('click', ()=>{
          if (confirm("削除した番号は再採番できません。削除してよろしいですか？")){
            pushUndo({type:'delete', coordinate: {...coord}});
            const updated = getCoords().filter(x=>x.id!==coord.id);
            setCoords(updated);
            render(); updateNextId();
          }
        });
        row.appendChild(del);
        coordListDiv.appendChild(row);

        const marker = document.createElement('div');
        marker.textContent = String(coord.id);
        marker.className = 'marker';

        const pos = contentToCssLeftTop(mapContainer, coord.displayX, coord.displayY, markerSizePx);
        const fontInfo = getMarkerFontInfo();
        const fontPx = computeFontSizeToFit({
          text: String(coord.id),
          diameter: markerSizePx,
          padding: 1, // 呼び出しは従来通り。関数内で桁数に応じて「削減」されます
          fontInfo
        });

        Object.assign(marker.style, {
          position:'absolute',
          left: pos.left + 'px',
          top:  pos.top  + 'px',
          width: markerSizePx+'px',
          height: markerSizePx+'px',
          backgroundColor: coord.flag ? 'blue' : 'red',
          color:'#fff',
          borderRadius:'50%',

          display:'flex',
          alignItems:'center',
          justifyContent:'center',
          textAlign:'center',

          fontSize: fontPx + 'px',
          lineHeight: '1',
          overflow: 'hidden',
          whiteSpace:'nowrap',

          textShadow:'none',
          pointerEvents:'none'
        });
        mapMarkerContainer.appendChild(marker);
      });

      cadContainer.onmousemove = null;
    }

    updateNextId();
    updateZoomIndicator();
    updateMarkerSizeIndicator();
  }

  // ====== クリック追加（CADのみ） ======
  function addCoordinateAtClientPos(clientX, clientY){
    if (!is5digit(selectedStore)){
      alert("先に 店舗（5桁）を選択してください。"); return;
    }
    const p = pointerToContent(cadContainer, cadZoom, clientX, clientY);
    const x = Math.floor(p.x * GRID_X / IMG_W);
    const y = Math.floor(p.y * GRID_Y / IMG_H);
    let id = parseInt(inpStart.value,10); if (isNaN(id) || id<1) id=1;

    const coords = getCoords();
    const item = { id, x, y, displayX:p.x, displayY:p.y, flag:false, date:"" };
    coords.push(item);
    setCoords(coords);
    pushUndo({type:'add', coordinate:{...item}});
    inpStart.value = id+1;
    render();
  }

  // ====== CSV ======
  function exportCSV(){
    const coords = getCoords();
    if (!is5digit(selectedStore)){ alert("店舗（5桁）を選択してください。"); return; }
    if (!coords.length){ alert("座標が取得されていません"); return; }

    const now = new Date();
    const y = now.getFullYear();
    const m = ('0'+(now.getMonth()+1)).slice(-2);
    const d = ('0'+now.getDate()).slice(-2);
    const hh= ('0'+now.getHours()).slice(-2);
    const mm= ('0'+now.getMinutes()).slice(-2);
    const stamp = `${y}${m}${d}_${hh}${mm}`;
    const head = `${selectedStore}_${selectedFloor}_${stamp}`;
    let csv = "\uFEFF";
    csv += head + "\n";
    csv += "棚ID,X→,Y↓,フロアMAPイメージ.jpg,フラグ,日付,マーカー表示用X→,マーカー表示用Y↓\n";
    const mapFile = `${selectedStore}_${selectedFloor}_map.jpg`;
    coords.forEach(c=>{
      const flag = c.flag ? "1" : "";
      const date = (c.flag && c.date) ? c.date : "";
      csv += `${selectedStore}_${selectedFloor}_${c.id}_000000,${c.x},${c.y},${mapFile},${flag},${date},${c.displayX},${c.displayY}\n`;
    });
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`${selectedStore}_${selectedFloor}_${stamp}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function importCSV(file){
    if (!file) return;
    if (!is5digit(selectedStore)){ alert("先に 店舗（5桁）を選択してください。"); return; }

    const reader = new FileReader();
    reader.onload = (e)=>{
      let t = e.target.result.replace(/^\uFEFF/, "");
      const lines = t.split('\n').map(s=>s.trim()).filter(Boolean);
      if (lines.length < 3){ alert("CSVの形式が正しくありません。"); return; }

      // 1行目ヘッダ検証：店番＆フロア一致が必須
      const head = lines[0].trim();
      const {store:storeCsv, floor:floorCsv} = parseStoreFloorFromHead(head);
      if (!storeCsv || !floorCsv){
        alert("CSVヘッダが不正です（店番/フロアが読み取れません）。");
        return;
      }
      if (storeCsv !== selectedStore){
        alert(`店番が一致しません（CSV:${storeCsv} / 選択:${selectedStore}）。`);
        return;
      }
      if (floorCsv !== selectedFloor){
        alert(`現在選択中のフロア（${selectedFloor}）とCSVのフロア（${floorCsv}）が異なるため、インポートできません。`);
        return;
      }

      // 各行：displayX/Y 必須（このツールのCSVは必ず含む）
      const arr = [];
      for (let i=2;i<lines.length;i++){
        const cols = lines[i].split(',');
        if (cols.length < 8){
          alert("このCSVには displayX / displayY が含まれていません。インポートを中止します。");
          return;
        }
        const mparts = cols[0].split('_');
        if (mparts.length < 4) continue;
        if (mparts[0]!==selectedStore || mparts[1]!==selectedFloor) continue;

        const id = parseInt(mparts[2],10);
        const x = parseInt(cols[1],10);
        const y = parseInt(cols[2],10);
        const displayX = parseFloat(cols[6]);
        const displayY = parseFloat(cols[7]);
        let flag=false, date="";
        if (cols.length >= 6){ flag = (cols[4]==="1"); date = cols[5]; }
        arr.push({id, x, y, displayX, displayY, flag, date});
      }
      setCoords(arr);
      setUndo([]); // 取り込み直後はUndoクリア
      render();
    };
    reader.readAsText(file,'UTF-8');
  }

  // ====== 画像ズーム ======
  function setCadZoom(z, skipRender){
    cadZoom = clamp(parseFloat(z||1), Z_MIN, Z_MAX);
    cadZoomLayer.style.transform = `scale(${cadZoom})`;
    updateSizer(cadContainer, cadSizer, cadZoom);
    if (!skipRender) render();
    updateZoomIndicator();
  }
  function setMapZoom(z, skipRender){
    mapZoom = clamp(parseFloat(z||1), Z_MIN, Z_MAX);
    mapZoomLayer.style.transform = `scale(${mapZoom})`;
    updateSizer(mapContainer, mapSizer, mapZoom);
    if (!skipRender) render();
    updateZoomIndicator();
  }
  function updateZoomIndicator(){
    if (!zoomIndicator) return;
    const z = (currentView==='cad') ? cadZoom : mapZoom;
    zoomIndicator.textContent = `${Math.round(z*100)}%`;
  }
  zoomIndicator && zoomIndicator.addEventListener('click', ()=>{
    if (currentView==='cad') setCadZoom(1.0);
    else setMapZoom(1.0);
  });
  zoomInBtn && zoomInBtn.addEventListener('click', ()=>{
    if (isDraggingMarker || isPanningFrame) return;
    if (currentView==='cad') setCadZoom(cadZoom*(1+Z_STEP));
    else setMapZoom(mapZoom*(1+Z_STEP));
  });
  zoomOutBtn && zoomOutBtn.addEventListener('click', ()=>{
    if (isDraggingMarker || isPanningFrame) return;
    if (currentView==='cad') setCadZoom(cadZoom*(1-Z_STEP));
    else setMapZoom(mapZoom*(1-Z_STEP));
  });

  function attachWheelZoom(frameEl, getZoom, setZoom){
    frameEl.addEventListener('wheel', (e)=>{
      if (isDraggingMarker || isPanningFrame) { e.preventDefault(); return; }
      e.preventDefault();

      const delta = -e.deltaY;
      const factor = (delta>0) ? (1+Z_STEP) : (1-Z_STEP);

      // マウス下固定
      const rect = frameEl.getBoundingClientRect();
      const fx = e.clientX - rect.left + frameEl.scrollLeft;
      const fy = e.clientY - rect.top  + frameEl.scrollTop;
      const baseScale = frameEl.clientWidth / IMG_W;
      const contentX = fx / (baseScale * getZoom());
      const contentY = fy / (baseScale * getZoom());

      const newZ = clamp(getZoom() * factor, Z_MIN, Z_MAX);
      setZoom(newZ, true);

      const nfx = contentX * (baseScale * newZ);
      const nfy = contentY * (baseScale * newZ);
      frameEl.scrollLeft = nfx - (e.clientX - rect.left);
      frameEl.scrollTop  = nfy - (e.clientY - rect.top);
      updateZoomIndicator();
    }, {passive:false});
  }
  attachWheelZoom(cadContainer, ()=>cadZoom, setCadZoom);
  attachWheelZoom(mapContainer, ()=>mapZoom, setMapZoom);

  // ====== パン（MAP常時 / CADはマーカー以外で） ======
  function attachPan(frameEl, options){
    let isPanning = false;
    let startX=0, startY=0, startSL=0, startST=0;
    let downX=0, downY=0;

    frameEl.addEventListener('mousedown', (e)=>{
      if (options.skipWhenMarker && e.target.closest('.marker')) return;

      isPanning = true;
      isPanningFrame = true;
      frameEl.classList.add('grabbing');
      startX = e.clientX; startY = e.clientY;
      downX = e.clientX;  downY = e.clientY;
      startSL = frameEl.scrollLeft; startST = frameEl.scrollTop;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e)=>{
      if (!isPanning) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      frameEl.scrollLeft = startSL - dx;
      frameEl.scrollTop  = startST - dy;
    });

    window.addEventListener('mouseup', (e)=>{
      if (!isPanning) return;
      frameEl.classList.remove('grabbing');
      const totalDx = Math.abs(e.clientX - downX);
      const totalDy = Math.abs(e.clientY - downY);
      const moved = (totalDx > PAN_THRESHOLD_PX || totalDy > PAN_THRESHOLD_PX);
      isPanning = false;
      isPanningFrame = false;

      if (options.enableClickToAdd && !moved && currentView==='cad'){
        addCoordinateAtClientPos(e.clientX, e.clientY);
      }
    });
  }
  attachPan(mapContainer, { skipWhenMarker:false, enableClickToAdd:false });
  attachPan(cadContainer, { skipWhenMarker:true,  enableClickToAdd:true  });

  // ====== マーカーサイズ UI ======
  function updateMarkerSizeIndicator(){
    if (markerSizeIndicator) markerSizeIndicator.textContent = `${markerSizePx}px`;
  }
  function setMarkerSize(px, {skipRender=false}={}){
    markerSizePx = clamp(Math.round(px), MARKER_MIN, MARKER_MAX);
    localStorage.setItem('xy:markerSizePx', String(markerSizePx));
    // 数字フィットのキャッシュは直径依存なので、直径が変わる時だけクリアしておくと安全
    fitCache.clear();
    updateMarkerSizeIndicator();
    if (!skipRender) render();
  }
  markerSizeIndicator && markerSizeIndicator.addEventListener('click', ()=> setMarkerSize(MARKER_DEFAULT));
  markerMinusBtn && markerMinusBtn.addEventListener('click', ()=>{
    if (isDraggingMarker || isPanningFrame) return;
    setMarkerSize(markerSizePx - MARKER_STEP);
  });
  markerPlusBtn && markerPlusBtn.addEventListener('click', ()=>{
    if (isDraggingMarker || isPanningFrame) return;
    setMarkerSize(markerSizePx + MARKER_STEP);
  });

  // ====== ボタン ======
  btnDelLast && btnDelLast.addEventListener('click', ()=>{
    const coords = getCoords();
    if (!coords.length) return;
    const deleted = coords.pop();
    setCoords(coords);
    pushUndo({type:'delete', coordinate:{...deleted}});
    render(); updateNextId();
  });
  btnClearAll && btnClearAll.addEventListener('click', ()=>{
    if (confirm("全ての座標を削除しますか？")){
      const prev = getCoords().map(c=>({...c}));
      setCoords([]);
      setUndo([]);
      pushUndo({type:'clear', coordinates: prev});
      render(); updateNextId();
    }
  });
  btnExport && btnExport.addEventListener('click', ()=>{
    alert("※保存時にファイル名を変更しないでください");
    exportCSV();
  });
  btnImpBtn && btnImpBtn.addEventListener('click', ()=>{
    if (!is5digit(selectedStore)) { alert("先に 店舗（5桁）を選択してください。"); return; }
    alert("インポート前に現在のフロア座標をクリアすることを推奨します。");
    inpImport.click();
  });
  inpImport && inpImport.addEventListener('change', (e)=>{
    importCSV(e.target.files[0]); e.target.value = "";
  });

  // ====== 表示切替（CAD/MAP） ======
  function setView(v){
    currentView = (v==='map') ? 'map' : 'cad';
    if (currentView==='cad'){
      cadContainer.classList.remove('hidden');
      mapContainer.classList.add('hidden');
    } else {
      mapContainer.classList.remove('hidden');
      cadContainer.classList.add('hidden');
    }
    render();
  }
  viewSelector && viewSelector.addEventListener('change', (e)=> setView(e.target.value));

  // ====== 店舗・フロア切替 ======
  function applyStoreFloorChange(nextStore, nextFloor){
    // 編集中に切替 → 現在セットをクリア（要件）
    if (isDraggingMarker || isPanningFrame){
      setCoords([]);
      setUndo([]);
    }
    selectedStore = nextStore;
    selectedFloor = nextFloor;

    // 記憶
    localStorage.setItem('xy:selectedStore', selectedStore);
    localStorage.setItem('xy:selectedFloor:__global__', selectedFloor);

    // 画像・ビュー更新、ズームリセット
    updateImageSources();
    setCadZoom(1.0, true);
    setMapZoom(1.0, true);
    cadContainer.scrollLeft = cadContainer.scrollTop = 0;
    mapContainer.scrollLeft = mapContainer.scrollTop = 0;

    render();
  }

  // 店舗変更（プルダウン）
  storeSelector.addEventListener('change', ()=>{
    if (!STORE_OPTIONS.includes(storeSelector.value)){
      storeSelector.value = STORE_OPTIONS[0];
    }
    applyStoreFloorChange(storeSelector.value, selectedFloor);
  });

  // フロア変更
  floorSelector && floorSelector.addEventListener('change', (e)=>{
    applyStoreFloorChange(storeSelector.value, e.target.value);
  });

  // ====== システムキー ======
  document.addEventListener('keydown',(e)=>{
    if (e.key === "Delete"){
      const coords = getCoords();
      if (!coords.length) return;
      const deleted = coords.pop();
      setCoords(coords);
      pushUndo({type:'delete', coordinate:{...deleted}});
      render(); updateNextId();
    }
  });

  // ====== リサイズ ======
  window.addEventListener('resize', ()=>{
    updateSizer(cadContainer, cadSizer, cadZoom);
    updateSizer(mapContainer, mapSizer, mapZoom);
    render();
  });

  // ====== 初期化 ======
  updateImageSources();
  updateMarkerSizeIndicator();
  inpStart.value = 1;
  setView('cad');
  setCadZoom(1.0, true);
  setMapZoom(1.0, true);
  updateSizer(cadContainer, cadSizer, cadZoom);
  updateSizer(mapContainer, mapSizer, mapZoom);
  render();
});














