(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const inputs = {
    concentration: $("#concentration"),
    carbonMass: $("#carbonMass"),
    flowRate: $("#flowRate"),
    simulationTime: $("#simulationTime"),
    compareModels: $("#compareModels")
  };
  const canvas = $("#breakthroughChart");
  const ctx = canvas.getContext("2d");
  let currentResult = null;
  let chartGeometry = null;

  // Empirical calibration layer derived from the project's retained tables.
  // Validated use requires replacing these preliminary coefficients with the
  // final nonlinear-regression output described in the graduation report.
  function parameters(c, mass, flow) {
    const flowExponent = 1.12 - 0.25 * (mass - 0.5);
    const tau = 16.47 * Math.pow(mass / 0.5, 0.33) * Math.pow(20 / c, 0.215) * Math.pow(3 / flow, flowExponent);
    const shape = 1.55 + 0.7 * ((c - 20) / 80) + 0.2 * ((flow - 3) / 2) - 0.1 * (mass - 0.5);
    return { tau: Math.max(0.5, tau), shape: Math.max(1.1, shape) };
  }

  function yanRatio(t, p) {
    if (t <= 0) return 0;
    const ta = Math.pow(t, p.shape);
    return Math.min(1, Math.max(0, ta / (Math.pow(p.tau, p.shape) + ta)));
  }

  function logisticRatio(t, tau, k) {
    return 1 / (1 + Math.exp(k * (tau - t)));
  }

  function modelValues(t, p) {
    const t95Yan = p.tau * Math.pow(19, 1 / p.shape);
    const kYN = Math.log(19) / Math.max(1, t95Yan - p.tau);
    return {
      yan: yanRatio(t, p),
      yoon: logisticRatio(t, p.tau, kYN),
      thomas: logisticRatio(t, p.tau * 1.04, kYN * 1.12)
    };
  }

  function thresholdTime(ratio, p) {
    return p.tau * Math.pow(ratio / (1 - ratio), 1 / p.shape);
  }

  function integrateAdsorbed(endTime, c, flow, p) {
    const steps = Math.max(60, Math.ceil(endTime * 6));
    const dt = endTime / steps;
    let area = 0;
    for (let i = 0; i <= steps; i++) {
      const removal = 1 - yanRatio(i * dt, p);
      area += removal * (i === 0 || i === steps ? 0.5 : 1);
    }
    area *= dt;
    return (flow * c / 1000) * area;
  }

  function getState() {
    return {
      c: Number(inputs.concentration.value),
      mass: Number(inputs.carbonMass.value),
      flow: Number(inputs.flowRate.value),
      time: Number(inputs.simulationTime.value),
      compare: inputs.compareModels.checked
    };
  }

  function updateOutputs(state) {
    $("#concentrationOutput").textContent = `${state.c.toFixed(0)} mg/L`;
    $("#carbonMassOutput").textContent = `${state.mass.toFixed(1)} g`;
    $("#flowRateOutput").textContent = `${state.flow.toFixed(1)} mL/min`;
    $("#simulationTimeOutput").textContent = `${state.time.toFixed(0)} min`;

    Object.values(inputs).forEach((input) => {
      if (input.type !== "range") return;
      const progress = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
      input.style.background = `linear-gradient(to left, #dfe7e4 ${100-progress}%, #0c8f79 ${100-progress}%, #0c8f79 100%)`;
    });
  }

  function checkRange(state) {
    const issues = [];
    if (state.c < 20 || state.c > 100) issues.push("التركيز");
    if (state.mass < 0.5 || state.mass > 1.5) issues.push("كتلة الكربون");
    if (state.flow < 3 || state.flow > 5) issues.push("معدل التدفق");
    const notice = $("#rangeNotice");
    if (issues.length) {
      notice.classList.add("warning");
      notice.querySelector(".notice-icon").textContent = "!";
      notice.querySelector("b").textContent = "تنبيه: بعض المدخلات خارج نطاق المعايرة";
      notice.querySelector("small").textContent = `القيم الخارجة: ${issues.join("، ")}. النتيجة استقراء استكشافي أقل موثوقية.`;
    } else {
      notice.classList.remove("warning");
      notice.querySelector(".notice-icon").textContent = "✓";
      notice.querySelector("b").textContent = "المدخلات داخل نطاق بيانات المشروع";
      notice.querySelector("small").textContent = "تُعرض النتائج لغرض الاستكشاف الهندسي والتعليم.";
    }
    return issues;
  }

  function calculate() {
    const state = getState();
    updateOutputs(state);
    const issues = checkRange(state);
    const p = parameters(state.c, state.mass, state.flow);
    const ratio = yanRatio(state.time, p);
    const tb = thresholdTime(0.05, p);
    const t50 = p.tau;
    const te = thresholdTime(0.95, p);
    const adsorbed = integrateAdsorbed(state.time, state.c, state.flow, p);
    const capacity = adsorbed / state.mass;
    currentResult = { state, p, ratio, tb, t50, te, adsorbed, capacity, issues };

    $("#removalMetric").textContent = `${((1 - ratio) * 100).toFixed(1)}%`;
    $("#breakthroughMetric").textContent = `${tb.toFixed(1)} min`;
    $("#exhaustionMetric").textContent = `${te.toFixed(1)} min`;
    $("#massMetric").textContent = `${adsorbed.toFixed(2)} mg`;
    $("#capacityMetric").textContent = `سعة تراكمية ${capacity.toFixed(2)} mg/g`;
    $("#removalHint").textContent = `Cₜ/C₀ = ${ratio.toFixed(3)} عند ${state.time} دقيقة`;
    $("#chartLegend").innerHTML = state.compare
      ? '<span><i class="yan"></i> Yan</span><span><i style="background:#df8a39"></i> Yoon–Nelson</span><span><i style="background:#6386a0"></i> Thomas</span><span class="threshold"><i></i> حدود 5% و95%</span>'
      : '<span><i class="yan"></i> Yan</span><span class="threshold"><i></i> حدود 5% و95%</span>';
    drawChart(currentResult);
  }

  function drawChart(result) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = rect.width, h = rect.height;
    const pad = { left: 55, right: 20, top: 18, bottom: 48 };
    const cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    const maxT = Math.max(40, result.state.time * 1.1, result.te * 1.16);
    chartGeometry = { pad, cw, ch, maxT, w, h };
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= 5; i++) {
      const y = pad.top + (ch * i / 5);
      ctx.strokeStyle = "#e4ebe8"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
      ctx.fillStyle = "#7d8d91"; ctx.textAlign = "right"; ctx.fillText((1 - i / 5).toFixed(1), pad.left - 10, y);
    }
    for (let i = 0; i <= 5; i++) {
      const x = pad.left + (cw * i / 5);
      ctx.fillStyle = "#7d8d91"; ctx.textAlign = "center"; ctx.fillText((maxT * i / 5).toFixed(0), x, h - 24);
    }

    [0.05, 0.95].forEach((ratio) => {
      const y = pad.top + ch * (1 - ratio);
      ctx.strokeStyle = "#aeb9b6"; ctx.setLineDash([5,5]);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke(); ctx.setLineDash([]);
    });

    const pointFor = (t, value) => ({ x: pad.left + (t / maxT) * cw, y: pad.top + (1 - value) * ch });
    const drawLine = (key, color, width) => {
      const count = Math.max(160, Math.round(cw));
      ctx.beginPath();
      for (let i = 0; i <= count; i++) {
        const t = maxT * i / count;
        const val = modelValues(t, result.p)[key];
        const pt = pointFor(t, val);
        if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
    };

    if (result.state.compare) { drawLine("thomas", "#6386a0", 2); drawLine("yoon", "#df8a39", 2); }
    drawLine("yan", "#0c8f79", 3.5);

    const current = pointFor(result.state.time, result.ratio);
    if (current.x <= pad.left + cw) {
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "#071d2b"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(current.x, current.y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    ctx.save(); ctx.translate(14, pad.top + ch / 2); ctx.rotate(-Math.PI/2); ctx.fillStyle = "#51666d"; ctx.textAlign = "center"; ctx.fillText("Cₜ/C₀", 0, 0); ctx.restore();
    ctx.fillStyle = "#51666d"; ctx.textAlign = "center"; ctx.fillText("الزمن (دقيقة)", pad.left + cw/2, h - 6);
  }

  function handleChartPointer(event) {
    if (!currentResult || !chartGeometry) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const { pad, cw, maxT } = chartGeometry;
    if (x < pad.left || x > pad.left + cw) { $("#chartTooltip").hidden = true; return; }
    const t = ((x - pad.left) / cw) * maxT;
    const value = yanRatio(t, currentResult.p);
    const y = pad.top + (1 - value) * chartGeometry.ch;
    const tip = $("#chartTooltip");
    tip.innerHTML = `<b>${t.toFixed(1)} دقيقة</b><br>Cₜ/C₀ = ${value.toFixed(3)}<br>الإزالة = ${((1-value)*100).toFixed(1)}%`;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`; tip.hidden = false;
  }

  function downloadReport() {
    if (!currentResult) return;
    const r = currentResult;
    const lines = [
      ["DicloPure simulation report"],
      ["Generated", new Date().toISOString()],
      ["Influent concentration (mg/L)", r.state.c],
      ["GAC mass (g)", r.state.mass],
      ["Flow rate (mL/min)", r.state.flow],
      ["Evaluation time (min)", r.state.time],
      ["Removal efficiency (%)", ((1-r.ratio)*100).toFixed(3)],
      ["Breakthrough time t_b, C/C0=0.05 (min)", r.tb.toFixed(3)],
      ["Half breakthrough t_50 (min)", r.t50.toFixed(3)],
      ["Exhaustion time t_e, C/C0=0.95 (min)", r.te.toFixed(3)],
      ["Adsorbed mass to evaluation time (mg)", r.adsorbed.toFixed(4)],
      ["Cumulative capacity to evaluation time (mg/g)", r.capacity.toFixed(4)],
      ["Calibration warning", r.issues.length ? `Outside range: ${r.issues.join(" | ")}` : "Inputs within preliminary project range"],
      [], ["time_min", "Ct_C0", "removal_percent"]
    ];
    const end = Math.max(r.state.time, r.te * 1.1);
    for (let t = 0; t <= end; t += Math.max(0.5, end/160)) {
      const ratio = yanRatio(t, r.p);
      lines.push([t.toFixed(3), ratio.toFixed(6), ((1-ratio)*100).toFixed(4)]);
    }
    const csv = lines.map(row => row.map(v => `"${String(v ?? "").replaceAll('"','""')}"`).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "DicloPure-simulation.csv"; a.click(); URL.revokeObjectURL(url);
    showMessage("تم تنزيل التقرير.");
  }

  async function shareScenario() {
    const s = getState();
    const url = new URL(location.href);
    url.searchParams.set("c", s.c); url.searchParams.set("m", s.mass); url.searchParams.set("q", s.flow); url.searchParams.set("t", s.time);
    if (s.compare) url.searchParams.set("compare", "1"); else url.searchParams.delete("compare");
    history.replaceState({}, "", url);
    try { await navigator.clipboard.writeText(url.href); showMessage("تم نسخ رابط السيناريو."); }
    catch { prompt("انسخ رابط السيناريو:", url.href); }
  }

  function showMessage(message) {
    const el = $("#actionMessage"); el.textContent = message; clearTimeout(showMessage.timer); showMessage.timer = setTimeout(() => el.textContent = "", 2500);
  }

  function loadQuery() {
    const q = new URLSearchParams(location.search);
    const mappings = [["c", inputs.concentration], ["m", inputs.carbonMass], ["q", inputs.flowRate], ["t", inputs.simulationTime]];
    mappings.forEach(([key,input]) => {
      if (!q.has(key)) return;
      const value = Number(q.get(key));
      if (Number.isFinite(value)) input.value = Math.min(Number(input.max), Math.max(Number(input.min), value));
    });
    inputs.compareModels.checked = q.get("compare") === "1";
  }

  Object.values(inputs).forEach(input => input.addEventListener("input", calculate));
  $("#resetButton").addEventListener("click", () => {
    inputs.concentration.value = 20; inputs.carbonMass.value = 1; inputs.flowRate.value = 3; inputs.simulationTime.value = 20; inputs.compareModels.checked = false; history.replaceState({}, "", location.pathname); calculate();
  });
  $("#downloadReport").addEventListener("click", downloadReport);
  $("#shareScenario").addEventListener("click", shareScenario);
  canvas.addEventListener("pointermove", handleChartPointer);
  canvas.addEventListener("pointerleave", () => $("#chartTooltip").hidden = true);
  window.addEventListener("resize", () => currentResult && drawChart(currentResult));
  $(".menu-button").addEventListener("click", (event) => {
    const nav = $(".main-nav"); const open = nav.classList.toggle("open"); event.currentTarget.setAttribute("aria-expanded", String(open));
  });
  document.querySelectorAll(".main-nav a").forEach(a => a.addEventListener("click", () => $(".main-nav").classList.remove("open")));

  const observer = new IntersectionObserver((entries) => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add("visible"); observer.unobserve(entry.target); } }), { threshold: .08 });
  document.querySelectorAll(".reveal").forEach(el => observer.observe(el));

  loadQuery();
  calculate();
})();
