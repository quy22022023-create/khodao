/* Thành phần giao diện và thống kê; dùng dữ liệu đã lưu, không sửa sổ/kết toán. */
(() => {
  "use strict";
  const palette = Object.freeze([
    { value: "#176b3a", label: "Xanh lá" }, { value: "#245a85", label: "Xanh dương" },
    { value: "#6d4594", label: "Tím" }, { value: "#895028", label: "Nâu" },
    { value: "#9f4545", label: "Đỏ đất" }, { value: "#166e70", label: "Xanh ngọc" },
    { value: "#495fa8", label: "Chàm" }, { value: "#9b3d6b", label: "Hồng mận" }
  ]);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const color = (person, fallback = "#176b3a") => palette.find(p => p.value === person?.color)?.value || fallback;
  const number = value => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(value);
  const dateText = value => globalThis.SoghiLedger.isDate(value) ? value.split("-").reverse().join("/") : "Chọn ngày";
  const icons = {
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    down: '<path d="m6 9 6 6 6-6"/>', back: '<path d="m14 5-7 7 7 7"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/>',
    chart: '<path d="M4 3v17h17M8 16V9m5 7V5m5 11v-5"/>',
    wallet: '<path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v12H6a3 3 0 0 1-3-3V6"/><path d="M20 12h-5v5h5"/>',
    settle: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="m9 10 2 2 4-5m-6 9h6"/>',
    history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c2 0 3-1 2-3s0-3 2-3h2a3 3 0 0 0 3-3 9 9 0 0 0-9-9Z"/><circle cx="7.5" cy="10" r=".8"/><circle cx="11" cy="7" r=".8"/><circle cx="16" cy="8.5" r=".8"/>',
    settings: '<path d="m9 3-.5 3-2 .9L4 6l-2 4 2 2v2l-2 2 2 4 2.5-.9 2 .9.5 3h6l.5-3 2-.9 2.5.9 2-4-2-2v-2l2-2-2-4-2.5.9-2-.9-.5-3Z"/><circle cx="12" cy="13" r="3"/>',
    person: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
    add: '<path d="M12 5v14M5 12h14"/>', trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'
  };
  function icon(name) {
    return `<svg class="soghi-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="${name === "more" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.more}</svg>`;
  }
  function dateField({ id, name, value = "", label = "Chọn ngày", required = false }) {
    return `<div class="soghi-date-field"><span class="soghi-date-value" aria-hidden="true">${dateText(value)}</span>${icon("calendar")}<input id="${escape(id)}" ${name ? `name="${escape(name)}"` : ""} type="date" value="${escape(value)}" aria-label="${escape(label)}" data-soghi-date ${required ? "required" : ""}></div>`;
  }
  function bindDates(root) {
    root.querySelectorAll("input[data-soghi-date]").forEach(input => {
      const update = () => { input.parentElement.querySelector(".soghi-date-value").textContent = dateText(input.value); };
      if (!input.dataset.soghiDateBound) {
        input.addEventListener("input", update); input.addEventListener("change", update);
        input.dataset.soghiDateBound = "true";
      }
      update();
    });
  }
  function summarize(data, filters) {
    const Ledger = globalThis.SoghiLedger;
    const people = new Map(data.harvesters.map(p => [p.id, p]));
    const scope = filters.personId || "all", group = filters.group === "day" ? "day" : "person";
    const from = filters.from || "", to = filters.to || "";
    if ((from && !Ledger.isDate(from)) || (to && !Ledger.isDate(to)) || (from && to && from > to)) throw new Error("Chọn khoảng ngày hợp lệ: ngày bắt đầu không lớn hơn ngày kết thúc.");
    const seen = new Set(), activePeople = new Set(), days = new Set(), groups = new Map();
    const fallback = palette.find(p => p.value === filters.defaultColor)?.value || "#176b3a";
    if (group === "person") for (const p of data.harvesters) if (scope === "all" || p.id === scope) groups.set(p.id, { id: p.id, label: p.name, color: color(p, fallback), kg100: 0, count: 0 });
    let kg100 = 0, count = 0;
    for (const e of data.entries) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (!people.has(e.harvesterId) || (scope !== "all" && scope !== e.harvesterId) || (from && e.date < from) || (to && e.date > to)) continue;
      const amount = Ledger.kg100(e.kg);
      const key = group === "day" ? e.date : e.harvesterId;
      if (!groups.has(key)) groups.set(key, { id: key, label: dateText(key), color: scope === "all" ? fallback : color(people.get(scope), fallback), kg100: 0, count: 0 });
      const row = groups.get(key); row.kg100 = Ledger.safe(row.kg100 + amount); row.count++;
      kg100 = Ledger.safe(kg100 + amount); count++; activePeople.add(e.harvesterId); days.add(e.date);
    }
    const rows = [...groups.values()].sort(group === "day" ? (a, b) => a.id.localeCompare(b.id) : (a, b) => b.kg100 - a.kg100 || a.label.localeCompare(b.label, "vi"));
    return { kg100, count, peopleCount: activePeople.size, dayCount: days.size, rows, group };
  }
  function chart(result, viewportWidth = 360) {
    if (!result.count) return "";
    const rows = result.rows, width = Math.max(320, viewportWidth, rows.length * 68 + 60);
    const left = 50, top = 30, bottom = 218, plotWidth = width - left - 16;
    const step = plotWidth / rows.length, barWidth = Math.min(40, step * .65);
    const max = rows.reduce((value, row) => Math.max(value, row.kg100 / 100), 1);
    const power = 10 ** Math.floor(Math.log10(max)), scaled = max / power;
    const ceiling = (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10) * power;
    let grid = "", bars = "";
    for (let i = 0; i <= 4; i++) {
      const value = ceiling * i / 4, y = bottom - (bottom - top) * i / 4;
      grid += `<line x1="${left}" y1="${y}" x2="${width - 12}" y2="${y}" stroke="#e2e9de"/><text x="${left - 7}" y="${y + 4}" text-anchor="end" class="chart-tick">${number(value)}</text>`;
    }
    rows.forEach((r, i) => {
      const kg = r.kg100 / 100, height = (bottom - top) * kg / ceiling, x = left + step * i + step / 2, y = bottom - height;
      const label = result.group === "day" ? r.label : Array.from(r.label).length > 11 ? Array.from(r.label).slice(0, 10).join("") + "…" : r.label;
      bars += `<g data-chart-index="${i}" tabindex="0" role="button" aria-label="${escape(r.label)}: ${number(kg)} kg, ${r.count} lần ghi" class="chart-column"><title>${escape(r.label)}: ${number(kg)} kg</title><rect x="${x - step / 2 + 2}" y="${top - 15}" width="${step - 4}" height="${bottom - top + 62}" fill="transparent" class="chart-hit"/><rect x="${x - barWidth / 2}" y="${kg ? y : bottom - 2}" width="${barWidth}" height="${Math.max(height, 2)}" rx="4" fill="${r.color}" class="chart-bar"/><text x="${x}" y="${Math.max(14, y - 7)}" text-anchor="middle" class="chart-value">${number(kg)}</text><text x="${x}" y="${bottom + 23}" text-anchor="middle" class="chart-label">${escape(label)}</text></g>`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="270" viewBox="0 0 ${width} 270" role="group" aria-label="Biểu đồ sản lượng theo ${result.group === "day" ? "ngày" : "người"}"><text x="${left}" y="15" class="chart-tick">kg</text>${grid}${bars}</svg>`;
  }
  globalThis.SoghiUI = Object.freeze({ palette, escape, color, number, dateText, icon, dateField, bindDates, summarize, chart });
})();
