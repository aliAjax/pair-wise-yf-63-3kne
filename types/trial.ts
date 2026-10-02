export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked'
  | 'dispensed'
  | 'dispense-rejected'
  | 'dispense-queued'
  | 'dispense-committed'
  | 'batch-recalled'
  | 'recall-exchanged'
  | 'recall-blocked';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: '18-44' | '45-64' | '65+';
  status: 'randomized' | 'unblinded';
  sequence: number;
  arm?: Arm;
  unblindedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
}

export interface PendingRandomization {
  id: string;
  payload: RandomizeInput;
  createdAt: string;
  status: 'pending' | 'committed';
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: Participant['ageBand'];
  actor: string;
}

// —— 药房发药台账 ——

/** 药盒按批号管理 */
export interface DrugBox {
  id: string;
  boxNo: string;        // 药盒（个体）编号
  batchNo: string;      // 药盒批号
  expiry: string;       // 有效期 YYYY-MM-DD
  status: 'available' | 'dispensed' | 'recalled';
}

/**
 * 发药单：同一随机号只保留一份有效单。
 * active 有效；voided 作废；exchanged 召回/补药换药后被新单替代（留痕）；
 * awaiting-exchange 召回后无盒可换，挂起待补药（对受试者表现为退回待换）。
 */
export interface DispenseOrder {
  id: string;
  orderNo: string;        // 发药编号（药品管理员负责）
  sequence: number;       // 随机号
  participantNo: string;
  site: string;
  boxNo: string;
  batchNo: string;        // 药盒批号（药品管理员负责）
  expiry: string;
  status: 'active' | 'voided' | 'exchanged' | 'awaiting-exchange';
  reason?: string;
  actor: string;
  dispensedAt: string;
  source: 'online' | 'offline-backfill';
  queueOrder?: number;
  replacesOrderNo?: string;
}

export interface BatchRecall {
  id: string;
  batchNo: string;
  reason: string;
  at: string;
  actor: string;
}

/** 断网时暂存本中心的发药申请，恢复后按 queueOrder 次序补录 */
export interface PendingDispense {
  id: string;
  queueOrder: number;
  payload: {
    sequence: number;
    participantNo: string;
    site: string;
    actor: string;
  };
  createdAt: string;
  status: 'pending' | 'committed' | 'rejected';
  result?: string;
}

export interface DispenseResult {
  ok: boolean;
  message: string;
  orderNo?: string;
  batchNo?: string;
  boxNo?: string;
}

export interface RecallResult {
  batchNo: string;
  affected: number;
  exchanged: number;
  blocked: { sequence: number; participantNo: string; reason: string }[];
}
