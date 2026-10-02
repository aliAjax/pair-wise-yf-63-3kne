import { build } from 'esbuild';
import { createPinia, setActivePinia } from 'pinia';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const storePath = resolve(root, 'stores/trial.ts');

const result = await build({
  entryPoints: [storePath],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '~': resolve(root) },
  external: ['pinia', 'vue', 'vue-demi'],
  loader: { '.ts': 'ts' }
});

const tmp = resolve(root, `.verify-bundle-${Date.now()}.mjs`);
writeFileSync(tmp, result.outputFiles[0].text);
const mod = await import('file://' + tmp);
const { useTrialStore } = mod;
process.on('exit', () => { try { unlinkSync(tmp); } catch {} });

setActivePinia(createPinia());
globalThis.crypto ??= { randomUUID: () => 'id-' + Math.random().toString(36).slice(2) };

const store = useTrialStore();
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('PASS', name); pass++; };

// 初始：7 名随机者，4 张有效单（均在 B2026-03，有效期 2027-03-31）；
// 合格替代盒 4 个（K0007/K0008 近效期 B2026-11，K0009/K0010 长效期 B2027-01），B2025-11、B2026-09 已过期
ok('7 participants', store.participants.length === 7);
ok('4 active orders', store.orders.filter((o) => o.status === 'active').length === 4);
ok('available batches excludes expired B2025-11 from count',
  store.batchInventory.find((b) => b.batchNo === 'B2025-11').available === 0);
ok('expired B2026-09 (2026-09-15) also has 0 available',
  store.batchInventory.find((b) => b.batchNo === 'B2026-09').available === 0);

// FEFO：给 1005 发药 -> 跳过过期盒，选近效期合格盒 K0007（B2026-11，2026-11-30）
let r = store.requestDispense({ sequence: 1005, participantNo: 'S01-005', site: '广州中心', actor: '药品管理员王岚' }, false);
ok('1005 dispensed ok', r.ok);
ok('FEFO picks K0007/B2026-11 nearest-expiry (expired batches skipped)', r.boxNo === 'K0007' && r.batchNo === 'B2026-11');

// 同一随机号重复发药 -> 退回，不产生新单
const beforeCount = store.orders.length;
r = store.requestDispense({ sequence: 1005, participantNo: 'S01-005', site: '广州中心', actor: '药品管理员王岚' }, false);
ok('duplicate rejected', !r.ok && /已有有效发药单/.test(r.message));
ok('no new order on reject', store.orders.length === beforeCount);

// 不存在的随机号 -> 退回
r = store.requestDispense({ sequence: 9999, participantNo: 'X', site: '上海中心', actor: 'p' }, false);
ok('unknown sequence rejected', !r.ok && /不存在/.test(r.message));

// 分组/揭盲在后续操作中保持不动（快照）
const armsSnapshot = store.participants.map((p) => [p.sequence, p.arm, p.status, p.unblindedAt]);

// 断网：1006/1007 两个申请进本中心队列，按次序排队，无发药编号
r = store.requestDispense({ sequence: 1006, participantNo: 'S01-006', site: '新加坡中心', actor: 'p' }, true);
ok('offline queued 1006', r.ok && /序号 1/.test(r.message));
r = store.requestDispense({ sequence: 1007, participantNo: 'S01-007', site: '新加坡中心', actor: 'p' }, true);
ok('offline queued 1007 order 2', r.ok && /序号 2/.test(r.message));
ok('pending dispense count 2', store.pendingDispenseCount === 2);
ok('queued items have no order number', store.orders.every((o) => o.sequence !== 1006 || o.source !== 'offline-backfill'));
r = store.requestDispense({ sequence: 1006, participantNo: 'S01-006', site: '新加坡中心', actor: 'p' }, true);
ok('duplicate offline blocked', !r.ok);

// 发完 K0007 后合格盒剩 3 个（K0008 近效期 + K0009/K0010）。召回 B2026-03 涉及 4 人 => 换药 3、退回 1
const recall = store.recallBatch('B2026-03', '溶出度不达标', '药品管理员王岚');
ok('recall affected 4', recall.affected === 4);
ok('recall exchanged 3', recall.exchanged === 3);
ok('recall blocked 1', recall.blocked.length === 1);
ok('recall batch frozen', store.boxes.filter((b) => b.batchNo === 'B2026-03').every((b) => b.status === 'recalled' || b.status === 'dispensed'));
ok('recall row registered', store.recalls.some((x) => x.batchNo === 'B2026-03'));

// 旧单 exchanged 留痕（不删除），新单 active 且 replacesOrderNo 有值
ok('4 old orders exchanged/awaiting, none active on recalled batch',
  store.orders.filter((o) => o.batchNo === 'B2026-03').every((o) => o.status === 'exchanged' || o.status === 'awaiting-exchange'));
const newOrders = store.orders.filter((o) => o.replacesOrderNo);
ok('3 replacement orders created', newOrders.length === 3);
ok('replacement batches not recalled', newOrders.every((o) => o.batchNo !== 'B2026-03'));
ok('blocked subject awaiting-exchange',
  store.orders.some((o) => o.status === 'awaiting-exchange' && recall.blocked.some((b) => b.sequence === o.sequence)));

// 台账：每个随机号至多 1 个有效/挂起行
const ledger = store.ledger;
ok('ledger 7 rows one per sequence', ledger.length === 7);
const counts = {};
ledger.forEach((row) => { counts[row.sequence] = (counts[row.sequence] ?? 0) + 1; });
ok('ledger unique sequences', Object.values(counts).every((c) => c === 1));
ok('recalled-pending row flagged', ledger.filter((row) => row.boxStatus === '召回待换药').length === 1);

// 分组与揭盲记录完全未变
assert.deepEqual(
  store.participants.map((p) => [p.sequence, p.arm, p.status, p.unblindedAt]),
  armsSnapshot,
  'arms/unblind untouched'
);
ok('arm & unblind records untouched by recall', true);

// 揭盲审计记录仍保留（追加式）
ok('unblind audit retained', store.audits.some((a) => a.action === 'unblinded'));

// 恢复联网 FIFO 补录：此时合格盒剩余 0（K0007 给了 1005，K0008/K0009/K0010 用于召回换药）=> 两条全部按序处理但退回
const flush = store.processDispenseQueue('药品管理员王岚');
ok('queue processed 2 in order', flush.processed === 2);
ok('queue committed 0 (no stock)', flush.committed === 0);
ok('queue rejected 2 with reasons', flush.rejected.length === 2 && flush.rejected.every((q) => /无可用|有效发药单/.test(q.result)));
const qs = [...store.pendingDispense].sort((a, b) => a.queueOrder - b.queueOrder);
ok('queue order preserved', qs[0].queueOrder === 1 && qs[0].payload.sequence === 1006 && qs[1].payload.sequence === 1007);

// 补药后再次为挂起者发起发药：模拟补药入库
store.boxes.push({ id: 'b-11', boxNo: 'K0011', batchNo: 'B2027-06', expiry: '2027-06-30', status: 'available' });
store.persist();
// awaiting-exchange 的随机号允许重新申请（无 active 单）
r = store.requestDispense({ sequence: recall.blocked[0].sequence, participantNo: recall.blocked[0].participantNo, site: '广州中心', actor: 'p' }, false);
ok('re-dispense after restock succeeds', r.ok && r.batchNo === 'B2027-06');

// 二次召回同批号被拒
const second = store.recallBatch('B2026-03', 'x', 'p');
ok('double recall no-op', second.affected === 0);

console.log(`\nALL ${pass} ASSERTIONS PASSED`);
