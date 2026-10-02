<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { AuditEntry, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending, orders, recalls } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
const dispenseOffline = ref(false);
const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({ validationSchema: schema, initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '研究者张宁' } });
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');

// —— 角色边界：治疗组对药品管理员始终隐藏；揭盲原因仅研究者可见 ——
const visibleArm = (arm?: 'A' | 'B', status?: string) => {
  if (role.value === 'pharmacist') return '已隐藏';
  if (role.value === 'monitor' && status === 'unblinded') return arm ?? '未知';
  return '已隐藏';
};

const isPharmacyAudit = (action: AuditEntry['action']) =>
  ['dispensed', 'dispense-rejected', 'dispense-queued', 'dispense-committed', 'batch-recalled', 'recall-exchanged', 'recall-blocked'].includes(action);

const maskedAuditDetail = (entry: AuditEntry) => {
  if (entry.action === 'unblinded' && role.value !== 'investigator') {
    return '紧急揭盲记录（揭盲原因与治疗组按角色边界隐藏）';
  }
  if (isPharmacyAudit(entry.action) && role.value !== 'pharmacist') {
    return entry.detail
      .replace(/FY\d{8}-\d{4}/g, '发药编号***')
      .replace(/B\d{4}-\d{2}/g, '批号***')
      .replace(/K\d{4}/g, '药盒***');
  }
  return entry.detail;
};

const submit = handleSubmit((values) => {
  const result = trial.randomize(values, offline.value);
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.success(result.message);
  resetForm({ values: { participantNo: '', identityKey: '', site: values.site, ageBand: values.ageBand, actor: values.actor } });
});

const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因`, '紧急揭盲', { inputType: 'textarea', inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空', confirmButtonText: '确认并审计' });
    trial.emergencyUnblind(id, value, actor.value);
    ElMessage.warning('已揭盲，审计记录已追加');
  } catch {}
};

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount,
  activeOrders: orders.value.filter((item) => item.status === 'active').length,
  recalledBatches: recalls.value.length,
  pendingDispense: trial.pendingDispenseCount
}));

// —— 药房发药 ——
const dispenseSequence = ref<number>();
const dispenseActor = ref('药品管理员王岚');
const armBySequence = computed(() => new Map(participants.value.map((item) => [item.sequence, item])));

/** 可申请发药：已随机、无有效发药单、无待处理离线申请 */
const dispensable = computed(() =>
  [...participants.value]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((p) =>
      !trial.activeOrderBySequence(p.sequence)
      && !trial.pendingDispense.some((q) => q.status === 'pending' && q.payload.sequence === p.sequence)
    )
);

const selectedSite = computed(() =>
  participants.value.find((item) => item.sequence === dispenseSequence.value)?.site ?? ''
);

const submitDispense = () => {
  if (role.value !== 'pharmacist') {
    ElMessage.error('发药编号与药盒批号由药品管理员负责，请切换角色后操作');
    return;
  }
  if (!dispenseSequence.value) {
    ElMessage.warning('请选择随机号');
    return;
  }
  const participant = participants.value.find((item) => item.sequence === dispenseSequence.value)!;
  const result = trial.requestDispense(
    { sequence: participant.sequence, participantNo: participant.participantNo, site: participant.site, actor: dispenseActor.value },
    dispenseOffline.value
  );
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.error(result.message);
  dispenseSequence.value = undefined;
};

const flushQueue = () => {
  if (role.value !== 'pharmacist') {
    ElMessage.error('补录由药品管理员执行');
    return;
  }
  const result = trial.processDispenseQueue(dispenseActor.value);
  if (result.processed === 0) {
    ElMessage.info('队列中没有待补录申请');
    return;
  }
  ElMessageBox.alert(
    `按队列次序处理 ${result.processed} 条：成功补录 ${result.committed} 条，退回 ${result.rejected.length} 条。`
    + (result.rejected.length ? '\n退回明细：\n' + result.rejected.map((item) => `· 序号${item.queueOrder} 随机号${item.payload.sequence}：${item.result}`).join('\n') : ''),
    '联网补录结果',
    { customClass: 'queue-result' }
  ).catch(() => {});
};

const recall = async (batchNo: string) => {
  if (role.value !== 'pharmacist') {
    ElMessage.error('召回归口药品管理员操作');
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt(`登记批号 ${batchNo} 召回，请填写召回原因（换药将自动按近效期先出执行）`, '批号召回', {
      inputType: 'textarea',
      inputValue: '厂家来函：该批次溶出度不符合质量标准',
      inputValidator: (value) => Boolean(value?.trim()) || '召回原因不能为空',
      confirmButtonText: '登记召回并一次换药'
    });
    const result = trial.recallBatch(batchNo, value, dispenseActor.value);
    ElMessageBox.alert(
      `批号 ${result.batchNo}：一次查出在用受试者 ${result.affected} 人；`
      + `成功换药 ${result.exchanged} 人；退回待补药 ${result.blocked.length} 人。`
      + (result.blocked.length ? '\n未完成换药：\n' + result.blocked.map((item) => `· 随机号 ${item.sequence}（${item.participantNo}）：${item.reason}`).join('\n') : '')
      + '\n分组与揭盲记录未做任何改动。',
      '召回换药结果',
      { type: result.blocked.length ? 'warning' : 'success' }
    ).catch(() => {});
  } catch {}
};

const statusTagType = (status: string) => ({
  active: 'success',
  exchanged: 'info',
  voided: 'info',
  'awaiting-exchange': 'warning'
} as Record<string, 'success' | 'info' | 'warning'>)[status] ?? 'info';

const boxStatusTag = (s: string) => ({
  在用药: 'success',
  召回待换药: 'danger',
  已过期: 'warning',
  无发药单: 'info'
} as Record<string, 'success' | 'danger' | 'warning' | 'info'>)[s] ?? 'info';
</script>

<template>
  <main class="page">
    <header class="hero">
      <div><el-tag type="success">GCP 本地原型</el-tag><h1>{{ t('title') }}</h1><p>{{ t('subtitle') }}</p></div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]" />
    </header>

    <section class="stat-row">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待补随机</span><b>{{ counts.pending }}</b></div>
      <div class="stat"><span>有效发药单</span><b>{{ counts.activeOrders }}</b></div>
      <div class="stat"><span>召回批号</span><b>{{ counts.recalledBatches }}</b></div>
      <div class="stat"><span>待补发药</span><b>{{ counts.pendingDispense }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header><b>{{ t('randomize') }}</b><el-switch v-model="offline" active-text="模拟离线" style="float:right" /></template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site"><el-select v-model="site" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
          <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-005" /></el-form-item>
          <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
          <el-form-item label="年龄分层" :error="errors.ageBand"><el-radio-group v-model="ageBand"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="操作人" :error="errors.actor"><el-input v-model="actor" /></el-form-item>
          <el-button type="primary" native-type="submit" style="width:100%">执行分层区组随机</el-button>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><div style="display:flex;justify-content:space-between"><b>{{ t('participants') }}</b><el-tag>{{ role }}</el-tag></div></template>
        <el-table :data="participants" max-height="480">
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column prop="site" label="中心" min-width="100" />
          <el-table-column prop="sequence" label="随机号" width="90" />
          <el-table-column label="治疗组" width="100"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="100"><template #default="{ row }"><el-button v-if="role === 'investigator'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button></template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <h2 class="section-title">药房发药台账对账 <el-tag size="small" type="info" effect="plain">随机号 × 发药单 × 药盒批号 三源合并；同一随机号仅一份有效单</el-tag></h2>

    <div class="grid">
      <el-card shadow="never">
        <template #header>
          <b>{{ t('dispense') }}</b>
          <el-switch v-model="dispenseOffline" active-text="断网（先留本中心）" style="float:right" :disabled="role !== 'pharmacist'" />
        </template>
        <el-alert v-if="role !== 'pharmacist'" type="info" :closable="false" show-icon style="margin-bottom:12px"
          title="发药编号与药盒批号由药品管理员负责，当前角色只读" />
        <el-form label-position="top">
          <el-form-item label="随机号（受试者）">
            <el-select v-model="dispenseSequence" style="width:100%" :disabled="role !== 'pharmacist'" placeholder="选择随机号">
              <el-option v-for="p in dispensable" :key="p.sequence" :label="`${p.sequence} · ${p.participantNo} · ${p.site}`" :value="p.sequence" />
            </el-select>
          </el-form-item>
          <el-form-item label="研究中心"><el-input :model-value="selectedSite" readonly placeholder="随随机号带出" /></el-form-item>
          <el-form-item label="药品管理员"><el-input v-model="dispenseActor" :disabled="role !== 'pharmacist'" /></el-form-item>
          <el-button type="primary" style="width:100%" :disabled="role !== 'pharmacist'" @click="submitDispense">
            {{ dispenseOffline ? '暂存本中心离线队列' : '按批号/有效期挑盒发药（近效期先出）' }}
          </el-button>
        </el-form>

        <el-divider content-position="small">断网发药申请队列（恢复后按次序补录）</el-divider>
        <el-empty v-if="trial.pendingDispense.length === 0" description="本中心暂无离线发药申请" :image-size="60" />
        <template v-else>
          <el-table :data="[...trial.pendingDispense].sort((a, b) => a.queueOrder - b.queueOrder)" size="small">
            <el-table-column prop="queueOrder" label="次序" width="55" />
            <el-table-column label="随机号" width="80"><template #default="{ row }">{{ row.payload.sequence }}</template></el-table-column>
            <el-table-column label="受试者" min-width="95"><template #default="{ row }">{{ row.payload.participantNo }}</template></el-table-column>
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'committed' ? 'success' : row.status === 'rejected' ? 'danger' : 'warning'">{{ row.status === 'committed' ? '已补录' : row.status === 'rejected' ? '已退回' : '待补录' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="说明" min-width="160"><template #default="{ row }">{{ row.result ?? '断网暂存，未分配发药编号' }}</template></el-table-column>
          </el-table>
          <el-button type="success" plain style="width:100%;margin-top:10px" :disabled="role !== 'pharmacist' || counts.pendingDispense === 0" @click="flushQueue">
            网络已恢复 — 按次序逐条补录（库存不够即退回并说明）
          </el-button>
        </template>
      </el-card>

      <el-card shadow="never">
        <template #header><b>{{ t('inventory') }}</b><el-tag size="small" style="float:right" type="info">挑选规则：未召回 · 未过期 · 近效期先出</el-tag></template>
        <el-table :data="trial.batchInventory" size="small">
          <el-table-column prop="batchNo" label="批号" min-width="110" />
          <el-table-column prop="expiry" label="有效期" min-width="105" />
          <el-table-column prop="total" label="盒数" width="60" />
          <el-table-column label="可用" width="60">
            <template #default="{ row }">
              <b :style="row.available === 0 ? 'color:#c45656' : ''">{{ row.available }}</b>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag v-if="row.recalled" size="small" type="danger">已召回冻结</el-tag>
              <el-tag v-else-if="row.expiry < '2026-10-02'" size="small" type="warning">已过期</el-tag>
              <el-tag v-else size="small" type="success">在用</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90">
            <template #default="{ row }">
              <el-button v-if="!row.recalled" size="small" type="danger" plain :disabled="role !== 'pharmacist'" @click="recall(row.batchNo)">召回</el-button>
              <span v-else style="color:#909399;font-size:12px">登记于台账</span>
            </template>
          </el-table-column>
        </el-table>
        <el-alert type="info" :closable="false" show-icon style="margin-top:10px"
          title="召回某批号时：一次查出全部在用该批号的受试者，逐人换发近效期合格药盒；库存不足者原单挂起退回待补药；随机分组与揭盲记录不动。" />
      </el-card>
    </div>

    <el-card shadow="never" style="margin-top:20px">
      <template #header><b>{{ t('ledger') }}</b><el-tag size="small" style="margin-left:8px">一随机号一行有效记录</el-tag></template>
      <el-table :data="trial.ledger" size="small" border>
        <el-table-column prop="sequence" label="随机号" width="80" />
        <el-table-column prop="participantNo" label="受试者" min-width="100" />
        <el-table-column prop="site" label="中心" min-width="100" />
        <el-table-column label="治疗组" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.participantStatus === 'unblinded' ? 'danger' : 'info'">
              {{ visibleArm(armBySequence.get(row.sequence)?.arm, row.participantStatus) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="orderNo" label="发药编号" min-width="150">
          <template #default="{ row }">{{ row.orderNo || '—' }}</template>
        </el-table-column>
        <el-table-column prop="boxNo" label="药盒号" min-width="90"><template #default="{ row }">{{ row.boxNo || '—' }}</template></el-table-column>
        <el-table-column prop="batchNo" label="药盒批号" min-width="110"><template #default="{ row }">{{ row.batchNo || '—' }}</template></el-table-column>
        <el-table-column prop="expiry" label="有效期" min-width="100"><template #default="{ row }">{{ row.expiry || '—' }}</template></el-table-column>
        <el-table-column label="对账状态" min-width="110">
          <template #default="{ row }"><el-tag size="small" :type="boxStatusTag(row.boxStatus)">{{ row.boxStatus }}</el-tag></template>
        </el-table-column>
        <el-table-column label="来源/说明" min-width="180">
          <template #default="{ row }">
            <span v-if="row.reason" style="color:#c45656">{{ row.reason }}</span>
            <span v-else-if="row.orderStatus === 'active'">有效发药单</span>
            <span v-else style="color:#909399">未发药</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" style="margin-top:20px">
      <template #header><b>{{ t('orderHistory') }}</b><el-tag size="small" type="warning" style="margin-left:8px">召回换药旧单留痕 exchanged，不删除</el-tag></template>
      <el-table :data="orders" size="small">
        <el-table-column prop="orderNo" label="发药编号" min-width="150" />
        <el-table-column prop="sequence" label="随机号" width="80" />
        <el-table-column prop="participantNo" label="受试者" min-width="95" />
        <el-table-column prop="boxNo" label="药盒号" width="85" />
        <el-table-column prop="batchNo" label="批号" min-width="105" />
        <el-table-column prop="expiry" label="有效期" min-width="95" />
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.status)">
              {{ row.status === 'active' ? '有效' : row.status === 'exchanged' ? '召回换药作废' : row.status === 'awaiting-exchange' ? '待换药/退回' : '已作废' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="110">
          <template #default="{ row }">{{ row.source === 'online' ? '在线发药' : `离线补录(#${row.queueOrder})` }}</template>
        </el-table-column>
        <el-table-column prop="reason" label="备注" min-width="200" />
      </el-table>
    </el-card>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>{{ t('pending') }}</b></template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending">
          <el-table-column prop="payload.participantNo" label="受试者" />
          <el-table-column prop="status" label="状态" />
          <el-table-column label="操作"><template #default="{ row }"><el-button :disabled="row.status !== 'pending'" size="small" type="primary" @click="trial.commitPending(row.id, actor)">确认入库</el-button></template></el-table-column>
        </el-table>
      </el-card>
      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-timeline>
          <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="entry.action === 'unblinded' || entry.action === 'batch-recalled' ? 'danger' : entry.action.startsWith('recall') || entry.action.includes('rejected') || entry.action === 'duplicate-blocked' ? 'warning' : 'primary'">
            <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ maskedAuditDetail(entry) }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 16px; margin-bottom: 20px; }
.section-title { margin: 26px 0 14px; font-size: 20px; display: flex; align-items: center; gap: 10px; }
@media (max-width: 1100px) { .stat-row { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 900px) { section { grid-template-columns: 1fr 1fr !important; } .section-title { flex-direction: column; align-items: flex-start; } }
</style>
