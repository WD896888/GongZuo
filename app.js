/* =========================================================
   发票工坊 · 业务逻辑
   状态层 (store) + 业务层 (layout) + 渲染层 (preview/print)
   ========================================================= */

'use strict';

/* ============== 纸张规格 (mm) ============== */
const PAPER_SIZES = {
  A4:     { w: 210, h: 297 },
  A5:     { w: 148, h: 210 },
  A6:     { w: 105, h: 148 },
  B5:     { w: 176, h: 250 },
  Letter: { w: 215.9, h: 279.4 }
};

/* ============== 默认设置 ============== */
const DEFAULT_SETTINGS = {
  paperSize:    'A4',
  orientation:  'portrait',
  margin:       8,
  perPage:      1,
  scale:        'fit',
  align:        'center',
  copies:       1
};

/* ============== 工具函数 ============== */
function sortImagesByName(arr) {
  return arr.sort((a, b) => a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: 'base'
  }));
}

/* ============== 状态（观察者） ============== */
const store = {
  images: [],        // { id, name, src, w, h, rotate }
  settings: { ...DEFAULT_SETTINGS },
  zoom: 1,           // 预览缩放比例
  listeners: new Set(),

  emit() { this.listeners.forEach(fn => fn()); },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },

  addImages(files) {
    let added = 0;
    const tasks = [];
    Array.from(files).forEach(f => {
      if (/^image\/(png|jpe?g|webp)$/i.test(f.type)) {
        tasks.push(new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = e => {
            const src = e.target.result;
            const img = new Image();
            img.onload = () => {
              this.images.push({
                id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
                name: f.name,
                src,
                w: img.naturalWidth,
                h: img.naturalHeight,
                rotate: 0
              });
              added++;
              resolve();
            };
            img.onerror = resolve;
            img.src = src;
          };
          reader.readAsDataURL(f);
        }));
      } else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        tasks.push(handlePdfFile(f));
      }
    });
    Promise.all(tasks).then(() => {
      if (added) {
        sortImagesByName(this.images);
        this.emit();
      }
    });
  },

  addFromDataURL(name, dataURL) {
    const img = new Image();
    img.onload = () => {
      this.images.push({
        id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name,
        src: dataURL,
        w: img.naturalWidth,
        h: img.naturalHeight,
        rotate: 0
      });
      sortImagesByName(this.images);
      this.emit();
    };
    img.src = dataURL;
  },

  remove(id) {
    const i = this.images.findIndex(x => x.id === id);
    if (i >= 0) { this.images.splice(i, 1); this.emit(); }
  },
  rotate(id) {
    const it = this.images.find(x => x.id === id);
    if (it) { it.rotate = (it.rotate + 90) % 360; this.emit(); }
  },
  move(id, delta) {
    const i = this.images.findIndex(x => x.id === id);
    if (i < 0) return;
    const j = i + delta;
    if (j < 0 || j >= this.images.length) return;
    const arr = this.images;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    this.emit();
  },
  clear() { this.images = []; this.emit(); },
  updateSettings(patch) { Object.assign(this.settings, patch); this.emit(); },
  resetSettings() { this.settings = { ...DEFAULT_SETTINGS }; syncControls(); this.emit(); }
};

/* ============== 排版计算 ============== */
function getPageSize() {
  const s = store.settings;
  const p = PAPER_SIZES[s.paperSize] || PAPER_SIZES.A4;
  return s.orientation === 'portrait' ? { w: p.w, h: p.h } : { w: p.h, h: p.w };
}

function getPrintableArea() {
  const page = getPageSize();
  const m = store.settings.margin;
  return { x: m, y: m, w: page.w - m * 2, h: page.h - m * 2 };
}

/**
 * 将图片按设置摆放到页面，返回每张图的位置和尺寸
 *  - perPage=1: 单图全幅
 *  - perPage=2: 上下分
 *  - perPage=4: 田字格
 */
function layoutImages() {
  const imgs = store.images;
  const n = store.images.length;
  if (n === 0) return [];

  const perPage = Math.min(store.settings.perPage, n);
  const totalPages = Math.ceil(n / perPage);
  const pages = [];

  for (let p = 0; p < totalPages; p++) {
    const slice = imgs.slice(p * perPage, p * perPage + perPage);
    const slots = computeSlots(perPage);
    const placed = slice.map((img, i) => {
      const slot = slots[i];
      const placed = placeInSlot(img, slot);
      return { img, ...placed, slot };
    });
    pages.push(placed);
  }
  return pages;
}

function computeSlots(count) {
  const area = getPrintableArea();
  const gap = Math.min(2, area.w / 20, area.h / 20);
  const slots = [];
  if (count === 1) {
    slots.push({ x: area.x, y: area.y, w: area.w, h: area.h });
  } else if (count === 2) {
    const h = (area.h - gap) / 2;
    slots.push({ x: area.x, y: area.y, w: area.w, h });
    slots.push({ x: area.x, y: area.y + h + gap, w: area.w, h });
  } else if (count === 3) {
    const h = (area.h - gap * 2) / 3;
    for (let i = 0; i < 3; i++) {
      slots.push({ x: area.x, y: area.y + i * (h + gap), w: area.w, h });
    }
  } else if (count === 4) {
    const w = (area.w - gap) / 2;
    const h = (area.h - gap) / 2;
    slots.push({ x: area.x,         y: area.y,         w, h });
    slots.push({ x: area.x + w + gap, y: area.y,         w, h });
    slots.push({ x: area.x,         y: area.y + h + gap, w, h });
    slots.push({ x: area.x + w + gap, y: area.y + h + gap, w, h });
  } else {
    // 退化为 1
    slots.push({ x: area.x, y: area.y, w: area.w, h: area.h });
  }
  return slots;
}

function placeInSlot(img, slot) {
  const s = store.settings;
  const rotate = img.rotate || 0;
  // 旋转后视觉宽高
  const swapped = rotate === 90 || rotate === 270;
  const imgW = swapped ? img.h : img.w;
  const imgH = swapped ? img.w : img.h;

  let drawW, drawH, drawX, drawY;

  if (s.scale === 'actual') {
    // 原尺寸（mm）：按图像像素按 96dpi 近似转换为 mm
    const pxToMm = 25.4 / 96;
    drawW = imgW * pxToMm;
    drawH = imgH * pxToMm;
  } else {
    // 适应 / 填充：按比例放入 slot
    const slotRatio = slot.w / slot.h;
    const imgRatio  = imgW / imgH;
    if (s.scale === 'fill') {
      if (imgRatio > slotRatio) {
        drawH = slot.h; drawW = slot.h * imgRatio;
      } else {
        drawW = slot.w; drawH = slot.w / imgRatio;
      }
    } else { // fit
      if (imgRatio > slotRatio) {
        drawW = slot.w; drawH = slot.w / imgRatio;
      } else {
        drawH = slot.h; drawW = slot.h * imgRatio;
      }
    }
  }

  // 对齐
  if (s.align === 'center' || s.scale === 'actual') {
    drawX = slot.x + (slot.w - drawW) / 2;
    drawY = slot.y + (slot.h - drawH) / 2;
  } else if (s.align === 'top') {
    drawX = slot.x + (slot.w - drawW) / 2;
    drawY = slot.y;
  } else { // tile - 居中
    drawX = slot.x + (slot.w - drawW) / 2;
    drawY = slot.y + (slot.h - drawH) / 2;
  }

  return { x: drawX, y: drawY, w: drawW, h: drawH };
}

/* ============== 屏幕预览渲染 ============== */
function renderPreview() {
  const wrap = document.getElementById('pages');
  wrap.innerHTML = '';

  const pageSize = getPageSize();
  const pages = layoutImages();
  const basePx = pxFromMm(Math.max(pageSize.w, pageSize.h));
  const scale = Math.min(1, 700 / basePx) * store.zoom; // 适配视口
  const pageWPx = pxFromMm(pageSize.w) * scale;
  const pageHPx = pxFromMm(pageSize.h) * scale;

  pages.forEach((slots, pIdx) => {
    const page = document.createElement('div');
    page.className = 'page';
    page.style.width  = pageWPx + 'px';
    page.style.height = pageHPx + 'px';

    const label = document.createElement('div');
    label.className = 'page__index';
    label.textContent = `第 ${pIdx + 1} 页 / 共 ${pages.length} 页`;
    page.appendChild(label);

    slots.forEach(({ img, x, y, w, h }) => {
      const slot = document.createElement('div');
      slot.className = 'page__slot';
      slot.style.left   = pxFromMm(x) * scale + 'px';
      slot.style.top    = pxFromMm(y) * scale + 'px';
      slot.style.width  = pxFromMm(w) * scale + 'px';
      slot.style.height = pxFromMm(h) * scale + 'px';

      const im = document.createElement('img');
      im.className = 'page__img';
      im.src = img.src;
      im.style.transform = `rotate(${img.rotate || 0}deg)`;
      slot.appendChild(im);
      page.appendChild(slot);
    });

    wrap.appendChild(page);
  });

  // 元信息
  const s = store.settings;
  const meta = `${s.paperSize}${s.orientation === 'portrait' ? ' · 纵向' : ' · 横向'} · ${s.perPage} 张/页 · ${s.scale === 'fit' ? '自适应' : s.scale === 'fill' ? '填充' : '原尺寸'}`;
  document.getElementById('stageMeta').textContent = meta;
}

function pxFromMm(mm) { return mm * 96 / 25.4; }

/* ============== 缩略图列表渲染 ============== */
function renderThumbs() {
  const wrap = document.getElementById('thumbs');
  wrap.innerHTML = '';

  if (store.images.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'thumbs__empty';
    empty.innerHTML = '<p>暂无图片</p><p class="thumbs__empty-hint">从上方上传发票图片开始</p>';
    wrap.appendChild(empty);
    document.getElementById('thumbCount').textContent = '0';
    return;
  }

  document.getElementById('thumbCount').textContent = store.images.length;

  store.images.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.innerHTML = `
      <span class="thumb__index">${i + 1}</span>
      <img class="thumb__img" src="${img.src}" alt="" />
      <div class="thumb__meta">
        <div class="thumb__name" title="${escapeAttr(img.name)}">${escapeHtml(img.name)}</div>
        <div class="thumb__sub">
          <span><b>${img.w}</b>×<b>${img.h}</b></span>
          <span>·</span>
          <span>${img.rotate ? img.rotate + '°' : '0°'}</span>
        </div>
      </div>
      <div class="thumb__actions">
        <button class="thumb__btn" data-act="up"   title="上移"   ${i === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button class="thumb__btn" data-act="down" title="下移"   ${i === store.images.length - 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <button class="thumb__btn" data-act="rot"  title="旋转 90°">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <button class="thumb__btn danger" data-act="del" title="删除">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    `;
    el.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'up')   store.move(img.id, -1);
        if (act === 'down') store.move(img.id, +1);
        if (act === 'rot')  store.rotate(img.id);
        if (act === 'del')  store.remove(img.id);
      });
    });
    wrap.appendChild(el);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* ============== 顶部统计 & 操作按钮 ============== */
function renderCounters() {
  const n = store.images.length;
  const pages = Math.ceil(n / Math.max(1, Math.min(store.settings.perPage, n || 1))) || (n === 0 ? 0 : 1);
  const pagesReal = n === 0 ? 0 : Math.ceil(n / Math.min(store.settings.perPage, n));
  document.getElementById('counter').textContent = `${n} 张待打印`;
  document.getElementById('actionStat').textContent = `总计 ${n} 张 · ${pagesReal} 页 × ${store.settings.copies} 份`;
  const has = n > 0;
  document.getElementById('printBtn').disabled  = !has;
  document.getElementById('exportBtn').disabled = !has;
  document.getElementById('clearBtn').disabled  = !has;
}

/* ============== 打印 ============== */
function buildPrintArea() {
  const area = document.getElementById('printArea');
  area.innerHTML = '';
  const pageSize = getPageSize();
  const pages = layoutImages();
  const copies = Math.max(1, store.settings.copies | 0);

  // 获取纸张原始尺寸（不随方向交换）
  const paper = PAPER_SIZES[store.settings.paperSize] || PAPER_SIZES.A4;
  const orientation = store.settings.orientation;

  // 注入 @page 规则（使用标准纸张名 + 方向关键字，确保打印机正确识别方向）
  const styleId = 'printVars';
  let oldStyle = document.getElementById(styleId);
  if (oldStyle) oldStyle.remove();
  const styleEl = document.createElement('style');
  styleEl.id = styleId;
  styleEl.textContent = `
    @page {
      size: ${store.settings.paperSize} ${orientation};
      margin: 0;
    }
  `;
  document.head.appendChild(styleEl);

  for (let copy = 0; copy < copies; copy++) {
    pages.forEach((slots) => {
      const p = document.createElement('section');
      p.className = 'print-page';
      p.style.width = pageSize.w + 'mm';
      p.style.height = pageSize.h + 'mm';
      slots.forEach(({ img, x, y, w, h }) => {
        const s = document.createElement('div');
        s.className = 'print-slot';
        s.style.left   = x + 'mm';
        s.style.top    = y + 'mm';
        s.style.width  = w + 'mm';
        s.style.height = h + 'mm';
        const im = document.createElement('img');
        im.src = img.src;
        if (img.rotate) im.style.transform = `rotate(${img.rotate}deg)`;
        s.appendChild(im);
        p.appendChild(s);
      });
      area.appendChild(p);
    });
  }
}

function doPrint() {
  if (store.images.length === 0) return;
  buildPrintArea();
  // 等 DOM 渲染完成
  setTimeout(() => {
    window.print();
    // 打印结束后清空 printArea（部分浏览器不会立即清理）
    setTimeout(() => { document.getElementById('printArea').innerHTML = ''; }, 1000);
  }, 50);
}

/* ============== 控件同步 ============== */
function syncControls() {
  const s = store.settings;
  document.getElementById('paperSize').value = s.paperSize;
  document.getElementById('margin').value = s.margin;
  document.getElementById('marginVal').textContent = s.margin;
  document.getElementById('copies').value = s.copies;
  document.querySelectorAll('#orientationSeg .seg__btn').forEach(b => {
    b.classList.toggle('is-active', b.dataset.val === s.orientation);
  });
  document.querySelectorAll('#perPageSeg .seg__btn').forEach(b => {
    b.classList.toggle('is-active', +b.dataset.val === s.perPage);
  });
  document.querySelectorAll('#scaleSeg .seg__btn').forEach(b => {
    b.classList.toggle('is-active', b.dataset.val === s.scale);
  });
  document.querySelectorAll('#alignSeg .seg__btn').forEach(b => {
    b.classList.toggle('is-active', b.dataset.val === s.align);
  });
}

/* ============== 主渲染 ============== */
function render() {
  renderThumbs();
  renderPreview();
  renderCounters();
}

/* ============== 事件绑定 ============== */
function bind() {
  // 上传：点击按钮
  document.getElementById('pickBtn').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('fileInput').click();
  });
  document.getElementById('dropzone').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    document.getElementById('fileInput').click();
  });
  document.getElementById('fileInput').addEventListener('change', e => {
    if (e.target.files.length) store.addImages(e.target.files);
    e.target.value = '';
  });

  // 上传：拖拽
  const dz = document.getElementById('dropzone');
  ['dragenter', 'dragover'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('is-drag'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('is-drag'); })
  );
  dz.addEventListener('drop', e => {
    const files = e.dataTransfer?.files;
    if (files?.length) store.addImages(files);
  });
  // 整页拖拽拦截（避免误打开图片）
  ['dragover', 'drop'].forEach(ev =>
    window.addEventListener(ev, e => e.preventDefault())
  );

  // 上传：粘贴
  window.addEventListener('paste', e => {
    const items = e.clipboardData?.items || [];
    const files = [];
    let pasteIdx = 0;
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && /^image\//.test(f.type)) {
          files.push(f);
        }
      }
    }
    if (files.length) {
      store.addImages(files);
    } else if (e.clipboardData?.getData) {
      // 尝试从 URL 粘贴
      const url = e.clipboardData.getData('text/plain');
      if (/^https?:\/\/.+\.(png|jpe?g|webp|gif)/i.test(url)) {
        const name = url.split('/').pop().split('?')[0] || `pasted-${Date.now()}.png`;
        fetch(url).then(r => r.blob()).then(b => {
          store.addImages([new File([b], name, { type: b.type })]);
        }).catch(() => {});
      }
    }
  });

  // 打印设置
  document.getElementById('paperSize').addEventListener('change', e => {
    store.updateSettings({ paperSize: e.target.value });
  });
  document.getElementById('margin').addEventListener('input', e => {
    const v = +e.target.value;
    document.getElementById('marginVal').textContent = v;
    store.updateSettings({ margin: v });
  });
  document.getElementById('copies').addEventListener('input', e => {
    let v = Math.max(1, Math.min(99, (+e.target.value) || 1));
    store.updateSettings({ copies: v });
  });
  document.getElementById('copiesMinus').addEventListener('click', () => {
    const el = document.getElementById('copies');
    el.value = Math.max(1, (+el.value) - 1);
    store.updateSettings({ copies: +el.value });
  });
  document.getElementById('copiesPlus').addEventListener('click', () => {
    const el = document.getElementById('copies');
    el.value = Math.min(99, (+el.value) + 1);
    store.updateSettings({ copies: +el.value });
  });

  // 分段控件
  function bindSeg(id, key, parser) {
    document.querySelectorAll(`#${id} .seg__btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#${id} .seg__btn`).forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const v = parser ? parser(btn.dataset.val) : btn.dataset.val;
        store.updateSettings({ [key]: v });
      });
    });
  }
  bindSeg('orientationSeg', 'orientation');
  bindSeg('perPageSeg',     'perPage',    v => +v);
  bindSeg('scaleSeg',       'scale');
  bindSeg('alignSeg',       'align');

  // 底部
  document.getElementById('printBtn').addEventListener('click', doPrint);
  document.getElementById('exportBtn').addEventListener('click', () => {
    doPrint();
  });
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (store.images.length === 0) return;
    if (confirm(`确定清空全部 ${store.images.length} 张图片？`)) store.clear();
  });
  document.getElementById('resetBtn').addEventListener('click', () => store.resetSettings());

  // 缩放
  document.getElementById('zoomIn').addEventListener('click', () => {
    store.zoom = Math.min(2.5, +(store.zoom + 0.1).toFixed(2));
    document.getElementById('zoomVal').textContent = Math.round(store.zoom * 100) + '%';
    document.querySelector('.stage__pages').style.transform = `scale(${store.zoom})`;
  });
  document.getElementById('zoomOut').addEventListener('click', () => {
    store.zoom = Math.max(0.3, +(store.zoom - 0.1).toFixed(2));
    document.getElementById('zoomVal').textContent = Math.round(store.zoom * 100) + '%';
    document.querySelector('.stage__pages').style.transform = `scale(${store.zoom})`;
  });

  // 主题切换
  document.getElementById('themeBtn').addEventListener('click', () => {
    const isLight = document.body.classList.contains('theme-light');
    applyTheme(isLight ? 'dark' : 'light');
  });

  // 帮助弹层
  const modal = document.getElementById('helpModal');
  document.getElementById('helpBtn').addEventListener('click', () => modal.hidden = false);
  modal.addEventListener('click', e => {
    if (e.target.dataset.close !== undefined) modal.hidden = true;
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });
}

/* ============== 主题模块 ============== */
const THEME_KEY = 'invoice_workshop_theme';

function applyTheme(theme) {
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.body.classList.toggle('theme-light', theme === 'light');
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
}

function getPreferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  return 'light';
}

/* ============== 启动 ============== */
function init() {
  applyTheme(getPreferredTheme());
  syncControls();
  bind();
  bindPdfModal();
  store.subscribe(render);
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

/* =========================================================
   PDF 导入模块
   依赖：window.pdfjsLib (PDF.js 3.x UMD)
   ========================================================= */

let pdfQueue = [];        // 待处理的 PDF 文件队列
let currentPdf = null;    // 当前正在处理的 PDF { file, pdfDoc, selected: Set<pageNum> }

// PDF.js 资源 URL（用于 CMap 与标准字体解码）
const PDFJS_CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/';
const PDFJS_STANDARD_FONT_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/';
const PDFJS_CMAP_PACKED = false;  // jsdelivr 该版本仅提供解包后的 .bcmap

function isPdfReady() {
  return !!(window.pdfjsLib && window.pdfjsLib.getDocument);
}

/**
 * 创建 PDF.js 加载任务（配置 CMap / 标准字体 / 系统字体回退）
 */
function loadPdfDoc(buffer) {
  return window.pdfjsLib.getDocument({
    data: buffer,
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: PDFJS_CMAP_PACKED,
    standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
    useSystemFonts: true,
    disableFontFace: false,
    disableCombineTextItems: false
  }).promise;
}

/**
 * 处理单个 PDF 文件
 * - 1 页：直接导入
 * - 多页：进入弹层让用户选择
 */
async function handlePdfFile(file) {
  if (!isPdfReady()) {
    alert('PDF.js 尚未加载完成，请稍后再试。');
    return;
  }
  try {
    const buffer = await file.arrayBuffer();
    const pdfDoc = await loadPdfDoc(buffer);
    if (pdfDoc.numPages === 1) {
      const dataURL = await renderPdfPageToDataURL(pdfDoc, 1, 2.5);
      const dims = await getImageDims(dataURL);
      store.images.push({
        id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: file.name.replace(/\.pdf$/i, '') + ' · p1',
        src: dataURL,
        w: dims.w,
        h: dims.h,
        rotate: 0
      });
      sortImagesByName(store.images);
      store.emit();
    } else {
      pdfQueue.push({ file, pdfDoc });
      if (pdfQueue.length === 1) {
        openPdfModal(pdfQueue[0]);
      }
    }
  } catch (err) {
    console.error('PDF 解析失败:', err);
    alert(`无法解析 PDF：${file.name}\n${err.message || err}`);
  }
}

/**
 * 渲染 PDF 单页到 dataURL
 * @param {PDFDocumentProxy} pdfDoc
 * @param {number} pageNum
 * @param {number} scale 缩放倍率（1 = 96dpi，2 = 高清）
 */
async function renderPdfPageToDataURL(pdfDoc, pageNum, scale = 1.5) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width  = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx,
    viewport,
    intent: 'print'
  }).promise;
  return canvas.toDataURL('image/png');
}

async function renderPdfPageToCanvas(pdfDoc, pageNum, canvas, scale) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  canvas.width  = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx,
    viewport,
    intent: 'print'
  }).promise;
  return viewport;
}

function getImageDims(dataURL) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = dataURL;
  });
}

/* ============== PDF 弹层 ============== */
function openPdfModal(item) {
  currentPdf = item;
  currentPdf.selected = new Set();
  // 默认全选
  for (let i = 1; i <= item.pdfDoc.numPages; i++) currentPdf.selected.add(i);

  const modal = document.getElementById('pdfModal');
  const meta = document.getElementById('pdfFileMeta');
  const pages = document.getElementById('pdfPages');
  const importBtn = document.getElementById('pdfImportBtn');

  meta.textContent = `${item.file.name} · ${item.pdfDoc.numPages} 页`;
  importBtn.disabled = false;
  importBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    导入 ${item.pdfDoc.numPages} 页
  `;
  pages.innerHTML = `<div class="pdf-pages__loading"><div class="spinner"></div><p>正在生成预览...</p></div>`;
  modal.hidden = false;
  updatePdfCount();
  renderPdfThumbnails();
}

function closePdfModal() {
  document.getElementById('pdfModal').hidden = true;
  pdfQueue.shift();
  if (pdfQueue.length) {
    openPdfModal(pdfQueue[0]);
  } else {
    currentPdf = null;
  }
}

function updatePdfCount() {
  if (!currentPdf) return;
  const total = currentPdf.pdfDoc.numPages;
  const sel = currentPdf.selected.size;
  document.getElementById('pdfSelectedCount').textContent = `已选 ${sel} / ${total} 页`;
  const importBtn = document.getElementById('pdfImportBtn');
  importBtn.disabled = sel === 0;
  if (sel > 0) {
    importBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      导入 ${sel} 页
    `;
  } else {
    importBtn.innerHTML = `请选择页面`;
  }
}

async function renderPdfThumbnails() {
  const pages = document.getElementById('pdfPages');
  if (!currentPdf) return;
  const pdfDoc = currentPdf.pdfDoc;
  const total = pdfDoc.numPages;

  pages.innerHTML = '';
  // 先创建占位卡片（带索引），再异步渲染
  const items = [];
  for (let i = 1; i <= total; i++) {
    const item = document.createElement('div');
    item.className = 'pdf-page is-selected';
    item.dataset.page = i;
    item.innerHTML = `
      <canvas class="pdf-page__canvas"></canvas>
      <span class="pdf-page__index">P ${i} / ${total}</span>
      <span class="pdf-page__check">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </span>
    `;
    item.addEventListener('click', () => togglePdfPage(i, item));
    pages.appendChild(item);
    items.push(item);
  }
  updatePdfCount();

  // 分批渲染缩略图（避免阻塞 UI）
  for (let i = 1; i <= total; i++) {
    try {
      const canvas = items[i - 1].querySelector('canvas');
      await renderPdfPageToCanvas(pdfDoc, i, canvas, 0.5);
    } catch (err) {
      console.error('缩略图渲染失败:', err);
    }
  }
}

function togglePdfPage(num, el) {
  if (!currentPdf) return;
  if (currentPdf.selected.has(num)) {
    currentPdf.selected.delete(num);
    el.classList.remove('is-selected');
  } else {
    currentPdf.selected.add(num);
    el.classList.add('is-selected');
  }
  updatePdfCount();
}

/* ============== 确认导入 ============== */
async function confirmPdfImport() {
  if (!currentPdf || currentPdf.selected.size === 0) return;
  const importBtn = document.getElementById('pdfImportBtn');
  const pdfDoc = currentPdf.pdfDoc;
  const fileName = currentPdf.file.name.replace(/\.pdf$/i, '');
  const total = currentPdf.selected.size;
  let done = 0;

  importBtn.disabled = true;
  importBtn.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div> 渲染中 0 / ${total}...`;

  // 按页码顺序导入
  const sortedPages = [...currentPdf.selected].sort((a, b) => a - b);
  for (const pageNum of sortedPages) {
    try {
      const dataURL = await renderPdfPageToDataURL(pdfDoc, pageNum, 2.5);
      const dims = await getImageDims(dataURL);
      store.images.push({
        id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: `${fileName} · p${pageNum}`,
        src: dataURL,
        w: dims.w,
        h: dims.h,
        rotate: 0
      });
      done++;
      importBtn.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div> 渲染中 ${done} / ${total}...`;
    } catch (err) {
      console.error(`第 ${pageNum} 页渲染失败:`, err);
    }
  }
  sortImagesByName(store.images);
  store.emit();
  closePdfModal();
}

/* ============== PDF 弹层事件绑定 ============== */
function bindPdfModal() {
  const modal = document.getElementById('pdfModal');
  modal.addEventListener('click', e => {
    if (e.target.dataset.pdfClose !== undefined) closePdfModal();
  });
  document.getElementById('pdfSelectAll').addEventListener('click', () => {
    if (!currentPdf) return;
    for (let i = 1; i <= currentPdf.pdfDoc.numPages; i++) currentPdf.selected.add(i);
    syncPdfCards();
    updatePdfCount();
    setActiveChip('all');
  });
  document.getElementById('pdfSelectNone').addEventListener('click', () => {
    if (!currentPdf) return;
    currentPdf.selected.clear();
    syncPdfCards();
    updatePdfCount();
    setActiveChip('none');
  });
  document.getElementById('pdfSelectInvert').addEventListener('click', () => {
    if (!currentPdf) return;
    const next = new Set();
    for (let i = 1; i <= currentPdf.pdfDoc.numPages; i++) {
      if (!currentPdf.selected.has(i)) next.add(i);
    }
    currentPdf.selected = next;
    syncPdfCards();
    updatePdfCount();
    setActiveChip('invert');
  });
  document.getElementById('pdfImportBtn').addEventListener('click', confirmPdfImport);
  // Esc 关闭
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('pdfModal').hidden) closePdfModal();
  });
}

function syncPdfCards() {
  const cards = document.querySelectorAll('#pdfPages .pdf-page');
  cards.forEach(c => {
    const p = +c.dataset.page;
    c.classList.toggle('is-selected', currentPdf.selected.has(p));
  });
}

function setActiveChip(which) {
  document.querySelectorAll('.modal__toolbar-left .chipbtn').forEach(b => b.classList.remove('is-active'));
  const map = { all: 'pdfSelectAll', none: 'pdfSelectNone', invert: 'pdfSelectInvert' };
  document.getElementById(map[which])?.classList.add('is-active');
}
