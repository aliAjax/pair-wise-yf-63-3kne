<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { DispenseStatus, DrugBox, DispenseOrder, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending, boxes, dispenses, pendingDispenses } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
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
const actorName = computed(() => actor.value ?? '研究者张宁');

const visibleArm = (arm?: 'A' | 'B', status?: string) => {
  if (role.value === 'pharmacist') return arm ?? '待分配';
  if (role.value === 'monitor' && status === 'unblinded') return arm ?? '未知';
  return '已隐藏';
};

/** 角色边界：药品管理员不可见治疗组与揭盲原因，审计中揭盲细节对其脱敏 */
const visibleAudits = computed(() => {
  if (role.value !== 'pharmacist') return audits.value;
  return audits.value.map((entry) =>
    entry.action === 'unblinded'
      ? { ...entry, detail: '紧急揭盲原因与治疗组按角色隐藏（仅研究者/监察员可见）' }
      : entry
  );
});

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
    trial.emergencyUnblind(id, value, actorName.value);
    ElMessage.warning('已揭盲，审计记录已追加');
  } catch {}
};

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount + trial.pendingDispenseCount
}));

// ───────────────────────── 药房：发药 ─────────────────────────
const dispenseOffline = ref(false);
const dispenseForm = ref<{ randomNo: number | undefined; quantity: number }>({ randomNo: undefined, quantity: 1 });
const dispenseResult = ref<{ ok: boolean; message: string } | null>(null);
const submitDispense = () => {
  const { randomNo, quantity } = dispenseForm.value;
  if (!randomNo || !quantity) {
    ElMessage.error('请填写随机号和发药数量');
    return;
  }
  const result = trial.dispense({ randomNo, quantity, actor: actorName.value }, dispenseOffline.value);
  dispenseResult.value = { ok: result.ok, message: result.message };
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.error(result.message);
};

// ───────────────────────── 药房：药盒入库 ─────────────────────────
const boxForm = ref<{ batchNo: string; expiryDate: string; quantity: number }>({ batchNo: '', expiryDate: '', quantity: 10 });
const submitBox = () => {
  if (!boxForm.value.batchNo.trim() || !boxForm.value.expiryDate || boxForm.value.quantity <= 0) {
    ElMessage.error('请填写批号、有效期和数量');
    return;
  }
  trial.addBox({ batchNo: boxForm.value.batchNo.trim(), expiryDate: boxForm.value.expiryDate, quantity: boxForm.value.quantity }, actorName.value);
  ElMessage.success(`药盒 ${boxForm.value.batchNo} 已入库`);
  boxForm.value = { batchNo: '', expiryDate: '', quantity: 10 };
};

// ───────────────────────── 药房：批号召回与换药 ─────────────────────────
const recallBatchNo = ref('');
const recallResult = ref<{ affected: DispenseOrder[]; sealed: DrugBox[] } | null>(null);
const replaceResult = ref<{ replaced: DispenseOrder[]; failed: { randomNo: number; reason: string }[] } | null>(null);
const doRecall = () => {
  const batchNo = recallBatchNo.value.trim();
  if (!batchNo) {
    ElMessage.error('请填写召回药盒批号');
    return;
  }
  recallResult.value = trial.recallBatch(batchNo, actorName.value);
  replaceResult.value = null;
  ElMessage.warning(`批号 ${batchNo} 已召回：封存 ${recallResult.value.sealed.length} 盒，查到 ${recallResult.value.affected.length} 名受试者需换药`);
};
const doReplace = () => {
  const batchNo = recallBatchNo.value.trim();
  if (!batchNo) return;
  replaceResult.value = trial.replaceForRecall(batchNo, actorName.value);
  const { replaced, failed } = replaceResult.value;
  if (replaced.length) ElMessage.success(`已换药 ${replaced.length} 人，分组与揭盲记录未改动`);
  if (failed.length) ElMessage.error(`${failed.length} 人换药退回：${failed.map((item) => `随机号 ${item.randomNo}`).join('、')}，库存不足已说明`);
};

// ───────────────────────── 台账对账 ─────────────────────────
const ledgerFilter = ref<DispenseStatus | 'all'>('all');
const ledger = computed(() => dispenses.value.filter((item) => ledgerFilter.value === 'all' || item.status === ledgerFilter.value));
const statusTag = (status: DispenseStatus) => (status === 'valid' ? 'success' : status === 'replaced' ? 'warning' : 'info');
const statusLabel = (status: DispenseStatus) => (status === 'valid' ? '有效' : status === 'replaced' ? '已换药' : '已作废');

/** 断网补录按次序（FIFO）：仅队列中最靠前的申请可确认入库 */
const isOldestPending = (id: string) => {
  const first = pendingDispenses.value.find((item) => item.status === 'pending');
  return first?.id === id;
};
</script>

<template>
  <main class="page">
    <header class="hero">
      <div><el-tag type="success">GCP 本地原型</el-tag><h1>{{ t('title') }}</h1><p>{{ t('subtitle') }}</p></div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]" />
    </header>

    <section style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待提交</span><b>{{ counts.pending }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header><b>{{ t('randomize') }}</b><el-switch v-model="offline" active-text="模拟离线" style="float:right" /></template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site"><el-select v-model="site" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
          <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-003" /></el-form-item>
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
          <el-table-column prop="site" label="中心" min-width="110" />
          <el-table-column prop="sequence" label="随机号" width="90" />
          <el-table-column label="治疗组" width="100"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="100"><template #default="{ row }"><el-button v-if="role === 'investigator'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button></template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <!-- 药房工作台：仅药品管理员；凭随机号发药、按批号/有效期挑药盒、召回换药 -->
    <el-card v-if="role === 'pharmacist'" shadow="never" style="margin-top:20px">
      <template #header>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b>{{ t('pharmacy') }}</b>
          <span>
            <el-tag type="success" style="margin-right:8px">有效发药单 {{ trial.validDispenseCount }}</el-tag>
            <el-tag type="warning" style="margin-right:8px">在库药盒 {{ trial.inStockBoxCount }}</el-tag>
            <el-tag v-if="trial.pendingDispenseCount" type="danger">待补录 {{ trial.pendingDispenseCount }}</el-tag>
          </span>
        </div>
      </template>
      <el-tabs>
        <el-tab-pane :label="t('dispenseTab')">
          <el-alert type="info" :closable="false" style="margin-bottom:12px">药房凭随机号发药：系统按批号与有效期（近效期先出）自动挑药盒，库存不足将退回并说明。</el-alert>
          <el-form label-position="top" inline>
            <el-form-item label="随机号"><el-input-number v-model="dispenseForm.randomNo" :min="1001" controls-position="right" placeholder="如 1003" style="width:160px" /></el-form-item>
            <el-form-item label="发药数量"><el-input-number v-model="dispenseForm.quantity" :min="1" controls-position="right" style="width:140px" /></el-form-item>
            <el-form-item label=" "><el-button type="primary" @click="submitDispense">发药</el-button></el-form-item>
            <el-form-item label=" "><el-switch v-model="dispenseOffline" active-text="模拟断网（申请留本中心）" /></el-form-item>
          </el-form>
          <el-alert v-if="dispenseResult" :type="dispenseResult.ok ? 'success' : 'error'" :closable="false" style="margin-top:8px">{{ dispenseResult.message }}</el-alert>
        </el-tab-pane>

        <el-tab-pane :label="t('boxesTab')">
          <el-form label-position="top" inline>
            <el-form-item label="药盒批号"><el-input v-model="boxForm.batchNo" placeholder="如 B2026-04" style="width:160px" /></el-form-item>
            <el-form-item label="有效期"><el-date-picker v-model="boxForm.expiryDate" type="date" value-format="YYYY-MM-DD" placeholder="选择有效期" style="width:170px" /></el-form-item>
            <el-form-item label="入库数量"><el-input-number v-model="boxForm.quantity" :min="1" controls-position="right" style="width:130px" /></el-form-item>
            <el-form-item label=" "><el-button type="primary" @click="submitBox">药盒入库</el-button></el-form-item>
          </el-form>
          <el-table :data="boxes" size="small" max-height="320" style="margin-top:8px">
            <el-table-column prop="batchNo" label="药盒批号" min-width="120" />
            <el-table-column prop="expiryDate" label="有效期" width="130">
              <template #default="{ row }"><span :style="row.status === 'in-stock' && row.expiryDate < new Date().toISOString().slice(0, 10) ? 'color:#e6a23c;font-weight:600' : ''">{{ row.expiryDate }}</span></template>
            </el-table-column>
            <el-table-column prop="quantity" label="数量" width="90" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }"><el-tag :type="row.status === 'in-stock' ? 'success' : row.status === 'recalled' ? 'danger' : 'info'">{{ row.status === 'in-stock' ? '在库' : row.status === 'recalled' ? '已召回封存' : '已发完' }}</el-tag></template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane :label="t('recallTab')">
          <el-alert type="warning" :closable="false" style="margin-bottom:12px">一批药盒被召回：输入批号一次查出所有已发药受试者并换药；库存不足的退回并说明，分组与揭盲记录不动。</el-alert>
          <el-form label-position="top" inline>
            <el-form-item label="召回批号"><el-input v-model="recallBatchNo" placeholder="如 B2025-11" style="width:180px" /></el-form-item>
            <el-form-item label=" "><el-button type="danger" @click="doRecall">召回并查人</el-button></el-form-item>
            <el-form-item v-if="recallResult && recallResult.affected.length" label=" ">
              <el-button type="primary" @click="doReplace">一键为 {{ recallResult.affected.length }} 人换药</el-button>
            </el-form-item>
          </el-form>
          <el-table v-if="recallResult" :data="recallResult.affected" size="small" max-height="260" style="margin-top:8px">
            <el-table-column prop="randomNo" label="随机号" width="100" />
            <el-table-column prop="participantNo" label="受试者" min-width="110" />
            <el-table-column label="已发药批号" min-width="160">
              <template #default="{ row }"><el-tag v-for="item in row.items" :key="item.boxId" size="small" type="danger" style="margin-right:4px">{{ item.batchNo }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="totalQuantity" label="数量" width="80" />
          </el-table>
          <el-alert v-if="replaceResult && replaceResult.failed.length" type="error" :closable="false" style="margin-top:8px">
            换药退回：{{ replaceResult.failed.map((item) => `随机号 ${item.randomNo}（${item.reason}）`).join('；') }}
          </el-alert>
          <el-alert v-if="replaceResult && replaceResult.replaced.length" type="success" :closable="false" style="margin-top:8px">
            已完成换药 {{ replaceResult.replaced.length }} 人，原单作废、新单生效，治疗分组与揭盲记录均未改动。
          </el-alert>
        </el-tab-pane>

        <el-tab-pane :label="t('dispenseQueueTab')">
          <el-alert type="info" :closable="false" style="margin-bottom:12px">断网时发药申请先留本中心，恢复后按次序（FIFO）补录；仅队列最靠前的申请可确认入库。</el-alert>
          <el-empty v-if="pendingDispenses.length === 0" description="暂无待补录发药申请" />
          <el-table v-else :data="pendingDispenses" size="small">
            <el-table-column prop="payload.randomNo" label="随机号" width="100" />
            <el-table-column prop="payload.quantity" label="数量" width="80" />
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag v-if="row.status === 'committed'" :type="row.result === 'ok' ? 'success' : 'danger'">{{ row.result === 'ok' ? '已补录' : '已退回' }}</el-tag>
                <el-tag v-else type="warning">待补录</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="message" label="补录说明" min-width="200" />
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button :disabled="row.status !== 'pending' || !isOldestPending(row.id)" size="small" type="primary" @click="trial.commitPendingDispense(row.id, actorName)">确认入库</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 台账对账：随机号 + 发药单 + 药盒批号合并，药品管理员与监察员可见 -->
    <el-card v-if="role === 'pharmacist' || role === 'monitor'" shadow="never" style="margin-top:20px">
      <template #header>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b>{{ t('ledger') }}</b>
          <el-radio-group v-model="ledgerFilter" size="small">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="valid">有效</el-radio-button>
            <el-radio-button value="replaced">已换药</el-radio-button>
            <el-radio-button value="void">已作废</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <el-empty v-if="ledger.length === 0" description="暂无发药记录" />
      <el-table v-else :data="ledger" size="small" max-height="420">
        <el-table-column prop="dispenseNo" label="发药编号" width="110" />
        <el-table-column prop="randomNo" label="随机号" width="90" />
        <el-table-column prop="participantNo" label="受试者" min-width="110" />
        <el-table-column prop="site" label="中心" min-width="100" />
        <el-table-column label="药盒批号" min-width="180">
          <template #default="{ row }">
            <el-tooltip v-for="item in row.items" :key="item.boxId" :content="`有效期 ${item.expiryDate}，${item.quantity} 盒`" placement="top">
              <el-tag size="small" effect="plain" style="margin-right:4px">{{ item.batchNo }} ×{{ item.quantity }}</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="totalQuantity" label="数量" width="70" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }"><el-tag :type="statusTag(row.status)">{{ statusLabel(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="reason" label="说明" min-width="160" show-overflow-tooltip />
        <el-table-column label="发药时间" width="170">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>{{ t('pending') }}</b></template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending">
          <el-table-column prop="payload.participantNo" label="受试者" />
          <el-table-column prop="status" label="状态" />
          <el-table-column label="操作"><template #default="{ row }"><el-button :disabled="row.status !== 'pending'" size="small" type="primary" @click="trial.commitPending(row.id, actorName)">确认入库</el-button></template></el-table-column>
        </el-table>
      </el-card>
      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-timeline>
          <el-timeline-item v-for="entry in visibleAudits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="entry.action === 'unblinded' ? 'danger' : entry.action === 'duplicate-blocked' || entry.action === 'dispense-rejected' ? 'warning' : 'primary'">
            <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ entry.detail }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: 1fr 1fr !important; } }
</style>
