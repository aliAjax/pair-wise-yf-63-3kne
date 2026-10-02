import { defineStore } from 'pinia';
import type {
  Arm,
  AuditEntry,
  BatchRecall,
  DispenseOrder,
  DispenseResult,
  DrugBox,
  Participant,
  PendingDispense,
  PendingRandomization,
  RandomizeInput,
  RecallResult
} from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v2';
const today = '2026-10-02';

function iso(daysAgo: number) {
  return new Date(new Date(today).getTime() - daysAgo * 86_400_000).toISOString();
}

const seed: {
  participants: Participant[];
  audits: AuditEntry[];
  pending: PendingRandomization[];
  boxes: DrugBox[];
  orders: DispenseOrder[];
  recalls: BatchRecall[];
  pendingDispense: PendingDispense[];
  orderSeq: number;
  queueSeq: number;
} = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' },
    { id: 'p-3', participantNo: 'S01-003', identityKey: 'demo-c', site: '广州中心', ageBand: '18-44', status: 'unblinded', sequence: 1003, arm: 'A', unblindedAt: iso(2) },
    { id: 'p-4', participantNo: 'S01-004', identityKey: 'demo-d', site: '广州中心', ageBand: '65+', status: 'randomized', sequence: 1004, arm: 'B' },
    { id: 'p-5', participantNo: 'S01-005', identityKey: 'demo-e', site: '广州中心', ageBand: '18-44', status: 'randomized', sequence: 1005, arm: 'A' },
    { id: 'p-6', participantNo: 'S01-006', identityKey: 'demo-f', site: '新加坡中心', ageBand: '45-64', status: 'randomized', sequence: 1006, arm: 'B' },
    { id: 'p-7', participantNo: 'S01-007', identityKey: 'demo-g', site: '新加坡中心', ageBand: '65+', status: 'randomized', sequence: 1007, arm: 'A' }
  ],
  audits: [
    { id: 'a-1', at: iso(2), actor: '研究者张宁', action: 'unblinded', detail: '紧急揭盲：受试者出现严重不良事件需急救对因治疗；分配组别 A', participantNo: 'S01-003' },
    { id: 'a-2', at: iso(1), actor: '系统', action: 'randomized', detail: 'S01-004 完成分层随机，中央随机号 1004', participantNo: 'S01-004' }
  ],
  pending: [],
  // 药盒按批号管理（今天 2026-10-02）：B2026-03 为待召回首仿批次（在用 4 人）；
  // 合格替代盒 4 个 = 近效期 B2026-11×2 + 长效期 B2027-01×2；另含两个已过期批号供 FEFO 演示。
  boxes: [
    { id: 'b-1', boxNo: 'K0001', batchNo: 'B2025-11', expiry: '2025-11-30', status: 'available' },
    { id: 'b-2', boxNo: 'K0002', batchNo: 'B2026-03', expiry: '2027-03-31', status: 'dispensed' },
    { id: 'b-3', boxNo: 'K0003', batchNo: 'B2026-03', expiry: '2027-03-31', status: 'dispensed' },
    { id: 'b-4', boxNo: 'K0004', batchNo: 'B2026-03', expiry: '2027-03-31', status: 'dispensed' },
    { id: 'b-5', boxNo: 'K0005', batchNo: 'B2026-03', expiry: '2027-03-31', status: 'dispensed' },
    { id: 'b-6', boxNo: 'K0006', batchNo: 'B2026-09', expiry: '2026-09-15', status: 'available' },
    { id: 'b-7', boxNo: 'K0007', batchNo: 'B2026-11', expiry: '2026-11-30', status: 'available' },
    { id: 'b-8', boxNo: 'K0008', batchNo: 'B2026-11', expiry: '2026-11-30', status: 'available' },
    { id: 'b-9', boxNo: 'K0009', batchNo: 'B2027-01', expiry: '2027-01-31', status: 'available' },
    { id: 'b-10', boxNo: 'K0010', batchNo: 'B2027-01', expiry: '2027-01-31', status: 'available' }
  ],
  orders: [
    {
      id: 'o-1', orderNo: 'FY20261001-0001', sequence: 1001, participantNo: 'S01-001', site: '上海中心',
      boxNo: 'K0002', batchNo: 'B2026-03', expiry: '2027-03-31', status: 'active',
      actor: '药品管理员王岚', dispensedAt: iso(1), source: 'online'
    },
    {
      id: 'o-2', orderNo: 'FY20261001-0002', sequence: 1002, participantNo: 'S01-002', site: '上海中心',
      boxNo: 'K0003', batchNo: 'B2026-03', expiry: '2027-03-31', status: 'active',
      actor: '药品管理员王岚', dispensedAt: iso(1), source: 'online'
    },
    {
      id: 'o-3', orderNo: 'FY20261001-0003', sequence: 1003, participantNo: 'S01-003', site: '广州中心',
      boxNo: 'K0004', batchNo: 'B2026-03', expiry: '2027-03-31', status: 'active',
      actor: '药品管理员王岚', dispensedAt: iso(1), source: 'online'
    },
    {
      id: 'o-4', orderNo: 'FY20261001-0004', sequence: 1004, participantNo: 'S01-004', site: '广州中心',
      boxNo: 'K0005', batchNo: 'B2026-03', expiry: '2027-03-31', status: 'active',
      actor: '药品管理员王岚', dispensedAt: iso(1), source: 'online'
    }
  ],
  recalls: [],
  pendingDispense: [],
  orderSeq: 4,
  queueSeq: 0
};

export const useTrialStore = defineStore('trial', {
  state: () => readLocal(STORAGE_KEY, seed),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    pendingDispenseCount: (state) => state.pendingDispense.filter((item) => item.status === 'pending').length,
    recalledBatchNos: (state) => new Set(state.recalls.map((item) => item.batchNo)),

    /** 同一随机号的有效发药单（active 或挂起待换），按号唯一 */
    activeOrderBySequence(state) {
      return (sequence: number) => state.orders.find(
        (order) => order.sequence === sequence && (order.status === 'active' || order.status === 'awaiting-exchange')
      );
    },

    /**
     * 台账对账视图：随机号 × 有效发药单 × 药盒批号 三源合并，一随机号一行。
     */
    ledger(state) {
      const recalled = new Set(state.recalls.map((item) => item.batchNo));
      return [...state.participants]
        .sort((a, b) => a.sequence - b.sequence)
        .map((participant) => {
          const order = state.orders.find(
            (item) => item.sequence === participant.sequence
              && (item.status === 'active' || item.status === 'awaiting-exchange')
          );
          let boxStatus = '无发药单';
          if (order) {
            if (order.status === 'awaiting-exchange' || recalled.has(order.batchNo)) boxStatus = '召回待换药';
            else if (order.expiry < today) boxStatus = '已过期';
            else boxStatus = '在用药';
          }
          return {
            sequence: participant.sequence,
            participantNo: participant.participantNo,
            site: participant.site,
            participantStatus: participant.status,
            orderNo: order?.orderNo ?? '',
            batchNo: order?.batchNo ?? '',
            boxNo: order?.boxNo ?? '',
            expiry: order?.expiry ?? '',
            orderStatus: order?.status ?? '',
            reason: order?.reason ?? '',
            dispensedAt: order?.dispensedAt ?? '',
            boxStatus
          };
        });
    },

    /** 库存批号汇总（已召回批号整批冻结） */
    batchInventory(state) {
      const recalled = new Set(state.recalls.map((item) => item.batchNo));
      const map = new Map<string, { batchNo: string; expiry: string; total: number; available: number; recalled: boolean }>();
      for (const box of state.boxes) {
        const row = map.get(box.batchNo) ?? { batchNo: box.batchNo, expiry: box.expiry, total: 0, available: 0, recalled: recalled.has(box.batchNo) };
        row.total += 1;
        if (box.status === 'available' && box.expiry >= today && !recalled.has(box.batchNo)) row.available += 1;
        map.set(box.batchNo, row);
      }
      return [...map.values()].sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
    }
  },
  actions: {
    persist() {
      writeLocal(STORAGE_KEY, {
        participants: this.participants,
        audits: this.audits,
        pending: this.pending,
        boxes: this.boxes,
        orders: this.orders,
        recalls: this.recalls,
        pendingDispense: this.pendingDispense,
        orderSeq: this.orderSeq,
        queueSeq: this.queueSeq
      });
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },

    // —— 随机分组（原有流程，分组/揭盲记录与药房隔离，召回不触碰） ——

    randomize(input: RandomizeInput, offline = false): { ok: boolean; message: string; arm?: Arm } {
      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      if (offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: true, message: '已加入待提交队列，联网后确认入库' };
      }
      return this.commitRandomization(input);
    },
    commitRandomization(input: RandomizeInput): { ok: boolean; message: string; arm: Arm } {
      const sequence = 1000 + this.participants.length + 1;
      const sameStratum = this.participants.filter((item) => item.site === input.site && item.ageBand === input.ageBand);
      const arm: Arm = sameStratum.filter((item) => item.arm === 'A').length <= sameStratum.filter((item) => item.arm === 'B').length ? 'A' : 'B';
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, arm };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层随机，序列号 ${sequence}`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，中央序列号 ${sequence}`, arm };
    },
    commitPending(id: string, actor: string) {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return;
      pending.status = 'committed';
      this.commitRandomization(pending.payload);
      this.addAudit('pending-committed', `待提交记录已确认入库：${pending.payload.participantNo}`, actor, pending.payload.participantNo);
      this.persist();
    },
    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason}；分配组别 ${participant.arm}`, actor, participant.participantNo);
    },

    // —— 药房：选盒（批号 + 有效期，近效期先出 FEFO） ——

    pickBox(excludeBatchNos: string[] = []): DrugBox | null {
      const recalled = new Set(this.recalls.map((item) => item.batchNo));
      const frozen = new Set([...recalled, ...excludeBatchNos]);
      // YYYY-MM-DD 字典序即时间序；不使用 localeCompare（数字分段排序不稳定）
      const candidates = this.boxes
        .filter((box) => box.status === 'available' && box.expiry >= today && !frozen.has(box.batchNo))
        .sort((a, b) =>
          a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1
          : a.batchNo < b.batchNo ? -1 : a.batchNo > b.batchNo ? 1
          : a.boxNo < b.boxNo ? -1 : a.boxNo > b.boxNo ? 1 : 0
        );
      return candidates[0] ?? null;
    },

    nextOrderNo(): string {
      this.orderSeq += 1;
      return `FY20261001-${String(this.orderSeq).padStart(4, '0')}`;
    },

    /** 内部：创建一份发药单并占用药盒；无盒可发时返回退回原因，不产生任何单据 */
    fulfill(input: { sequence: number; participantNo: string; site: string; actor: string }, source: DispenseOrder['source'], queueOrder?: number, replacesOrderNo?: string): DispenseResult {
      const participant = this.participants.find((item) => item.sequence === input.sequence);
      if (!participant) return { ok: false, message: `随机号 ${input.sequence} 不存在，无法发药，已退回` };

      const duplicate = this.orders.find(
        (order) => order.sequence === input.sequence && order.status === 'active'
      );
      if (duplicate && !replacesOrderNo) {
        return { ok: false, message: `随机号 ${input.sequence} 已有有效发药单 ${duplicate.orderNo}（批号 ${duplicate.batchNo}），同一随机号仅留一份有效单，重复申请已退回` };
      }

      const box = this.pickBox();
      if (!box) {
        return { ok: false, message: `随机号 ${input.sequence}：无可用药盒（库存全部过期或已召回冻结），申请退回，待补药后重提` };
      }

      box.status = 'dispensed';
      const orderNo = this.nextOrderNo();
      const order: DispenseOrder = {
        id: crypto.randomUUID(),
        orderNo,
        sequence: input.sequence,
        participantNo: input.participantNo,
        site: input.site,
        boxNo: box.boxNo,
        batchNo: box.batchNo,
        expiry: box.expiry,
        status: 'active',
        actor: input.actor,
        dispensedAt: new Date().toISOString(),
        source,
        queueOrder,
        replacesOrderNo
      };
      this.orders.unshift(order);
      return { ok: true, message: `已发药：发药编号 ${orderNo}，批号 ${box.batchNo}，有效期 ${box.expiry}（近效期先出）`, orderNo, batchNo: box.batchNo, boxNo: box.boxNo };
    },

    /** 发药申请：断网时只留本中心待处理队列，不分配发药编号/不占盒 */
    requestDispense(input: { sequence: number; participantNo: string; site: string; actor: string }, offline: boolean): DispenseResult {
      const participant = this.participants.find((item) => item.sequence === input.sequence);
      if (!participant) return { ok: false, message: `随机号 ${input.sequence} 不存在，无法发药，已退回` };
      if (this.orders.some((order) => order.sequence === input.sequence && order.status === 'active')) {
        const existing = this.orders.find((order) => order.sequence === input.sequence && order.status === 'active')!;
        return { ok: false, message: `随机号 ${input.sequence} 已有有效发药单 ${existing.orderNo}，重复申请已退回` };
      }
      if (this.pendingDispense.some((item) => item.status === 'pending' && item.payload.sequence === input.sequence)) {
        return { ok: false, message: `随机号 ${input.sequence} 的离线申请已在本中心待处理队列中，请勿重复提交` };
      }

      if (offline) {
        this.queueSeq += 1;
        const queued: PendingDispense = {
          id: crypto.randomUUID(),
          queueOrder: this.queueSeq,
          payload: input,
          createdAt: new Date().toISOString(),
          status: 'pending'
        };
        this.pendingDispense.push(queued);
        this.addAudit('dispense-queued', `离线发药申请暂存本中心：随机号 ${input.sequence}（${input.participantNo}），队列序号 ${queued.queueOrder}，恢复联网后按次序补录`, input.actor, input.participantNo);
        return { ok: true, message: `断网：申请已留本中心队列（序号 ${queued.queueOrder}），未发发药编号，恢复后按次序补录` };
      }

      const result = this.fulfill(input, 'online');
      this.addAudit(
        result.ok ? 'dispensed' : 'dispense-rejected',
        result.ok ? `${input.participantNo}（随机号 ${input.sequence}）${result.message}` : `发药退回：${result.message}`,
        input.actor,
        input.participantNo
      );
      return result;
    },

    /** 恢复联网：严格按队列次序（queueOrder 升序）逐条补录；库存不够的退回并继续后续条目 */
    processDispenseQueue(actor: string): { processed: number; committed: number; rejected: PendingDispense[] } {
      const queued = this.pendingDispense
        .filter((item) => item.status === 'pending')
        .sort((a, b) => a.queueOrder - b.queueOrder);
      const rejected: PendingDispense[] = [];
      let committed = 0;
      for (const item of queued) {
        const result = this.fulfill(item.payload, 'offline-backfill', item.queueOrder);
        if (result.ok) {
          item.status = 'committed';
          item.result = result.message;
          committed += 1;
          this.addAudit('dispense-committed', `离线队列按序补录：序号 ${item.queueOrder}，${result.message}`, actor, item.payload.participantNo);
        } else {
          item.status = 'rejected';
          item.result = result.message;
          rejected.push(item);
          this.addAudit('dispense-rejected', `离线队列补录退回：序号 ${item.queueOrder}，${result.message}`, actor, item.payload.participantNo);
        }
      }
      this.persist();
      return { processed: queued.length, committed, rejected };
    },

    /**
     * 批号召回：一次查出全部在用该批号的受试者并逐人换药。
     * 只动药房单据与药盒；分组（arm）和揭盲记录完全不修改。
     */
    recallBatch(batchNo: string, reason: string, actor: string): RecallResult {
      const trimmed = batchNo.trim();
      const summary: RecallResult = { batchNo: trimmed, affected: 0, exchanged: 0, blocked: [] };
      if (!trimmed) return summary;
      if (this.recalls.some((item) => item.batchNo === trimmed)) {
        return { ...summary, blocked: [], };
      }

      // 冻结该批号：盒状态置 recalled
      for (const box of this.boxes) {
        if (box.batchNo === trimmed && box.status === 'available') box.status = 'recalled';
      }

      // 一次查出所有在用该批号的有效单
      const affectedOrders = this.orders.filter(
        (order) => order.batchNo === trimmed && (order.status === 'active' || order.status === 'awaiting-exchange')
      );
      summary.affected = affectedOrders.length;

      if (summary.affected === 0) {
        this.recalls.unshift({ id: crypto.randomUUID(), batchNo: trimmed, reason: reason.trim() || '厂家召回', at: new Date().toISOString(), actor });
        this.addAudit('batch-recalled', `批号 ${trimmed} 已登记召回并冻结库存，当前无在用药受试者`, actor);
        return summary;
      }

      for (const old of affectedOrders) {
        const box = this.pickBox();
        if (!box) {
          old.status = 'awaiting-exchange';
          old.reason = `原批号 ${trimmed} 召回；无可用替换药盒，退回挂起，待补药`;
          summary.blocked.push({ sequence: old.sequence, participantNo: old.participantNo, reason: '无可用药盒，待补药后换药' });
          this.addAudit('recall-blocked', `召回换药未完成：${old.participantNo}（随机号 ${old.sequence}）原批号 ${trimmed}，无可用药盒，已退回挂起待补药`, actor, old.participantNo);
          continue;
        }
        box.status = 'dispensed';
        this.orderSeq += 1;
        const newOrder: DispenseOrder = {
          id: crypto.randomUUID(),
          orderNo: `FY20261001-${String(this.orderSeq).padStart(4, '0')}`,
          sequence: old.sequence,
          participantNo: old.participantNo,
          site: old.site,
          boxNo: box.boxNo,
          batchNo: box.batchNo,
          expiry: box.expiry,
          status: 'active',
          actor,
          dispensedAt: new Date().toISOString(),
          source: 'online',
          replacesOrderNo: old.orderNo
        };
        old.status = 'exchanged';
        old.reason = `原批号 ${trimmed} 召回，换发 ${box.batchNo}/${box.boxNo}`;
        this.orders.unshift(newOrder);
        summary.exchanged += 1;
        this.addAudit('recall-exchanged', `召回换药：${old.participantNo}（随机号 ${old.sequence}）原单 ${old.orderNo}（批号 ${trimmed}）作废，换发 ${newOrder.orderNo}（批号 ${box.batchNo}，有效期 ${box.expiry}）`, actor, old.participantNo);
      }

      this.recalls.unshift({ id: crypto.randomUUID(), batchNo: trimmed, reason: reason.trim() || '厂家召回', at: new Date().toISOString(), actor });
      this.addAudit('batch-recalled', `批号 ${trimmed} 登记召回：涉及 ${summary.affected} 人，成功换药 ${summary.exchanged} 人，退回待补 ${summary.blocked.length} 人；分组与揭盲记录未做任何改动`, actor);
      this.persist();
      return summary;
    }
  }
});
