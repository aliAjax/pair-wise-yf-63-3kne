export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AuditAction = 'randomized' | 'unblinded' | 'pending-queued' | 'pending-committed' | 'duplicate-blocked' | 'dispensed' | 'dispense-rejected' | 'dispense-voided' | 'dispense-replaced' | 'dispense-queued' | 'box-added' | 'recalled';

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

/** 药盒状态：在库 / 已发完 / 已召回封存 */
export type BoxStatus = 'in-stock' | 'dispensed' | 'recalled';

/** 发药单状态：有效 / 作废（重复发药）/ 已换药（召回换药） */
export type DispenseStatus = 'valid' | 'void' | 'replaced';

export interface DrugBox {
  id: string;
  /** 药盒批号 */
  batchNo: string;
  /** 有效期 YYYY-MM-DD */
  expiryDate: string;
  quantity: number;
  status: BoxStatus;
  addedAt: string;
}

export interface DispenseItem {
  boxId: string;
  batchNo: string;
  expiryDate: string;
  quantity: number;
}

export interface DispenseOrder {
  id: string;
  /** 发药编号（药品管理员负责） */
  dispenseNo: string;
  /** 凭随机号发药 */
  randomNo: number;
  participantNo: string;
  site: string;
  /** 药盒批号明细 */
  items: DispenseItem[];
  totalQuantity: number;
  status: DispenseStatus;
  /** 作废 / 退回 / 换药说明 */
  reason?: string;
  createdAt: string;
  actor: string;
  /** 召回换药关联 */
  replaces?: string;
  replacedBy?: string;
  recallBatch?: string;
}

export interface DispenseInput {
  randomNo: number;
  quantity: number;
  actor: string;
}

/** 断网时留本中心、恢复后按次序补录的发药申请 */
export interface PendingDispense {
  id: string;
  payload: DispenseInput;
  createdAt: string;
  status: 'pending' | 'committed';
  result?: 'ok' | 'rejected';
  message?: string;
}
