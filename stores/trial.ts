import { defineStore } from 'pinia';
import type { Arm, AuditEntry, DispenseInput, DispenseItem, DispenseOrder, DrugBox, Participant, PendingDispense, PendingRandomization, RandomizeInput } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v1';
const seed: { participants: Participant[]; audits: AuditEntry[]; pending: PendingRandomization[]; boxes: DrugBox[]; dispenses: DispenseOrder[]; pendingDispenses: PendingDispense[] } = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002', participantNo: 'S01-002' }
  ],
  pending: [],
  boxes: [
    { id: 'box-1', batchNo: 'B2025-11', expiryDate: '2026-10-31', quantity: 3, status: 'in-stock', addedAt: new Date(Date.now() - 86400_000 * 30).toISOString() },
    { id: 'box-2', batchNo: 'B2026-01', expiryDate: '2027-01-31', quantity: 10, status: 'in-stock', addedAt: new Date(Date.now() - 86400_000 * 20).toISOString() },
    { id: 'box-3', batchNo: 'B2026-03', expiryDate: '2027-03-31', quantity: 8, status: 'in-stock', addedAt: new Date(Date.now() - 86400_000 * 10).toISOString() }
  ],
  dispenses: [],
  pendingDispenses: []
};

/** 按有效期优先（FEFO）挑药盒：有效期早的先出，同效期按批号排序 */
function pickBoxes(boxes: DrugBox[], need: number): { picked: DispenseItem[]; short: number } {
  const available = boxes
    .filter((box) => box.status === 'in-stock' && box.quantity > 0)
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.batchNo.localeCompare(b.batchNo));
  const picked: DispenseItem[] = [];
  let remaining = need;
  for (const box of available) {
    if (remaining <= 0) break;
    const take = Math.min(box.quantity, remaining);
    picked.push({ boxId: box.id, batchNo: box.batchNo, expiryDate: box.expiryDate, quantity: take });
    remaining -= take;
  }
  return { picked, short: remaining };
}

export const useTrialStore = defineStore('trial', {
  state: () => {
    const data = readLocal(STORAGE_KEY, seed);
    return { ...data, boxes: data.boxes ?? [], dispenses: data.dispenses ?? [], pendingDispenses: data.pendingDispenses ?? [] };
  },
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    pendingDispenseCount: (state) => state.pendingDispenses.filter((item) => item.status === 'pending').length,
    validDispenseCount: (state) => state.dispenses.filter((item) => item.status === 'valid').length,
    inStockBoxCount: (state) => state.boxes.filter((item) => item.status === 'in-stock' && item.quantity > 0).length
  },
  actions: {
    persist() {
      writeLocal(STORAGE_KEY, {
        participants: this.participants,
        audits: this.audits,
        pending: this.pending,
        boxes: this.boxes,
        dispenses: this.dispenses,
        pendingDispenses: this.pendingDispenses
      });
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },
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

    // ───────────────────────── 药房：药盒入库 ─────────────────────────
    addBox(input: { batchNo: string; expiryDate: string; quantity: number }, actor: string) {
      this.boxes.unshift({
        id: crypto.randomUUID(),
        batchNo: input.batchNo,
        expiryDate: input.expiryDate,
        quantity: input.quantity,
        status: 'in-stock',
        addedAt: new Date().toISOString()
      });
      this.addAudit('box-added', `药盒入库：批号 ${input.batchNo}，有效期 ${input.expiryDate}，数量 ${input.quantity} 盒`, actor);
    },

    // ───────────────────────── 药房：凭随机号发药 ─────────────────────────
    dispense(input: DispenseInput, offline = false): { ok: boolean; message: string; order?: DispenseOrder } {
      const participant = this.participants.find((item) => item.sequence === input.randomNo);
      if (!participant) {
        this.addAudit('dispense-rejected', `发药退回：未找到随机号 ${input.randomNo} 对应的受试者`, input.actor);
        return { ok: false, message: `未找到随机号 ${input.randomNo}，已退回并记录` };
      }
      if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
        this.addAudit('dispense-rejected', `发药退回：随机号 ${input.randomNo} 发药数量无效（${input.quantity}）`, input.actor, participant.participantNo);
        return { ok: false, message: '发药数量须为正整数，已退回' };
      }

      // 断网：申请先留本中心，不占库存、不挑批号，恢复补录时再按当时库存挑药盒
      if (offline) {
        const queued: PendingDispense = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pendingDispenses.push(queued);
        this.addAudit('dispense-queued', `断网发药申请留本中心待补录：随机号 ${input.randomNo}，数量 ${input.quantity} 盒`, input.actor, participant.participantNo);
        return { ok: true, message: '断网申请已留本中心，恢复后按次序补录' };
      }

      const { picked, short } = pickBoxes(this.boxes, input.quantity);
      if (short > 0) {
        const detail = picked.length
          ? `可用批号 ${picked.map((item) => `${item.batchNo}（有效期 ${item.expiryDate}）${item.quantity} 盒`).join('、')}，仍缺 ${short} 盒`
          : '无可用库存';
        this.addAudit('dispense-rejected', `发药退回：随机号 ${input.randomNo} 需 ${input.quantity} 盒，库存不足（${detail}）`, input.actor, participant.participantNo);
        return { ok: false, message: `库存不足：需 ${input.quantity} 盒，缺 ${short} 盒，已退回并说明` };
      }

      // 同一随机号只留一份有效发药单：旧单作废
      const duplicate = this.dispenses.find((item) => item.randomNo === input.randomNo && item.status === 'valid');
      if (duplicate) {
        duplicate.status = 'void';
        duplicate.reason = '同一随机号重复发药，旧单作废';
        this.addAudit('dispense-voided', `发药单 ${duplicate.dispenseNo} 因同一随机号 ${input.randomNo} 重复发药作废`, input.actor, participant.participantNo);
      }

      const order = this.commitDispense(participant, picked, input.quantity, input.actor);
      this.addAudit('dispensed', `凭随机号 ${input.randomNo} 发药 ${order.dispenseNo}，药盒批号 ${picked.map((item) => item.batchNo).join('、')}`, input.actor, participant.participantNo);
      return { ok: true, message: `发药成功：${order.dispenseNo}，批号 ${picked.map((item) => item.batchNo).join('、')}`, order };
    },

    commitDispense(participant: Participant, items: DispenseItem[], totalQuantity: number, actor: string, extra: Partial<DispenseOrder> = {}): DispenseOrder {
      const dispenseNo = `FY-${String(this.dispenses.length + 1).padStart(4, '0')}`;
      const order: DispenseOrder = {
        id: crypto.randomUUID(),
        dispenseNo,
        randomNo: participant.sequence,
        participantNo: participant.participantNo,
        site: participant.site,
        items,
        totalQuantity,
        status: 'valid',
        createdAt: new Date().toISOString(),
        actor,
        ...extra
      };
      this.dispenses.unshift(order);
      for (const item of items) {
        const box = this.boxes.find((candidate) => candidate.id === item.boxId);
        if (!box) continue;
        box.quantity -= item.quantity;
        if (box.quantity <= 0) {
          box.quantity = 0;
          box.status = 'dispensed';
        }
      }
      return order;
    },

    /** 断网发药申请恢复后按次序（FIFO）补录；库存不足则退回并说明 */
    commitPendingDispense(id: string, actor: string) {
      const pending = this.pendingDispenses.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return;
      pending.status = 'committed';
      const result = this.dispense(pending.payload, false);
      pending.result = result.ok ? 'ok' : 'rejected';
      pending.message = result.message;
      this.addAudit('pending-committed', `断网发药申请已按次序补录：随机号 ${pending.payload.randomNo} → ${result.message}`, actor);
      this.persist();
    },

    // ───────────────────────── 药房：批号召回 ─────────────────────────
    recallBatch(batchNo: string, actor: string): { affected: DispenseOrder[]; sealed: DrugBox[] } {
      const sealed = this.boxes.filter((box) => box.batchNo === batchNo && box.status === 'in-stock');
      for (const box of sealed) box.status = 'recalled';
      const affected = this.dispenses.filter((item) => item.status === 'valid' && item.items.some((line) => line.batchNo === batchNo));
      this.addAudit(
        'recalled',
        `批号 ${batchNo} 药盒召回：封存在库 ${sealed.reduce((sum, box) => sum + box.quantity, 0)} 盒，查到已发药受试者 ${affected.length} 人（随机号 ${affected.map((item) => item.randomNo).join('、') || '无'}）`,
        actor
      );
      return { affected, sealed };
    },

    /** 召回批号受试者一次查出换药；库存不足的退回并说明，分组与揭盲记录不动 */
    replaceForRecall(batchNo: string, actor: string): { replaced: DispenseOrder[]; failed: { randomNo: number; reason: string }[] } {
      const targets = this.dispenses.filter((item) => item.status === 'valid' && item.items.some((line) => line.batchNo === batchNo));
      const replaced: DispenseOrder[] = [];
      const failed: { randomNo: number; reason: string }[] = [];
      for (const old of targets) {
        const participant = this.participants.find((item) => item.sequence === old.randomNo);
        if (!participant) {
          failed.push({ randomNo: old.randomNo, reason: '未找到随机号对应的受试者' });
          continue;
        }
        const { picked, short } = pickBoxes(this.boxes, old.totalQuantity);
        if (short > 0) {
          failed.push({ randomNo: old.randomNo, reason: `库存不足：需换药 ${old.totalQuantity} 盒，缺 ${short} 盒，已退回` });
          continue;
        }
        const order = this.commitDispense(participant, picked, old.totalQuantity, actor, { replaces: old.id, recallBatch: batchNo });
        old.status = 'replaced';
        old.replacedBy = order.id;
        old.reason = `召回批号 ${batchNo} 换药`;
        this.addAudit('dispense-replaced', `召回换药：随机号 ${old.randomNo} 原单 ${old.dispenseNo} 作废，换新单 ${order.dispenseNo}（批号 ${picked.map((item) => item.batchNo).join('、')}）`, actor, old.participantNo);
        replaced.push(order);
      }
      if (failed.length > 0) {
        this.addAudit('dispense-rejected', `召回批号 ${batchNo} 换药退回：${failed.map((item) => `随机号 ${item.randomNo}（${item.reason}）`).join('；')}`, actor);
      }
      return { replaced, failed };
    }
  }
});
