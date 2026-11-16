/* Tính toán tiền công bằng số nguyên; không phụ thuộc giao diện hoặc database. */
(() => {
  "use strict";
  const fail = message => { throw new Error(message); };
  const check = (condition, message) => { if (!condition) fail(message); };
  const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
  const safe = n => { check(integer(n), "Số tiền quá lớn hoặc không hợp lệ."); return n; };
  const isDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;
  const kg100 = kg => {
    check(typeof kg === "number" && Number.isFinite(kg) && kg >= 0 && kg <= 999999.99 &&
      Math.abs(kg * 100 - Math.round(kg * 100)) < 0.00001, "Số kg không hợp lệ (tối đa 999.999,99 kg, 2 số lẻ).");
    return Math.round(kg * 100);
  };
  const order = (a, b) => (a.date || a.effectiveDate || "").localeCompare(b.date || b.effectiveDate || "") ||
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const lockedIds = data => new Set(data.settlements.flatMap(s => s.entryIds));
  function allocations(data) {
    const result = new Map();
    for (const s of data.settlements) for (const a of s.advanceAllocations) {
      result.set(a.advanceId, safe((result.get(a.advanceId) || 0) + a.amount));
    }
    return result;
  }
  function effectiveRate(rates, harvesterId, date) {
    const eligible = rates.filter(r => r.effectiveDate <= date);
    const latest = scope => eligible.filter(r => r.harvesterId === scope)
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.id.localeCompare(a.id))[0];
    return latest(harvesterId) || latest(null) || null;
  }
  function buildSettlement(data, harvesterId, selection) {
    const person = data.harvesters.find(p => p.id === harvesterId);
    check(person, "Không tìm thấy người hái.");
    const mode = selection.mode === "all" ? "all" : "range";
    const from = mode === "all" ? "" : selection.from;
    const to = mode === "all" ? "" : selection.to;
    check(mode === "all" || (isDate(from) && isDate(to) && from <= to), "Khoảng ngày không hợp lệ.");
    const locked = lockedIds(data);
    const entries = data.entries.filter(e => e.harvesterId === harvesterId && !locked.has(e.id) &&
      (mode === "all" || (e.date >= from && e.date <= to))).sort(order);
    check(entries.length, "Không có số kg chưa kết toán trong thời gian này.");
    const days = [];
    for (const e of entries) {
      const rate = effectiveRate(data.rates, harvesterId, e.date);
      check(rate, `Chưa có đơn giá áp dụng cho ngày ${e.date}. Hãy bổ sung trong Cài đặt → Đơn giá.`);
      let day = days[days.length - 1];
      if (!day || day.date !== e.date) {
        day = { date: e.date, rateId: rate.id, rate: rate.amount, kg100: 0, amount: 0, entryIds: [] };
        days.push(day);
      }
      day.kg100 = safe(day.kg100 + kg100(e.kg));
      day.entryIds.push(e.id);
    }
    for (const day of days) {
      check(Number.isSafeInteger(day.kg100 * day.rate), "Sản lượng hoặc đơn giá quá lớn để tính chính xác.");
      day.amount = safe(Math.round(day.kg100 * day.rate / 100));
    }
    const gross = days.reduce((s, d) => safe(s + d.amount), 0);
    const used = allocations(data);
    const advances = data.advances.filter(a => a.harvesterId === harvesterId && (mode === "all" || a.date <= to))
      .sort(order).map(a => ({ ...a, remaining: a.amount - (used.get(a.id) || 0) }));
    check(advances.every(a => integer(a.remaining)), "Lịch sử ứng tiền không khớp. Không thể kết sổ.");
    const availableAdvance = advances.reduce((s, a) => safe(s + a.remaining), 0);
    let toApply = Math.min(gross, availableAdvance);
    const advanceAllocations = [];
    for (const a of advances) {
      const amount = Math.min(toApply, a.remaining);
      if (amount) advanceAllocations.push({ advanceId: a.id, date: a.date, amount, note: a.note });
      toApply -= amount;
    }
    const advanceApplied = Math.min(gross, availableAdvance);
    return {
      harvesterId, personName: person.name, mode, from, to, entryIds: entries.map(e => e.id), days,
      totalKg100: days.reduce((s, d) => safe(s + d.kg100), 0), gross, availableAdvance, advanceApplied,
      payable: gross - advanceApplied, carry: availableAdvance - advanceApplied, advanceAllocations
    };
  }
  function validateBackup(payload) {
    check(payload && payload.app === "soghi" && [1, 2].includes(payload.version), "File sao lưu hoặc phiên bản không được hỗ trợ.");
    const names = ["harvesters", "entries", "rates", "advances", "settlements"];
    const data = {};
    for (const name of names) {
      const source = payload[name] ?? (payload.version === 1 && !["harvesters", "entries"].includes(name) ? [] : null);
      check(Array.isArray(source), `File thiếu danh sách ${name}.`);
      const ids = new Set();
      data[name] = source.map(row => {
        check(row && typeof row.id === "string" && row.id.length > 0 && row.id.length <= 150 && !ids.has(row.id), `ID thiếu hoặc trùng trong ${name}.`);
        ids.add(row.id);
        check(typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt)), `Thời điểm tạo không hợp lệ trong ${name}.`);
        check(row.updatedAt === undefined || (typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt))), `Thời điểm cập nhật không hợp lệ trong ${name}.`);
        return { ...row, updatedAt: row.updatedAt || row.createdAt };
      });
    }
    const people = new Map(data.harvesters.map(p => [p.id, p]));
    const text = (s, max) => typeof s === "string" && s.trim().length > 0 && s.length <= max;
    for (const p of data.harvesters) check(text(p.name, 80), "Tên người hái trong file không hợp lệ.");
    for (const e of data.entries) {
      check(people.has(e.harvesterId) && isDate(e.date), "Số kg không có người hái hoặc ngày hợp lệ.");
      kg100(e.kg);
    }
    const rateKeys = new Set();
    for (const r of data.rates) {
      check((r.harvesterId === null || people.has(r.harvesterId)) && isDate(r.effectiveDate) && integer(r.amount) && r.amount <= 100000000, "Đơn giá trong file không hợp lệ.");
      const key = JSON.stringify([r.harvesterId, r.effectiveDate]);
      check(!rateKeys.has(key), "File có đơn giá trùng ngày và đối tượng áp dụng."); rateKeys.add(key);
    }
    for (const a of data.advances) check(people.has(a.harvesterId) && isDate(a.date) && integer(a.amount, 1) && a.amount <= 1000000000000 && typeof a.note === "string" && a.note.length <= 500, "Khoản ứng trong file không hợp lệ.");
    const entries = new Map(data.entries.map(e => [e.id, e]));
    const advances = new Map(data.advances.map(a => [a.id, a]));
    const settled = new Set(), used = new Map();
    for (const s of data.settlements) {
      check(people.has(s.harvesterId) && text(s.personName, 80) && ["range", "all"].includes(s.mode) &&
        (s.mode === "all" ? s.from === "" && s.to === "" : isDate(s.from) && isDate(s.to) && s.from <= s.to), "Thông tin kết sổ không hợp lệ.");
      check(Array.isArray(s.entryIds) && s.entryIds.length > 0 && Array.isArray(s.days) && Array.isArray(s.advanceAllocations), "Lịch sử kết sổ thiếu chi tiết.");
      const dayIds = [], dates = new Set(); let gross = 0, totalKg = 0;
      for (const d of s.days) {
        check(isDate(d.date) && !dates.has(d.date) && (s.mode === "all" || (d.date >= s.from && d.date <= s.to)) && integer(d.rate) && d.rate <= 100000000 && typeof d.rateId === "string" && Array.isArray(d.entryIds) && d.entryIds.length > 0, "Chi tiết ngày kết sổ không hợp lệ.");
        dates.add(d.date); let kg = 0;
        for (const id of d.entryIds) {
          const e = entries.get(id);
          check(e && e.harvesterId === s.harvesterId && e.date === d.date && !settled.has(id), "Số kg kết toán bị thiếu hoặc tính trùng.");
          settled.add(id); dayIds.push(id); kg = safe(kg + kg100(e.kg));
        }
        check(Number.isSafeInteger(kg * d.rate) && d.kg100 === kg && d.amount === Math.round(kg * d.rate / 100), "Số tiền và sản lượng kết sổ không khớp.");
        gross = safe(gross + d.amount); totalKg = safe(totalKg + kg);
      }
      check(dayIds.length === s.entryIds.length && new Set(s.entryIds).size === s.entryIds.length && dayIds.every(id => s.entryIds.includes(id)), "Danh sách số kg kết sổ không khớp.");
      let applied = 0;
      const settlementAdvanceIds = new Set();
      for (const a of s.advanceAllocations) {
        const original = advances.get(a.advanceId);
        check(original && !settlementAdvanceIds.has(a.advanceId) && original.harvesterId === s.harvesterId && original.date === a.date && integer(a.amount, 1) &&
          (s.mode === "all" || a.date <= s.to) && typeof a.note === "string", "Khoản ứng đã khấu trừ không hợp lệ.");
        settlementAdvanceIds.add(a.advanceId);
        used.set(a.advanceId, safe((used.get(a.advanceId) || 0) + a.amount));
        check(used.get(a.advanceId) <= original.amount, "Một khoản ứng bị khấu trừ vượt số tiền gốc.");
        applied = safe(applied + a.amount);
      }
      check(integer(s.availableAdvance) && s.totalKg100 === totalKg && s.gross === gross &&
        s.advanceApplied === applied && applied === Math.min(gross, s.availableAdvance) &&
        s.payable === gross - applied && s.carry === s.availableAdvance - applied, "Tổng tiền kết sổ không khớp.");
    }
    return { ...data, settings: { theme: payload.settings?.theme === "blue" ? "blue" : "green" } };
  }
  globalThis.SoghiLedger = Object.freeze({ isDate, kg100, integer, safe, order, lockedIds, allocations, effectiveRate, buildSettlement, validateBackup });
})();
