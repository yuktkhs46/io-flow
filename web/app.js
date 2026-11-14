/* 産業連関フロー — 令和2年産業連関表のビューア */
(() => {
  "use strict";
  const DATA = JSON.parse(document.getElementById("io-data").textContent);

  // ---------------------------------------------------------------- 基本ユーティリティ
  const $ = (s) => document.querySelector(s);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // 値の単位は 10億円
  function money(v) {
    const a = Math.abs(v);
    if (a >= 1000) return (v / 1000).toLocaleString("ja-JP", { maximumFractionDigits: a >= 100000 ? 0 : 1 }) + "兆円";
    return (v * 10).toLocaleString("ja-JP", { maximumFractionDigits: a >= 10 ? 0 : 1 }) + "億円";
  }
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";

  // ---------------------------------------------------------------- 産業グループ（色の割り当て）
  const GROUPS = ["農林水産・鉱業", "生活関連製造", "素材製造", "加工組立製造",
    "建設・インフラ", "商業・金融・不動産", "運輸・情報通信", "公務・サービス"];
  function groupOf(level, code) {
    if (level === "13") {
      return { "01": 0, "02": 0, "03": 3, "04": 4, "05": 4, "06": 5, "07": 5, "08": 5,
        "09": 6, "10": 6, "11": 7, "12": 7, "13": 7 }[code];
    }
    const p = +code.slice(0, 2);
    if (p < 11) return 0;
    if ([11, 15, 16, 19, 39].includes(p)) return 1;
    if (p >= 20 && p <= 28) return 2;
    if (p >= 29 && p <= 35) return 3;
    if (p >= 41 && p <= 48) return 4;
    if (p >= 51 && p <= 55) return 5;
    if (p >= 57 && p <= 59) return 6;
    return 7;
  }
  const groupName = (level, g) => (level === "13" && g === 3 ? "製造業" : GROUPS[g]);
  const groupsUsed = (level) => (level === "13" ? [0, 3, 4, 5, 6, 7] : [0, 1, 2, 3, 4, 5, 6, 7]);
  const gColor = (g) => css(`--s${g + 1}`);

  // ---------------------------------------------------------------- モデル計算
  function invert(M) {
    const n = M.length;
    const a = M.map((r, i) => { const row = new Float64Array(2 * n); row.set(r); row[n + i] = 1; return row; });
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      [a[c], a[p]] = [a[p], a[c]];
      const d = a[c][c];
      for (let k = 0; k < 2 * n; k++) a[c][k] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = a[r][c];
        if (f !== 0) for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k];
      }
    }
    return a.map((row) => Array.from(row.slice(n)));
  }

  const cache = {};
  const yearsOf = (level) => Object.keys(DATA.levels[level].years).sort();
  const curYear = (level) => { const ys = yearsOf(level); return ys.includes(state.year) ? state.year : ys[ys.length - 1]; };
  function model(level, year = curYear(level)) {
    const key = level + "/" + year;
    if (cache[key]) return cache[key];
    const LV = DATA.levels[level];
    const t = { sectors: LV.sectors, ...LV.years[year] };
    const n = t.sectors.length;
    const { Z, X } = t;
    const A = Z.map((row) => row.map((v, j) => (X[j] ? v / X[j] : 0)));
    const sales = Z.map(sum);                                  // 中間需要計（行和）
    const inputs = X.map((_, j) => sum(Z.map((r) => r[j])));   // 中間投入計（列和）
    const fdDom = t.fd.filter((f) => f.name !== "輸出");
    const exportV = t.fd.find((f) => f.name === "輸出").values;
    const M = t.imports.map((v) => -v);                        // 輸入（正値）
    const domDemand = X.map((_, i) => sales[i] + sum(fdDom.map((f) => f.values[i])));
    const m = X.map((_, i) => (domDemand[i] > 0 ? M[i] / domDemand[i] : 0));
    const L = A.map((row, i) => row.map((v, j) => (i === j ? 1 : 0) - (1 - m[i]) * v));
    const B = invert(L);
    const colB = X.map((_, j) => sum(B.map((r) => r[j])));
    const rowB = B.map(sum);
    const meanB = sum(colB) / n;
    const vaTot = X.map((_, j) => sum(t.va.map((v) => v.values[j])));
    const wage = t.va.find((v) => v.name === "雇用者所得").values;
    const groups = t.sectors.map((s) => groupOf(level, s.code));
    return (cache[key] = {
      level, year, n, t, Z, X, A, B, M, m, sales, inputs, exportV, domDemand, groups,
      fdDomTotal: X.map((_, i) => sum(fdDom.map((f) => f.values[i]))),
      influence: colB.map((v) => v / meanB),
      sensitivity: rowB.map((v) => v / meanB),
      vaRate: vaTot.map((v, j) => (X[j] ? v / X[j] : 0)),
      wageRate: wage.map((v, j) => (X[j] ? v / X[j] : 0)),
      vaTot,
    });
  }

  // ---------------------------------------------------------------- 状態とルーティング
  const VIEWS = ["flow", "sector", "matrix", "ripple", "position", "compare"];
  const state = { level: "37", year: "2020", cmpA: "2015", cmpB: "2020", cmpMetric: "X", cmpMatrix: "A", view: "flow", gran: "group", sector: {}, metric: "Z", rippleKind: "dom", posGroup: -1 };
  try { const s = localStorage.getItem("io-flow-level"); if (s && DATA.levels[s]) state.level = s; } catch (e) { /* 保存なしでも動作 */ }

  function defaultSector(level) {
    const mo = model(level);
    if (state.sector[level] == null) {
      // 既定は「輸送機械」系、なければ最大の製造業
      const idx = mo.t.sectors.findIndex((s) => /^(輸送機械|乗用車)$/.test(s.name));
      state.sector[level] = idx >= 0 ? idx : mo.X.indexOf(Math.max(...mo.X));
    }
    return state.sector[level];
  }

  function setSeg(sel, attr, val) {
    document.querySelectorAll(`${sel} button`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === val)));
  }

  function route() {
    const h = location.hash.replace("#", "");
    state.view = VIEWS.includes(h) ? h : "flow";
    VIEWS.forEach((v) => { $("#v-" + v).hidden = v !== state.view; });
    document.querySelectorAll(".tabs a").forEach((a) => {
      if (a.getAttribute("href") === "#" + state.view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    render();
  }

  function goSector(i) {
    state.sector[state.level] = i;
    if (location.hash === "#sector") render(); else location.hash = "sector";
    window.scrollTo({ top: 0 });
  }

  function render() {
    hideTip();
    setSeg("#level-seg", "level", state.level);
    renderYearSeg();
    ({ flow: renderFlow, sector: renderSector, matrix: renderMatrix, ripple: renderRipple, position: renderPosition, compare: renderCompare })[state.view]();
  }

  // ---------------------------------------------------------------- ツールチップ
  const tip = $("#tip");
  function showTip(ev, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - 14;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  function hideTip() { tip.hidden = true; }

  function containerWidth(svgSel, min) {
    const w = $(svgSel).parentElement.clientWidth;
    return Math.max(min, w);
  }

  // ---------------------------------------------------------------- サンキー図（共通）
  // nodes: {id, name, col, color, kind, sector?}, links: {source, target, value, color}
  function drawSankey(svgSel, nodes, links, opt) {
    const svg = d3.select(svgSel);
    svg.selectAll("*").remove();
    const W = containerWidth(svgSel, opt.minWidth || 760);
    const counts = [0, 0, 0];
    nodes.forEach((n) => counts[n.col]++);
    const maxCol = Math.max(...counts);
    const H = Math.max(opt.minHeight || 420, maxCol * (opt.rowPx || 26) + 60);
    const mL = opt.marginL ?? 200, mR = opt.marginR ?? 200, mT = 34, mB = 12;
    svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);

    const used = new Set();
    links.forEach((l) => { used.add(l.source); used.add(l.target); });
    nodes = nodes.filter((n) => used.has(n.id));

    const sk = d3.sankey()
      .nodeId((d) => d.id)
      .nodeAlign((d) => d.col)
      .nodeWidth(opt.nodeWidth || 14)
      .nodePadding(Math.max(3, Math.min(12, (H - mT - mB) / maxCol * 0.25)))
      .nodeSort(null)
      .linkSort(null)
      .extent([[mL, mT], [W - mR, H - mB]]);
    const graph = sk({ nodes: nodes.map((d) => ({ ...d })), links: links.map((d) => ({ ...d })) });

    // 列見出し
    const xs = [mL, (W) / 2, W - mR];
    (opt.colHeads || []).forEach((h, i) => {
      svg.append("text").attr("class", "colhead").attr("x", xs[i]).attr("y", 16)
        .attr("text-anchor", i === 0 ? "start" : i === 1 ? "middle" : "end").text(h);
    });

    const gLinks = svg.append("g").attr("fill", "none");
    const link = gLinks.selectAll("path").data(graph.links).join("path")
      .attr("d", d3.sankeyLinkHorizontal())
      .attr("stroke", (d) => d.color)
      .attr("stroke-opacity", 0.38)
      .attr("stroke-width", (d) => Math.max(1, d.width))
      .on("pointermove", (ev, d) => {
        const sOut = d.source.value, tIn = d.target.value;
        showTip(ev, `<b>${esc(d.source.name)}</b> → <b>${esc(d.target.name)}</b><br>` +
          `<span class="n">${money(d.value)}</span><br>` +
          `<span style="color:var(--ink-3)">${esc(d.source.name)}の流出の ${pct(d.value / sOut)}／${esc(d.target.name)}の流入の ${pct(d.value / tIn)}</span>`);
        link.attr("stroke-opacity", (l) => (l === d ? 0.75 : 0.18));
      })
      .on("pointerleave", () => { hideTip(); link.attr("stroke-opacity", 0.38); });

    const gNodes = svg.append("g");
    const node = gNodes.selectAll("g").data(graph.nodes).join("g");
    node.append("rect")
      .attr("x", (d) => d.x0).attr("y", (d) => d.y0)
      .attr("width", (d) => d.x1 - d.x0).attr("height", (d) => Math.max(1, d.y1 - d.y0))
      .attr("rx", 2)
      .attr("fill", (d) => d.color)
      .style("cursor", (d) => (d.sector != null && opt.onSector ? "pointer" : "default"))
      .on("pointermove", (ev, d) => {
        showTip(ev, `<b>${esc(d.name)}</b><br><span class="n">${money(d.value)}</span>` +
          (d.note ? `<br><span style="color:var(--ink-3)">${esc(d.note)}</span>` : "") +
          (d.sector != null && opt.onSector ? `<br><span style="color:var(--ink-3)">クリックで産業別フローへ</span>` : ""));
        link.attr("stroke-opacity", (l) => (l.source === d || l.target === d ? 0.7 : 0.12));
      })
      .on("pointerleave", () => { hideTip(); link.attr("stroke-opacity", 0.38); })
      .on("click", (ev, d) => { if (d.sector != null && opt.onSector) opt.onSector(d.sector); });

    const minLabelH = opt.minLabelH ?? 7;
    const label = node.filter((d) => d.y1 - d.y0 >= minLabelH || d.col === 1).append("text")
      .attr("class", "halo")
      .attr("y", (d) => (d.y0 + d.y1) / 2)
      .attr("dy", "0.35em")
      .attr("font-size", opt.fontSize || 12);
    label.each(function (d) {
      const t = d3.select(this);
      const left = d.col === 0, mid = d.col === 1;
      t.attr("x", left ? d.x0 - 6 : d.x1 + 6).attr("text-anchor", left ? "end" : "start");
      if (mid && opt.midLabelLeft) t.attr("x", d.x0 - 6).attr("text-anchor", "end");
      t.append("tspan").text(d.name);
      t.append("tspan").attr("class", "num muted").attr("dx", 6).text(money(d.value));
    });
    return graph;
  }

  const negName = (nm) => (nm.includes("控除") ? nm : nm + "（マイナス）");
  // 負の値は反対側へ移す（例：経常補助金は右側の流出、在庫取り崩しは左側の流入）
  function addSigned(links, from, to, v, negFrom, negTo) {
    if (v > 0) links.push({ source: from, target: to, value: v });
    else if (v < 0) links.push({ source: negFrom, target: negTo, value: -v });
  }

  // ---------------------------------------------------------------- 全体フロー
  function renderFlow() {
    const mo = model(state.level);
    const { t, n, Z, X, M } = mo;
    let gran = state.gran;
    if (state.level === "108") gran = "group";
    setSeg("#flow-gran", "gran", gran);
    document.querySelector('#flow-gran [data-gran="sector"]').disabled = state.level === "108";

    // tiles
    const totX = sum(X), totZ = sum(mo.sales), totVA = sum(mo.vaTot);
    const totFD = sum(mo.fdDomTotal), totEx = sum(mo.exportV), totM = sum(M);
    const wage = sum(t.va.find((v) => v.name === "雇用者所得").values);
    $("#flow-tiles").innerHTML = [
      ["国内生産額", totX, "全産業の生産の合計"],
      ["中間取引", totZ, `生産額の ${pct(totZ / totX)} が産業間の取引`],
      ["粗付加価値", totVA, `うち雇用者所得 ${money(wage)}`],
      ["国内最終需要", totFD, "消費・投資・在庫"],
      ["輸出", totEx, `生産額の ${pct(totEx / totX)}`],
      ["輸入", totM, `国内需要の ${pct(totM / (totZ + totFD))}`],
    ].map(([k, v, d]) => `<div class="tile"><span class="k">${k}</span><span class="v">${(v / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}<small>兆円</small></span><span class="d">${d}</span></div>`).join("");

    // units
    const unitOf = (i) => (gran === "group" ? mo.groups[i] : i);
    const unitIds = gran === "group" ? groupsUsed(state.level) : d3.range(n);
    const unitName = (u) => (gran === "group" ? groupName(state.level, u) : t.sectors[u].name);
    const unitColor = (u) => (gran === "group" ? gColor(u) : gColor(mo.groups[u]));

    const nodes = [], links = [];
    const cVA = css("--node-va"), cFD = css("--node-fd"), cIM = css("--node-imp");
    unitIds.forEach((u) => nodes.push({ id: "in" + u, name: unitName(u), col: 0, color: unitColor(u), sector: gran === "sector" ? u : null, note: "中間投入としての販売" }));
    t.va.forEach((v, k) => nodes.push({ id: "va" + k, name: v.name, col: 0, color: cVA, note: "粗付加価値" }));
    nodes.push({ id: "imp", name: "輸入", col: 0, color: cIM, note: "国内需要のうち輸入品で賄われた分" });
    t.fd.forEach((f, k) => nodes.push({ id: "fdneg" + k, name: f.name + "（減少）", col: 0, color: cFD }));
    unitIds.forEach((u) => nodes.push({ id: "mid" + u, name: unitName(u), col: 1, color: unitColor(u), sector: gran === "sector" ? u : null, note: "総供給 = 国内生産額 + 輸入" }));
    unitIds.forEach((u) => nodes.push({ id: "out" + u, name: unitName(u), col: 2, color: unitColor(u), sector: gran === "sector" ? u : null, note: "中間投入としての購入" }));
    t.fd.forEach((f, k) => nodes.push({ id: "fd" + k, name: f.name, col: 2, color: cFD, note: "最終需要" }));
    t.va.forEach((v, k) => nodes.push({ id: "vaneg" + k, name: negName(v.name), col: 2, color: cVA, note: "マイナスの付加価値項目（右側に移して表示）" }));

    const acc = new Map();
    const add = (s, tg, v) => { const key = s + "|" + tg; acc.set(key, (acc.get(key) || 0) + v); };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (Z[i][j] > 0) add("in" + unitOf(i), "mid" + unitOf(j), Z[i][j]);
      if (Z[i][j] > 0) add("mid" + unitOf(i), "out" + unitOf(j), Z[i][j]);
    }
    const tmp = [];
    for (let j = 0; j < n; j++) {
      t.va.forEach((v, k) => addSigned(tmp, "va" + k, "mid" + unitOf(j), v.values[j], "mid" + unitOf(j), "vaneg" + k));
      if (M[j] > 0) tmp.push({ source: "imp", target: "mid" + unitOf(j), value: M[j] });
      t.fd.forEach((f, k) => addSigned(tmp, "mid" + unitOf(j), "fd" + k, f.values[j], "fdneg" + k, "mid" + unitOf(j)));
    }
    tmp.forEach((l) => add(l.source, l.target, l.value));
    const total = sum([...acc.values()]);
    const thresh = gran === "sector" && state.level !== "13" ? total * 0.0004 : 0;
    let dropped = 0;
    acc.forEach((v, key) => {
      if (v <= thresh) { dropped += v; return; }
      const [s, tg] = key.split("|");
      links.push({ source: s, target: tg, value: v });
    });
    const byId = new Map(nodes.map((d) => [d.id, d]));
    links.forEach((l) => {
      // 流れは送り手の色で塗る
      l.color = byId.get(l.source).color;
    });

    const many = nodes.filter((d) => d.col === 1).length > 16;
    drawSankey("#flow-svg", nodes, links, {
      colHeads: ["費用：どこから買ったか", "産業（総供給）", "販路：どこへ売ったか"],
      rowPx: many ? 20 : 30, minHeight: many ? 700 : 560, minWidth: 820,
      marginL: 210, marginR: 210, fontSize: many ? 11 : 12,
      onSector: gran === "sector" ? goSector : null,
      midLabelLeft: false,
    });

    $("#flow-legend").innerHTML = (gran === "group" ? groupsUsed(state.level) : [...new Set(mo.groups)])
      .map((g) => `<span><i style="background:${gColor(g)}"></i>${groupName(state.level, g)}</span>`).join("") +
      `<span><i style="background:${cVA}"></i>付加価値</span><span><i style="background:${cFD}"></i>最終需要</span><span><i style="background:${cIM}"></i>輸入</span>`;
    $("#flow-note").textContent =
      (state.level === "108" ? "108部門では見やすさのため産業グループ単位で表示しています。部門ごとの詳細は「産業別フロー」「取引マトリクス」をご覧ください。" : "") +
      (dropped > 0 ? `表示を簡潔にするため、${money(thresh)}以下の細い流れ（合計 ${money(dropped)}）を省いています。` : "") +
      "マイナスの項目（経常補助金、在庫の減少など）は反対側に移して描いています。";
  }

  // ---------------------------------------------------------------- 産業別フロー
  function sectorOptions(sel, level, current) {
    const mo = model(level);
    sel.innerHTML = groupsUsed(level).map((g) => {
      const opts = mo.t.sectors.map((s, i) => [s, i]).filter(([, i]) => mo.groups[i] === g)
        .map(([s, i]) => `<option value="${i}"${i === current ? " selected" : ""}>${esc(s.code)} ${esc(s.name)}</option>`).join("");
      return opts ? `<optgroup label="${esc(groupName(level, g))}">${opts}</optgroup>` : "";
    }).join("");
  }

  function renderSector() {
    const mo = model(state.level);
    const { t, n, Z, X, M } = mo;
    const s = defaultSector(state.level);
    sectorOptions($("#sector-select"), state.level, s);
    const sec = t.sectors[s];
    $("#sector-title").innerHTML = `${esc(sec.name)}<span class="chip">${esc(groupName(state.level, mo.groups[s]))}</span>`;

    const interIn = mo.inputs[s], interOut = mo.sales[s];
    $("#sector-kpis").innerHTML = [
      ["国内生産額", money(X[s]), `全産業の ${pct(X[s] / sum(X))}`],
      ["粗付加価値率", pct(mo.vaRate[s]), `うち雇用者所得 ${pct(mo.wageRate[s])}`],
      ["中間投入率", pct(interIn / X[s]), "生産額に占める原材料等の購入"],
      ["輸入係数", pct(mo.m[s]), "国内需要に占める輸入品"],
      ["影響力係数", mo.influence[s].toFixed(3), mo.influence[s] >= 1 ? "平均より波及が大きい" : "平均より波及が小さい"],
      ["感応度係数", mo.sensitivity[s].toFixed(3), mo.sensitivity[s] >= 1 ? "他産業の影響を受けやすい" : "他産業の影響を受けにくい"],
    ].map(([k, v, d]) => `<div class="tile"><span class="k">${k}</span><span class="v">${v}</span><span class="d">${d}</span></div>`).join("");

    const K = state.level === "13" ? 13 : 10;
    const cVA = css("--node-va"), cFD = css("--node-fd"), cIM = css("--node-imp"), cOther = css("--line-2");
    const nodes = [], links = [];
    const mid = "mid";
    // 購入先
    const ins = d3.range(n).map((k) => [k, Z[k][s]]).filter((d) => d[1] > 0).sort((a, b) => b[1] - a[1]);
    ins.slice(0, K).forEach(([k, v]) => {
      nodes.push({ id: "in" + k, name: t.sectors[k].name, col: 0, color: gColor(mo.groups[k]), sector: k, note: `投入係数 ${mo.A[k][s].toFixed(4)}` });
      links.push({ source: "in" + k, target: mid, value: v, color: gColor(mo.groups[k]) });
    });
    const restIn = sum(ins.slice(K).map((d) => d[1]));
    if (restIn > 0) {
      nodes.push({ id: "inrest", name: `その他の産業（${ins.length - K}）`, col: 0, color: cOther });
      links.push({ source: "inrest", target: mid, value: restIn, color: cOther });
    }
    t.va.forEach((v, k) => {
      nodes.push({ id: "va" + k, name: v.name, col: 0, color: cVA, note: "粗付加価値" });
      nodes.push({ id: "vaneg" + k, name: negName(v.name), col: 2, color: cVA, note: "マイナスの付加価値項目（右側に移して表示）" });
      addSigned(links, "va" + k, mid, v.values[s], mid, "vaneg" + k);
    });
    if (M[s] > 0) {
      nodes.push({ id: "imp", name: "輸入", col: 0, color: cIM, note: "同じ製品の輸入（国内生産と競合）" });
      links.push({ source: "imp", target: mid, value: M[s] });
    }
    nodes.push({ id: mid, name: sec.name, col: 1, color: gColor(mo.groups[s]), note: "総供給 = 国内生産額 + 輸入" });
    // 販売先
    const outs = d3.range(n).map((j) => [j, Z[s][j]]).filter((d) => d[1] > 0).sort((a, b) => b[1] - a[1]);
    outs.slice(0, K).forEach(([j, v]) => {
      nodes.push({ id: "out" + j, name: t.sectors[j].name, col: 2, color: gColor(mo.groups[j]), sector: j });
      links.push({ source: mid, target: "out" + j, value: v });
    });
    const restOut = sum(outs.slice(K).map((d) => d[1]));
    if (restOut > 0) {
      nodes.push({ id: "outrest", name: `その他の産業（${outs.length - K}）`, col: 2, color: cOther });
      links.push({ source: mid, target: "outrest", value: restOut });
    }
    t.fd.forEach((f, k) => {
      nodes.push({ id: "fd" + k, name: f.name, col: 2, color: cFD, note: "最終需要" });
      nodes.push({ id: "fdneg" + k, name: f.name + "（減少）", col: 0, color: cFD });
      addSigned(links, mid, "fd" + k, f.values[s], "fdneg" + k, mid);
    });
    const nodeById = new Map(nodes.map((d) => [d.id, d]));
    links.forEach((l) => { if (!l.color) l.color = l.source === mid ? nodeById.get(l.target).color : nodeById.get(l.source).color; });

    drawSankey("#sector-svg", nodes, links, {
      colHeads: ["費用：どこから買ったか", "", "販路：どこへ売ったか"],
      rowPx: 30, minHeight: 520, minWidth: 760, marginL: 220, marginR: 220,
      onSector: goSector, midLabelLeft: false,
    });

    // tables
    const rowsIn = ins.slice(0, 15).map(([k, v]) =>
      `<tr><td><span class="sw" style="background:${gColor(mo.groups[k])}"></span><button type="button" class="linkish" data-sec="${k}">${esc(t.sectors[k].name)}</button></td><td class="n">${money(v)}</td><td class="n">${mo.A[k][s].toFixed(4)}</td></tr>`).join("");
    $("#sector-in").innerHTML = `<table class="data"><thead><tr><th>購入先</th><th class="n">購入額</th><th class="n">投入係数</th></tr></thead><tbody>${rowsIn}</tbody></table>`;
    const totalDemand = interOut + sum(t.fd.map((f) => f.values[s]));
    const outRows = outs.slice(0, 12).map(([j, v]) => [t.sectors[j].name, v, j, gColor(mo.groups[j])]);
    t.fd.forEach((f) => { if (Math.abs(f.values[s]) > 0) outRows.push([f.name + "（最終需要）", f.values[s], null, cFD]); });
    outRows.sort((a, b) => b[1] - a[1]);
    $("#sector-out").innerHTML = `<table class="data"><thead><tr><th>販売先</th><th class="n">販売額</th><th class="n">構成比</th></tr></thead><tbody>${outRows.slice(0, 15).map(([nm, v, j, c]) =>
      `<tr><td><span class="sw" style="background:${c}"></span>${j != null ? `<button type="button" class="linkish" data-sec="${j}">${esc(nm)}</button>` : esc(nm)}</td><td class="n">${money(v)}</td><td class="n">${pct(v / totalDemand)}</td></tr>`).join("")}</tbody></table>`;
  }

  // ---------------------------------------------------------------- 取引マトリクス
  function renderMatrix() {
    const mo = model(state.level);
    const { t, n } = mo;
    setSeg("#matrix-metric", "metric", state.metric);
    const src = { Z: mo.Z, A: mo.A, B: mo.B }[state.metric];
    const metricName = { Z: "取引額", A: "投入係数", B: "逆行列係数" }[state.metric];
    const fmtV = state.metric === "Z" ? money : (v) => v.toFixed(4);

    const cell = n <= 13 ? 34 : n <= 37 ? 17 : 10;
    const labelW = n <= 37 ? 170 : 150;
    const fs = n <= 37 ? 12 : 9;
    const trunc = (s) => (n > 37 && s.length > 12 ? s.slice(0, 11) + "…" : s);
    const W = labelW + n * cell + 10, H = labelW + n * cell + 10;
    const svg = d3.select("#matrix-svg");
    svg.selectAll("*").remove();
    svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);

    const vals = [];
    src.forEach((r, i) => r.forEach((v, j) => { if (v > 0 && !(state.metric === "B" && i === j)) vals.push(v); }));
    vals.sort((a, b) => a - b);
    const lo = d3.quantile(vals, 0.05) || 1e-6, hi = vals[vals.length - 1];
    const color = d3.scaleSequentialLog([lo, hi], d3.interpolateLab(css("--seq-lo"), css("--seq-hi"))).clamp(true);
    const surface = css("--surface");

    const g = svg.append("g").attr("transform", `translate(${labelW},${labelW})`);
    const cells = [];
    src.forEach((r, i) => r.forEach((v, j) => cells.push({ i, j, v })));
    g.selectAll("rect").data(cells).join("rect")
      .attr("x", (d) => d.j * cell).attr("y", (d) => d.i * cell)
      .attr("width", cell - (cell > 10 ? 1 : 0.5)).attr("height", cell - (cell > 10 ? 1 : 0.5))
      .attr("fill", (d) => (d.v > 0 ? color(d.v) : surface))
      .on("pointermove", (ev, d) => {
        showTip(ev, `<b>${esc(t.sectors[d.i].name)}</b> → <b>${esc(t.sectors[d.j].name)}</b><br>${metricName}：<span class="n">${fmtV(d.v)}</span>` +
          (state.metric === "Z" ? `<br><span style="color:var(--ink-3)">購入側の生産額の ${pct(mo.A[d.i][d.j], 2)}</span>` : ""));
        rowL.attr("font-weight", (_, k) => (k === d.i ? 700 : 400));
        colL.attr("font-weight", (_, k) => (k === d.j ? 700 : 400));
      })
      .on("pointerleave", () => { hideTip(); rowL.attr("font-weight", 400); colL.attr("font-weight", 400); });
    const rowL = svg.append("g").selectAll("text").data(t.sectors).join("text")
      .attr("x", labelW - 6).attr("y", (_, i) => labelW + i * cell + cell / 2).attr("dy", "0.35em")
      .attr("text-anchor", "end").attr("font-size", fs).text((d) => trunc(d.name))
      .style("cursor", "pointer").on("click", (_, d) => goSector(t.sectors.indexOf(d)));
    const colL = svg.append("g").selectAll("text").data(t.sectors).join("text")
      .attr("transform", (_, j) => `translate(${labelW + j * cell + cell / 2},${labelW - 6}) rotate(${n > 37 ? -90 : -60})`)
      .attr("dy", "0.35em").attr("font-size", fs).text((d) => trunc(d.name))
      .style("cursor", "pointer").on("click", (_, d) => goSector(t.sectors.indexOf(d)));
    rowL.append("title").text((d) => d.name);
    colL.append("title").text((d) => d.name);
    svg.append("text").attr("class", "colhead").attr("x", 4).attr("y", labelW - 6).text("売り手 ↓ ／ 買い手 →");

    // legend (gradient)
    const lw = 220;
    const id = "mgrad";
    const ticks = color.ticks(4).filter((v, i, a) => a.length <= 5 || i % 2 === 0);
    $("#matrix-legend").innerHTML = `<svg width="${lw + 40}" height="40" role="img" aria-label="色の凡例">
      <defs><linearGradient id="${id}">${d3.range(0, 1.01, 0.1).map((p) => `<stop offset="${p}" stop-color="${color(Math.exp(Math.log(lo) + p * (Math.log(hi) - Math.log(lo))))}"/>`).join("")}</linearGradient></defs>
      <rect x="10" y="4" width="${lw}" height="10" rx="2" fill="url(#${id})"/>
      ${ticks.map((v) => { const x = 10 + (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * lw; return x >= 10 && x <= 10 + lw ? `<line x1="${x}" x2="${x}" y1="14" y2="18" stroke="var(--ink-3)"/><text x="${x}" y="30" font-size="10" text-anchor="middle" class="num sub">${state.metric === "Z" ? (v >= 1000 ? v / 1000 + "兆" : v * 10 + "億") : v}</text>` : ""; }).join("")}
    </svg>`;
    $("#matrix-note").textContent = {
      Z: "取引額：行の産業が列の産業に販売した額。対角線上は同一産業内の取引です。",
      A: "投入係数：列の産業が1単位生産するのに必要な、行の産業からの投入量（取引額 ÷ 購入側の国内生産額）。",
      B: "逆行列係数：列の産業に1単位の最終需要が生じたとき、行の産業で最終的に誘発される生産量。対角成分（1以上）は色の目盛から除いています。",
    }[state.metric];
  }

  // ---------------------------------------------------------------- 波及効果
  function renderRipple() {
    const mo = model(state.level);
    const { t, n, B, m } = mo;
    const s = defaultSector(state.level);
    sectorOptions($("#ripple-sector"), state.level, s);
    setSeg("#ripple-kind", "kind", state.rippleKind);
    const amountOku = Math.max(0, +$("#ripple-amount").value || 0);
    const df = amountOku / 10; // 10億円
    const direct = state.rippleKind === "dom" ? (1 - m[s]) * df : df;
    const dx = d3.range(n).map((i) => B[i][s] * direct);
    const totX = sum(dx);
    const va = sum(dx.map((v, j) => v * mo.vaRate[j]));
    const wage = sum(dx.map((v, j) => v * mo.wageRate[j]));
    const leak = df - direct;

    $("#ripple-tiles").innerHTML = [
      ["生産誘発額", money(totX), `需要増加額の ${df ? (totX / df).toFixed(2) : "–"} 倍`],
      ["うち直接効果", money(direct), state.rippleKind === "dom" ? `輸入で賄われる ${money(leak)} を除く` : "輸出は全額が国内生産"],
      ["うち間接波及", money(totX - direct), "取引の連鎖で生じる生産"],
      ["粗付加価値誘発額", money(va), "GDPへの寄与に相当"],
      ["雇用者所得誘発額", money(wage), "賃金として家計に渡る分"],
    ].map(([k, v, d]) => `<div class="tile"><span class="k">${k}</span><span class="v">${v}</span><span class="d">${d}</span></div>`).join("");

    const rows = dx.map((v, i) => ({ i, name: t.sectors[i].name, total: v, direct: i === s ? direct : 0 }))
      .map((r) => ({ ...r, indirect: r.total - r.direct })).sort((a, b) => b.total - a.total);
    const top = rows.slice(0, 15);
    const rest = rows.slice(15);
    if (rest.length) top.push({ i: null, name: `その他（${rest.length}産業）`, total: sum(rest.map((r) => r.total)), direct: 0, indirect: sum(rest.map((r) => r.indirect)) });

    const c1 = css("--s1"), c2 = css("--s2");
    $("#ripple-legend").innerHTML = `<span><i style="background:${c1}"></i>直接効果</span><span><i style="background:${c2}"></i>間接波及</span>`;
    const W = containerWidth("#ripple-svg", 560), rowH = 26;
    const mL = 190, mR = 90, H = top.length * rowH + 30;
    const svg = d3.select("#ripple-svg");
    svg.selectAll("*").remove();
    svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
    const x = d3.scaleLinear([0, d3.max(top, (d) => d.total) || 1], [mL, W - mR]).nice();
    const y = (i) => 4 + i * rowH;
    const bh = 16;
    svg.append("g").selectAll("line").data(x.ticks(5)).join("line")
      .attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", H - 22).attr("stroke", css("--line"));
    svg.append("g").selectAll("text").data(x.ticks(5)).join("text")
      .attr("x", x).attr("y", H - 6).attr("text-anchor", "middle").attr("font-size", 11).attr("class", "num muted").text((v) => money(v));
    const g = svg.append("g").selectAll("g").data(top).join("g").attr("transform", (_, i) => `translate(0,${y(i)})`);
    g.append("text").attr("x", mL - 8).attr("y", bh / 2).attr("dy", "0.35em").attr("text-anchor", "end").attr("font-size", 12)
      .text((d) => (d.name.length > 14 ? d.name.slice(0, 13) + "…" : d.name)).append("title").text((d) => d.name);
    const seg = (d, which) => which === "d" ? [x(0), x(d.direct)] : [x(d.direct) + (d.direct > 0 ? 2 : 0), x(d.total)];
    ["d", "i"].forEach((w) => {
      g.append("rect").attr("y", 0).attr("height", bh).attr("rx", 3)
        .attr("x", (d) => seg(d, w)[0]).attr("width", (d) => Math.max(0, seg(d, w)[1] - seg(d, w)[0]))
        .attr("fill", w === "d" ? c1 : c2);
    });
    g.append("text").attr("class", "num sub").attr("font-size", 11).attr("y", bh / 2).attr("dy", "0.35em")
      .attr("x", (d) => x(d.total) + 6).text((d) => money(d.total));
    g.append("rect").attr("x", 0).attr("width", W).attr("height", rowH).attr("y", -4).attr("fill", "transparent")
      .on("pointermove", (ev, d) => showTip(ev, `<b>${esc(d.name)}</b><br>生産誘発額 <span class="n">${money(d.total)}</span><br>直接 <span class="n">${money(d.direct)}</span>／間接 <span class="n">${money(d.indirect)}</span>`))
      .on("pointerleave", hideTip);

    $("#ripple-table").innerHTML = `<table class="data"><thead><tr><th>産業</th><th class="n">生産誘発額</th><th class="n">うち直接</th><th class="n">逆行列係数</th></tr></thead><tbody>${rows.map((r) =>
      `<tr><td>${esc(r.name)}</td><td class="n">${money(r.total)}</td><td class="n">${r.direct ? money(r.direct) : "–"}</td><td class="n">${B[r.i][s].toFixed(5)}</td></tr>`).join("")}</tbody></table>`;
  }

  // ---------------------------------------------------------------- 影響力・感応度
  function renderPosition() {
    const mo = model(state.level);
    const { t, n, X } = mo;
    const sel = $("#pos-group");
    sel.innerHTML = `<option value="-1">すべて</option>` + groupsUsed(state.level).map((g) => `<option value="${g}"${g === state.posGroup ? " selected" : ""}>${esc(groupName(state.level, g))}</option>`).join("");
    if (!groupsUsed(state.level).includes(state.posGroup)) state.posGroup = -1;
    sel.value = String(state.posGroup);

    const W = containerWidth("#pos-svg", 560), H = Math.min(620, Math.max(420, W * 0.6));
    const m = { l: 56, r: 20, t: 20, b: 46 };
    const svg = d3.select("#pos-svg");
    svg.selectAll("*").remove();
    svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
    const xe = d3.extent(mo.influence), ye = d3.extent(mo.sensitivity);
    const x = d3.scaleLinear([Math.min(0.6, xe[0] - 0.05), xe[1] + 0.08], [m.l, W - m.r]).nice();
    const y = d3.scaleLinear([Math.min(0.4, ye[0] - 0.1), ye[1] + 0.2], [H - m.b, m.t]).nice();
    const r = d3.scaleSqrt([0, d3.max(X)], [0, n > 37 ? 16 : 24]);
    const cLine = css("--line"), cAxis = css("--line-2");

    svg.append("g").selectAll("line").data(x.ticks(6)).join("line").attr("x1", x).attr("x2", x).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", cLine);
    svg.append("g").selectAll("line").data(y.ticks(6)).join("line").attr("y1", y).attr("y2", y).attr("x1", m.l).attr("x2", W - m.r).attr("stroke", cLine);
    svg.append("line").attr("x1", x(1)).attr("x2", x(1)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", cAxis).attr("stroke-width", 1.5);
    svg.append("line").attr("y1", y(1)).attr("y2", y(1)).attr("x1", m.l).attr("x2", W - m.r).attr("stroke", cAxis).attr("stroke-width", 1.5);
    svg.append("g").selectAll("text").data(x.ticks(6)).join("text").attr("x", x).attr("y", H - m.b + 16).attr("text-anchor", "middle").attr("font-size", 11).attr("class", "num muted").text((v) => v.toFixed(1));
    svg.append("g").selectAll("text").data(y.ticks(6)).join("text").attr("x", m.l - 8).attr("y", y).attr("dy", "0.35em").attr("text-anchor", "end").attr("font-size", 11).attr("class", "num muted").text((v) => v.toFixed(1));
    svg.append("text").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").attr("font-size", 12).attr("class", "sub").text("影響力係数 →");
    svg.append("text").attr("x", 12).attr("y", m.t + 4).attr("font-size", 12).attr("class", "sub").attr("transform", `rotate(-90 12 ${m.t + 4})`).attr("text-anchor", "end").text("感応度係数 →");
    const q = [["原材料・基盤型（両方が高い）", W - m.r - 6, m.t + 14, "end"], ["最終製品型（影響力が高い）", W - m.r - 6, H - m.b - 8, "end"],
      ["基礎サービス型（感応度が高い）", m.l + 6, m.t + 14, "start"], ["独立型（両方が低い）", m.l + 6, H - m.b - 8, "start"]];
    svg.append("g").selectAll("text").data(q).join("text").attr("x", (d) => d[1]).attr("y", (d) => d[2]).attr("text-anchor", (d) => d[3]).attr("font-size", 11).attr("class", "muted").text((d) => d[0]);

    const dot = css("--dot"), faint = css("--line-2"), surface = css("--surface");
    const hl = (i) => state.posGroup < 0 || mo.groups[i] === state.posGroup;
    const idx = d3.range(n).sort((a, b) => X[b] - X[a]);
    svg.append("g").selectAll("circle").data(idx).join("circle")
      .attr("cx", (i) => x(mo.influence[i])).attr("cy", (i) => y(mo.sensitivity[i])).attr("r", (i) => Math.max(4, r(X[i])))
      .attr("fill", (i) => (hl(i) ? dot : faint)).attr("fill-opacity", (i) => (hl(i) ? 0.55 : 0.5))
      .attr("stroke", surface).attr("stroke-width", 2).style("cursor", "pointer")
      .on("pointermove", (ev, i) => showTip(ev, `<b>${esc(t.sectors[i].name)}</b><br>影響力係数 <span class="n">${mo.influence[i].toFixed(3)}</span><br>感応度係数 <span class="n">${mo.sensitivity[i].toFixed(3)}</span><br>国内生産額 <span class="n">${money(X[i])}</span>`))
      .on("pointerleave", hideTip)
      .on("click", (_, i) => goSector(i));
    // ラベル：強調対象のうち、目立つ点のみ
    const cand = d3.range(n).filter(hl).map((i) => ({ i, score: Math.hypot(mo.influence[i] - 1, (mo.sensitivity[i] - 1) * 0.6) + X[i] / d3.max(X) }))
      .sort((a, b) => b.score - a.score).slice(0, state.posGroup >= 0 ? 14 : n <= 13 ? 13 : 12);
    const placed = [];
    cand.forEach(({ i }) => {
      const px = x(mo.influence[i]), py = y(mo.sensitivity[i]) - Math.max(4, r(X[i])) - 4;
      const name = t.sectors[i].name.length > 12 ? t.sectors[i].name.slice(0, 11) + "…" : t.sectors[i].name;
      const w = name.length * 11, box = [px - w / 2, py - 12, px + w / 2, py + 2];
      if (placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) return;
      placed.push(box);
      svg.append("text").attr("class", "halo").attr("x", Math.min(W - m.r - w / 2, Math.max(m.l + w / 2, px))).attr("y", py).attr("text-anchor", "middle").attr("font-size", 11).text(name);
    });
  }

  // ---------------------------------------------------------------- 年の切替
  const WAREKI = { "2005": "平成17年", "2011": "平成23年", "2015": "平成27年", "2020": "令和2年" };
  const yearLabel = (y) => `${y}年`;
  function renderYearSeg() {
    const ys = yearsOf(state.level);
    const y = curYear(state.level);
    $("#year-seg").innerHTML = ys.map((v) => `<button type="button" data-year="${v}">${v}</button>`).join("");
    setSeg("#year-seg", "year", y);
    const cmp = state.view === "compare";
    $("#year-ctl").hidden = cmp;
    $("#h1-sub").textContent = cmp ? `${ys[0]}〜${ys[ys.length - 1]}年の比較` : `${WAREKI[y]}（${y}年）産業連関表`;
    const basis = DATA.levels[state.level].years[y].basis;
    $("#basis-note").textContent = cmp ? "" : `表示中：${basis}` + (ys.length === 1 ? "（108部門は2020年表のみ。過去の年は13部門・37部門で選べます）" : "");
  }

  // ---------------------------------------------------------------- 経年比較
  const CMP_METRICS = {
    X: { label: "国内生産額", kind: "money", get: (mo) => mo.X },
    VA: { label: "粗付加価値", kind: "money", get: (mo) => mo.vaTot },
    EX: { label: "輸出", kind: "money", get: (mo) => mo.exportV },
    IM: { label: "輸入", kind: "money", get: (mo) => mo.M },
    VR: { label: "粗付加価値率", kind: "rate", get: (mo) => mo.vaRate },
    MR: { label: "輸入係数", kind: "rate", get: (mo) => mo.m },
    IF: { label: "影響力係数", kind: "coef", get: (mo) => mo.influence },
  };
  // グループ単位の値（金額は合計、比率は加重平均）
  function groupValue(mo, g, key) {
    const idx = d3.range(mo.n).filter((i) => mo.groups[i] === g);
    const S = (arr) => sum(idx.map((i) => arr[i]));
    switch (key) {
      case "VR": return S(mo.vaTot) / S(mo.X);
      case "MR": return S(mo.M) / S(mo.domDemand);
      case "IF": return sum(idx.map((i) => mo.influence[i] * mo.X[i])) / S(mo.X);
      default: return S(CMP_METRICS[key].get(mo));
    }
  }
  const fmtMetric = (kind, v) => (kind === "money" ? money(v) : kind === "rate" ? pct(v) : v.toFixed(3));
  const signed = (v, f) => (v > 0 ? "+" : v < 0 ? "−" : "±") + f(Math.abs(v));

  function renderCompare() {
    const level = state.level;
    const ys = yearsOf(level);
    const ok = ys.length > 1;
    $("#cmp-unavailable").hidden = ok;
    $("#cmp-body").hidden = !ok;
    if (!ok) return;
    if (!ys.includes(state.cmpA)) state.cmpA = ys[ys.length - 2];
    if (!ys.includes(state.cmpB)) state.cmpB = ys[ys.length - 1];
    const opt = (sel, v) => ys.map((y) => `<option value="${y}"${y === v ? " selected" : ""}>${y}年（${WAREKI[y]}）</option>`).join("");
    $("#cmp-a").innerHTML = opt("a", state.cmpA);
    $("#cmp-b").innerHTML = opt("b", state.cmpB);
    const A = state.cmpA, B = state.cmpB;
    const mA = model(level, A), mB = model(level, B);
    const crosses = (A === "2020") !== (B === "2020");
    $("#cmp-gap").hidden = !crosses;

    // 全体の変化
    const tot = (mo) => ({
      X: sum(mo.X), Z: sum(mo.sales), VA: sum(mo.vaTot), FD: sum(mo.fdDomTotal), EX: sum(mo.exportV), IM: sum(mo.M),
    });
    const ta = tot(mA), tb = tot(mB);
    $("#cmp-tiles").innerHTML = [["国内生産額", "X"], ["中間取引", "Z"], ["粗付加価値", "VA"], ["国内最終需要", "FD"], ["輸出", "EX"], ["輸入", "IM"]]
      .map(([k, f]) => {
        const r = tb[f] / ta[f] - 1;
        return `<div class="tile"><span class="k">${k}</span><span class="v">${(tb[f] / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}<small>兆円</small></span>` +
          `<span class="d"><span class="delta ${r >= 0 ? "up" : "down"}">${r >= 0 ? "▲" : "▼"} ${signed(r * 100, (v) => v.toFixed(1))}%</span> ${A}年 ${(ta[f] / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}兆円から</span></div>`;
      }).join("");

    setSeg("#cmp-metric", "cm", state.cmpMetric);
    setSeg("#cmp-matrix", "cx", state.cmpMatrix);
    drawGroupTrend(level, ys);
    drawChangeBars(level, mA, mB);
    drawDiffMatrix(mA, mB);
    const s = defaultSector(level);
    sectorOptions($("#cmp-sector"), level, s);
    drawSectorTrend(level, ys, s);
  }

  // 2015→2020 の線分は破線（表の基準が異なるため）
  function trendPath(g, pts, x, y, color, width) {
    const line = d3.line().x((d) => x(+d.y)).y((d) => y(d.v));
    const solid = pts.filter((d) => d.y !== "2020");
    g.append("path").attr("d", line(solid)).attr("fill", "none").attr("stroke", color).attr("stroke-width", width);
    const last = pts.slice(-2);
    if (last.length === 2 && last[1].y === "2020") {
      g.append("path").attr("d", line(last)).attr("fill", "none").attr("stroke", color).attr("stroke-width", width).attr("stroke-dasharray", "4 3");
    }
  }

  function drawGroupTrend(level, ys) {
    const key = state.cmpMetric;
    const meta = CMP_METRICS[key];
    $("#cmp-trend-title").textContent = `産業グループ別の${meta.label}の推移`;
    const gs = groupsUsed(level);
    const series = gs.map((g) => ({ g, pts: ys.map((y) => ({ y, v: groupValue(model(level, y), g, key) })) }));
    const W = containerWidth("#cmp-trend", 560), H = 340;
    const m = { l: 64, r: 150, t: 12, b: 28 };
    const svg = d3.select("#cmp-trend");
    svg.selectAll("*").remove();
    svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
    const x = d3.scaleLinear([+ys[0], +ys[ys.length - 1]], [m.l, W - m.r]);
    const all = series.flatMap((s) => s.pts.map((p) => p.v));
    const y = d3.scaleLinear([meta.kind === "coef" ? d3.min(all) * 0.95 : 0, d3.max(all) * 1.05], [H - m.b, m.t]).nice();
    const tf = meta.kind === "money" ? (v) => (v / 1000).toLocaleString("ja-JP") + "兆" : meta.kind === "rate" ? (v) => (v * 100).toFixed(0) + "%" : (v) => v.toFixed(2);
    svg.append("g").selectAll("line").data(y.ticks(5)).join("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y).attr("stroke", css("--line"));
    svg.append("g").selectAll("text").data(y.ticks(5)).join("text").attr("x", m.l - 8).attr("y", y).attr("dy", "0.35em").attr("text-anchor", "end").attr("font-size", 11).attr("class", "num muted").text(tf);
    svg.append("g").selectAll("text").data(ys).join("text").attr("x", (d) => x(+d)).attr("y", H - 8).attr("text-anchor", "middle").attr("font-size", 11).attr("class", "num muted").text((d) => d);
    const g = svg.append("g");
    series.forEach((s) => {
      trendPath(g, s.pts, x, y, gColor(s.g), 2);
      g.append("g").selectAll("circle").data(s.pts).join("circle").attr("cx", (d) => x(+d.y)).attr("cy", (d) => y(d.v)).attr("r", 3.5)
        .attr("fill", gColor(s.g)).attr("stroke", css("--surface")).attr("stroke-width", 2);
    });
    // 右端の直接ラベル（重なりを避けて縦に並べる）
    const ends = series.map((s) => ({ s, yy: y(s.pts[s.pts.length - 1].v) })).sort((a, b) => a.yy - b.yy);
    for (let i = 1; i < ends.length; i++) ends[i].yy = Math.max(ends[i].yy, ends[i - 1].yy + 13);
    const over = ends.length ? ends[ends.length - 1].yy - (H - m.b) : 0;
    if (over > 0) ends.forEach((e) => { e.yy -= over; });
    svg.append("g").selectAll("text").data(ends).join("text").attr("x", W - m.r + 8).attr("y", (d) => d.yy).attr("dy", "0.35em").attr("font-size", 11)
      .text((d) => groupName(level, d.s.g));
    svg.append("g").selectAll("rect").data(ends).join("rect").attr("x", W - m.r + 2).attr("y", (d) => d.yy - 1).attr("width", 4).attr("height", 2).attr("fill", (d) => gColor(d.s.g));
    // ホバー：年ごとの値
    const guide = svg.append("line").attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--line-2")).attr("visibility", "hidden");
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => {
        const [px] = d3.pointer(ev);
        const yr = ys.reduce((a, b) => (Math.abs(x(+b) - px) < Math.abs(x(+a) - px) ? b : a));
        guide.attr("x1", x(+yr)).attr("x2", x(+yr)).attr("visibility", "visible");
        const rows = series.map((s) => ({ g: s.g, v: s.pts.find((p) => p.y === yr).v })).sort((a, b) => b.v - a.v);
        showTip(ev, `<b>${yr}年</b>（${meta.label}）<br>` + rows.map((r) => `<span style="color:${gColor(r.g)}">■</span> ${esc(groupName(level, r.g))} <span class="n">${fmtMetric(meta.kind, r.v)}</span>`).join("<br>"));
      })
      .on("pointerleave", () => { hideTip(); guide.attr("visibility", "hidden"); });
  }

  function drawChangeBars(level, mA, mB) {
    const key = state.cmpMetric, meta = CMP_METRICS[key];
    const a = meta.get(mA), b = meta.get(mB);
    const rows = mA.t.sectors.map((s, i) => {
      let d;
      if (meta.kind === "money") d = a[i] > 0 ? b[i] / a[i] - 1 : null;
      else d = b[i] - a[i];
      return { i, name: s.name, a: a[i], b: b[i], d };
    }).filter((r) => r.d != null && isFinite(r.d)).sort((p, q) => q.d - p.d);
    const unitTxt = meta.kind === "money" ? "増減率" : meta.kind === "rate" ? "増減（%ポイント）" : "増減";
    $("#cmp-bars-title").textContent = `産業別の${meta.label}の${unitTxt}（${state.cmpA}年→${state.cmpB}年）`;
    const fmtD = (d) => (meta.kind === "money" ? signed(d * 100, (v) => v.toFixed(1)) + "%" : meta.kind === "rate" ? signed(d * 100, (v) => v.toFixed(1)) + "pt" : signed(d, (v) => v.toFixed(3)));
    const W = containerWidth("#cmp-bars", 560), rowH = 22;
    const m = { l: 180, r: 70, t: 8, b: 24 };
    const H = rows.length * rowH + m.t + m.b;
    const svg = d3.select("#cmp-bars");
    svg.selectAll("*").remove();
    svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
    let ext = d3.max(rows, (r) => Math.abs(r.d)) || 1;
    if (meta.kind === "money") ext = Math.min(ext, Math.max(1, d3.quantile(rows.map((r) => Math.abs(r.d)).sort(d3.ascending), 0.9) * 1.6));
    const x = d3.scaleLinear([-ext, ext], [m.l, W - m.r]).nice().clamp(true);
    const pos = css("--div-pos"), neg = css("--div-neg");
    svg.append("g").selectAll("line").data(x.ticks(6)).join("line").attr("x1", x).attr("x2", x).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--line"));
    svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--line-2")).attr("stroke-width", 1.5);
    svg.append("g").selectAll("text").data(x.ticks(6)).join("text").attr("x", x).attr("y", H - 6).attr("text-anchor", "middle").attr("font-size", 11).attr("class", "num muted")
      .text((v) => (meta.kind === "coef" ? v.toFixed(2) : (v * 100).toFixed(0) + (meta.kind === "money" ? "%" : "pt")));
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("transform", (_, k) => `translate(0,${m.t + k * rowH})`);
    g.append("text").attr("x", m.l - 8).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").attr("font-size", 12)
      .text((r) => (r.name.length > 13 ? r.name.slice(0, 12) + "…" : r.name));
    g.append("rect").attr("y", 4).attr("height", rowH - 8).attr("rx", 3)
      .attr("x", (r) => Math.min(x(0), x(r.d))).attr("width", (r) => Math.max(1, Math.abs(x(r.d) - x(0))))
      .attr("fill", (r) => (r.d >= 0 ? pos : neg));
    g.append("text").attr("class", "num sub").attr("font-size", 11).attr("y", rowH / 2).attr("dy", "0.35em")
      .attr("x", (r) => (r.d >= 0 ? x(r.d) + 5 : x(r.d) - 5)).attr("text-anchor", (r) => (r.d >= 0 ? "start" : "end"))
      .text((r) => fmtD(r.d) + (Math.abs(r.d) > ext ? "（目盛外）" : ""));
    g.append("rect").attr("x", 0).attr("width", W).attr("height", rowH).attr("fill", "transparent").style("cursor", "pointer")
      .on("pointermove", (ev, r) => showTip(ev, `<b>${esc(r.name)}</b><br>${state.cmpA}年 <span class="n">${fmtMetric(meta.kind, r.a)}</span><br>${state.cmpB}年 <span class="n">${fmtMetric(meta.kind, r.b)}</span><br>${unitTxt} <span class="n">${fmtD(r.d)}</span><br><span style="color:var(--ink-3)">クリックで下の推移グラフに表示</span>`))
      .on("pointerleave", hideTip)
      .on("click", (_, r) => { state.sector[level] = r.i; renderCompare(); $("#cmp-sector").scrollIntoView({ behavior: "smooth", block: "center" }); });
  }

  function drawDiffMatrix(mA, mB) {
    const n = mA.n, t = mA.t;
    const useA = state.cmpMatrix === "A";
    const src = (mo) => (useA ? mo.A : mo.Z);
    const a = src(mA), b = src(mB);
    const cells = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cells.push({ i, j, a: a[i][j], b: b[i][j], d: b[i][j] - a[i][j] });
    const absd = cells.map((c) => Math.abs(c.d)).sort(d3.ascending);
    const q = d3.quantile(absd, 0.98) || 1e-9;
    const color = d3.scaleDiverging([-q, 0, q], (tt) => (tt < 0.5 ? d3.interpolateLab(css("--div-neg"), css("--div-mid"))(tt * 2) : d3.interpolateLab(css("--div-mid"), css("--div-pos"))((tt - 0.5) * 2))).clamp(true);
    const cell = n <= 13 ? 34 : 17, labelW = 170, fs = 12;
    const W = labelW + n * cell + 10, H = labelW + n * cell + 10;
    const svg = d3.select("#cmp-matrix-svg");
    svg.selectAll("*").remove();
    svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
    const fmt = useA ? (v) => v.toFixed(4) : money;
    const fmtd = useA ? (v) => signed(v, (z) => z.toFixed(4)) : (v) => signed(v, money);
    const gg = svg.append("g").attr("transform", `translate(${labelW},${labelW})`);
    gg.selectAll("rect").data(cells).join("rect")
      .attr("x", (d) => d.j * cell).attr("y", (d) => d.i * cell).attr("width", cell - 1).attr("height", cell - 1)
      .attr("fill", (d) => color(d.d))
      .on("pointermove", (ev, d) => showTip(ev, `<b>${esc(t.sectors[d.i].name)}</b> → <b>${esc(t.sectors[d.j].name)}</b><br>${useA ? "投入係数" : "取引額"}<br>${state.cmpA}年 <span class="n">${fmt(d.a)}</span><br>${state.cmpB}年 <span class="n">${fmt(d.b)}</span><br>差 <span class="n">${fmtd(d.d)}</span>`))
      .on("pointerleave", hideTip);
    svg.append("g").selectAll("text").data(t.sectors).join("text").attr("x", labelW - 6).attr("y", (_, i) => labelW + i * cell + cell / 2).attr("dy", "0.35em").attr("text-anchor", "end").attr("font-size", fs).text((d) => d.name);
    svg.append("g").selectAll("text").data(t.sectors).join("text").attr("transform", (_, j) => `translate(${labelW + j * cell + cell / 2},${labelW - 6}) rotate(-60)`).attr("dy", "0.35em").attr("font-size", fs).text((d) => d.name);
    svg.append("text").attr("class", "colhead").attr("x", 4).attr("y", labelW - 6).text("売り手 ↓ ／ 買い手 →");
    const lw = 200;
    $("#cmp-matrix-legend").innerHTML = `<svg width="${lw + 40}" height="40" role="img" aria-label="色の凡例">
      <defs><linearGradient id="dgrad">${d3.range(0, 1.01, 0.1).map((p) => `<stop offset="${p}" stop-color="${color(-q + 2 * q * p)}"/>`).join("")}</linearGradient></defs>
      <rect x="20" y="4" width="${lw}" height="10" rx="2" fill="url(#dgrad)"/>
      <text x="20" y="30" font-size="10" class="num sub">${esc(fmtd(-q))}</text>
      <text x="${20 + lw / 2}" y="30" font-size="10" text-anchor="middle" class="sub">変化なし</text>
      <text x="${20 + lw}" y="30" font-size="10" text-anchor="end" class="num sub">${esc(fmtd(q))}</text></svg>`;
    $("#cmp-matrix-note").textContent = useA
      ? `投入係数の差：列の産業が1単位生産するのに必要な行の産業からの投入が、${state.cmpA}年から${state.cmpB}年にどれだけ変わったか。価格水準の変化の影響を受けにくく、生産構造の変化を見るのに向いています。`
      : `取引額の差：行の産業から列の産業への販売額の増減（名目）。色の目盛は差の大きさの上位2%で頭打ちにしています。`;
  }

  function drawSectorTrend(level, ys, s) {
    const items = [
      ["国内生産額", "money", (mo) => mo.X[s]],
      ["粗付加価値率", "rate", (mo) => mo.vaRate[s]],
      ["中間投入率", "rate", (mo) => mo.inputs[s] / mo.X[s]],
      ["輸入係数", "rate", (mo) => mo.m[s]],
      ["輸出比率（輸出÷生産額）", "rate", (mo) => mo.exportV[s] / mo.X[s]],
      ["影響力係数", "coef", (mo) => mo.influence[s]],
    ];
    const host = $("#cmp-small");
    host.innerHTML = items.map((_, k) => `<div class="mini"><div class="mini-h" id="mini-h-${k}"></div><svg id="mini-${k}" role="img"></svg></div>`).join("");
    const col = gColor(model(level).groups[s]);
    items.forEach(([label, kind, get], k) => {
      const pts = ys.map((y) => ({ y, v: get(model(level, y)) }));
      const last = pts[pts.length - 1].v, first = pts[0].v;
      const chg = kind === "money" ? signed((last / first - 1) * 100, (v) => v.toFixed(1)) + "%" : kind === "rate" ? signed((last - first) * 100, (v) => v.toFixed(1)) + "pt" : signed(last - first, (v) => v.toFixed(3));
      $(`#mini-h-${k}`).innerHTML = `<span class="k">${label}</span><span class="v">${fmtMetric(kind, last)}</span><span class="d">${ys[0]}年比 ${chg}</span>`;
      const svgEl = $(`#mini-${k}`);
      svgEl.setAttribute("aria-label", `${label}の推移`);
      const W = Math.max(220, svgEl.parentElement.clientWidth), H = 110, m = { l: 8, r: 8, t: 18, b: 20 };
      const svg = d3.select(svgEl);
      svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
      const x = d3.scaleLinear([+ys[0], +ys[ys.length - 1]], [m.l + 16, W - m.r - 16]);
      const ext = d3.extent(pts, (p) => p.v);
      const pad = (ext[1] - ext[0]) * 0.25 || Math.abs(ext[1]) * 0.1 || 1;
      const y = d3.scaleLinear([kind === "money" ? Math.min(0, ext[0]) : ext[0] - pad, ext[1] + pad], [H - m.b, m.t]);
      svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", H - m.b).attr("y2", H - m.b).attr("stroke", css("--line"));
      const area = d3.area().x((d) => x(+d.y)).y0(H - m.b).y1((d) => y(d.v));
      svg.append("path").attr("d", area(pts)).attr("fill", col).attr("fill-opacity", 0.1);
      trendPath(svg, pts, x, y, col, 2);
      svg.append("g").selectAll("circle").data(pts).join("circle").attr("cx", (d) => x(+d.y)).attr("cy", (d) => y(d.v)).attr("r", (d, i) => (i === pts.length - 1 ? 4.5 : 3))
        .attr("fill", col).attr("stroke", css("--surface")).attr("stroke-width", 2)
        .on("pointermove", (ev, d) => showTip(ev, `<b>${d.y}年</b> ${label}<br><span class="n">${fmtMetric(kind, d.v)}</span>`)).on("pointerleave", hideTip);
      svg.append("g").selectAll("text").data(pts).join("text").attr("x", (d) => x(+d.y)).attr("y", H - 5).attr("text-anchor", "middle").attr("font-size", 10).attr("class", "num muted").text((d) => d.y);
      svg.append("g").selectAll("text").data(pts).join("text").attr("x", (d) => x(+d.y)).attr("y", (d) => y(d.v) - 8).attr("text-anchor", "middle").attr("font-size", 10).attr("class", "num sub halo")
        .text((d) => (kind === "money" ? (d.v / 1000).toFixed(1) + "兆" : kind === "rate" ? (d.v * 100).toFixed(1) : d.v.toFixed(2)));
    });
  }

  // ---------------------------------------------------------------- イベント
  document.querySelectorAll("#level-seg button").forEach((b) => b.addEventListener("click", () => {
    state.level = b.dataset.level;
    try { localStorage.setItem("io-flow-level", state.level); } catch (e) { /* noop */ }
    render();
  }));
  document.querySelectorAll("#flow-gran button").forEach((b) => b.addEventListener("click", () => { state.gran = b.dataset.gran; render(); }));
  document.querySelectorAll("#matrix-metric button").forEach((b) => b.addEventListener("click", () => { state.metric = b.dataset.metric; render(); }));
  document.querySelectorAll("#ripple-kind button").forEach((b) => b.addEventListener("click", () => { state.rippleKind = b.dataset.kind; render(); }));
  $("#sector-select").addEventListener("change", (e) => { state.sector[state.level] = +e.target.value; render(); });
  $("#ripple-sector").addEventListener("change", (e) => { state.sector[state.level] = +e.target.value; render(); });
  $("#ripple-amount").addEventListener("input", () => render());
  $("#year-seg").addEventListener("click", (e) => { const b = e.target.closest("[data-year]"); if (b) { state.year = b.dataset.year; render(); } });
  $("#cmp-a").addEventListener("change", (e) => { state.cmpA = e.target.value; render(); });
  $("#cmp-b").addEventListener("change", (e) => { state.cmpB = e.target.value; render(); });
  $("#cmp-sector").addEventListener("change", (e) => { state.sector[state.level] = +e.target.value; render(); });
  document.querySelectorAll("#cmp-metric button").forEach((b) => b.addEventListener("click", () => { state.cmpMetric = b.dataset.cm; render(); }));
  document.querySelectorAll("#cmp-matrix button").forEach((b) => b.addEventListener("click", () => { state.cmpMatrix = b.dataset.cx; render(); }));
  $("#cmp-to37").addEventListener("click", () => { state.level = "37"; render(); });
  $("#pos-group").addEventListener("change", (e) => { state.posGroup = +e.target.value; render(); });
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-sec]"); if (b) goSector(+b.dataset.sec); });
  window.addEventListener("hashchange", route);
  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  route();
})();
