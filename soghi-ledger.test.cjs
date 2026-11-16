const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./soghi-ledger.js');
const L = globalThis.SoghiLedger;
const stamp = '2026-11-01T08:00:00.000Z';
const row = values => ({ createdAt: stamp, updatedAt: stamp, ...values });
function fixture() {
  return {
    harvesters: [row({ id: 'p', name: 'Người A' }), row({ id: 'q', name: 'Người B' })],
    entries: [row({ id: 'e1', harvesterId: 'p', date: '2026-11-01', kg: 10 }), row({ id: 'e2', harvesterId: 'p', date: '2026-11-10', kg: 20 })],
    rates: [row({ id: 'r1', harvesterId: null, effectiveDate: '2026-11-01', amount: 2000 }), row({ id: 'r2', harvesterId: null, effectiveDate: '2026-11-10', amount: 2500 })],
    advances: [row({ id: 'a1', harvesterId: 'p', date: '2026-10-30', amount: 50000, note: 'Ứng trước vụ' })],
    settlements: []
  };
}
const selection = { mode: 'all' };
test('tính giá theo ngày, không lấy giá cuối cho toàn bộ kg', () => {
  const s = L.buildSettlement(fixture(), 'p', selection);
  assert.equal(s.gross, 70000); assert.equal(s.advanceApplied, 50000); assert.equal(s.payable, 20000);
});
test('giá riêng ưu tiên đúng người, đúng ngày bắt đầu', () => {
  const data = fixture(); data.rates.push(row({ id: 'rp', harvesterId: 'p', effectiveDate: '2026-11-05', amount: 3000 }));
  assert.equal(L.buildSettlement(data, 'p', selection).gross, 80000);
  assert.equal(L.effectiveRate(data.rates, 'q', '2026-11-10').amount, 2500);
  assert.equal(L.effectiveRate(data.rates, 'p', '2026-11-01').amount, 2000);
});
test('khoảng ngày và tiền ứng cũ; ứng tương lai không bị trừ', () => {
  const data = fixture(); data.advances.push(row({ id: 'future', harvesterId: 'p', date: '2026-11-11', amount: 9999, note: '' }));
  const s = L.buildSettlement(data, 'p', { mode: 'range', from: '2026-11-10', to: '2026-11-10' });
  assert.equal(s.gross, 50000); assert.equal(s.availableAdvance, 50000); assert.equal(s.payable, 0);
});
test('ứng vượt tiền công chuyển tiếp, không khấu trừ hai lần', () => {
  const data = fixture(); data.advances[0].amount = 90000;
  const first = L.buildSettlement(data, 'p', { mode: 'range', from: '2026-11-01', to: '2026-11-01' });
  assert.equal(first.advanceApplied, 20000); assert.equal(first.carry, 70000);
  data.settlements.push(row({ ...first, id: 's1' }));
  const second = L.buildSettlement(data, 'p', selection);
  assert.equal(second.gross, 50000); assert.equal(second.availableAdvance, 70000); assert.equal(second.carry, 20000);
  data.settlements.push(row({ ...second, id: 's2' }));
  assert.throws(() => L.buildSettlement(data, 'p', selection), /Không có/);
  assert.equal(L.allocations(data).get('a1'), 70000);
});
test('cộng kg bằng phần trăm kg và làm tròn tiền theo ngày', () => {
  const data = fixture(); data.entries = [row({ id: 'x', harvesterId: 'p', date: '2026-11-01', kg: .1 }), row({ id: 'y', harvesterId: 'p', date: '2026-11-01', kg: .2 })]; data.rates[0].amount = 101;
  const s = L.buildSettlement(data, 'p', selection); assert.equal(s.totalKg100, 30); assert.equal(s.gross, 30);
});
test('từ chối kết sổ thiếu giá, sai khoảng ngày, kg không hợp lệ', () => {
  const data = fixture(); data.rates = [];
  assert.throws(() => L.buildSettlement(data, 'p', selection), /Chưa có đơn giá/);
  assert.throws(() => L.buildSettlement(fixture(), 'p', { mode: 'range', from: '2026-11-10', to: '2026-11-01' }), /Khoảng ngày/);
  for (const kg of [-1, NaN, Infinity, 0.001, 1000000, '1']) assert.throws(() => L.kg100(kg));
});
test('khôi phục sao lưu cũ và mới; giữ snapshot khi đổi giá', () => {
  const data = fixture(), first = L.buildSettlement(data, 'p', selection);
  data.settlements.push(row({ ...first, id: 's1' })); data.rates[0].amount = 9999;
  const restored = L.validateBackup({ app: 'soghi', version: 2, ...data });
  assert.equal(restored.settlements[0].gross, 70000);
  const old = L.validateBackup({ app: 'soghi', version: 1, harvesters: data.harvesters, entries: data.entries });
  assert.deepEqual(old.advances, []); assert.deepEqual(old.settlements, []);
});
test('từ chối backup hỏng, ngày giả, bản ghi trùng, mồ côi, phiên bản lạ', () => {
  const payload = () => ({ app: 'soghi', version: 2, ...fixture() });
  const broken = payload(); broken.entries.push({ kg: 1 }); assert.throws(() => L.validateBackup(broken));
  const invalidDate = payload(); invalidDate.entries[0].date = '2026-02-30'; assert.throws(() => L.validateBackup(invalidDate));
  const duplicate = payload(); duplicate.entries.push(duplicate.entries[0]); assert.throws(() => L.validateBackup(duplicate));
  const orphan = payload(); orphan.entries[0].harvesterId = 'unknown'; assert.throws(() => L.validateBackup(orphan));
  assert.throws(() => L.validateBackup({ ...payload(), version: 99 }));
});
test('từ chối sửa tiền snapshot hoặc tính trùng kg trong backup', () => {
  const data = fixture(), s = L.buildSettlement(data, 'p', selection);
  data.settlements.push(row({ ...s, id: 's1' }));
  const original = { app: 'soghi', version: 2, ...data };
  const changed = structuredClone(original); changed.settlements[0].payable++; assert.throws(() => L.validateBackup(changed));
  const twice = structuredClone(original); twice.settlements.push({ ...twice.settlements[0], id: 's2' }); assert.throws(() => L.validateBackup(twice));
});
test('nhiều kỳ liên tiếp bảo toàn tiền ứng và không tính lại số kg', () => {
  for (const advance of [1, 1000, 50000, 70000, 90000]) {
    const data = fixture(); data.advances[0].amount = advance;
    let paid = 0;
    for (const date of ['2026-11-01', '2026-11-10']) {
      const s = L.buildSettlement(data, 'p', { mode: 'range', from: date, to: date });
      paid += s.payable; data.settlements.push(row({ ...s, id: 's' + date }));
    }
    const deducted = L.allocations(data).get('a1') || 0;
    assert.equal(paid + deducted, 70000); assert.equal(deducted, Math.min(advance, 70000));
    assert.doesNotThrow(() => L.validateBackup({ app: 'soghi', version: 2, ...data }));
  }
});
