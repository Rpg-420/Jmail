<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import api from '@/api/client';
import type { Email } from '@/api/types';

const router = useRouter();
const route = useRoute();
const drafts = ref<Email[]>([]);
const scheduled = ref<Email[]>([]);
const isLoading = ref(true);

// Set when a send found every relay at quota and was handed to the queue.
const wasQueued = computed(() => route.query.queued === '1');

async function load() {
  isLoading.value = true;
  try {
    const [draftRes, scheduledRes] = await Promise.all([
      api.getEmails({ type: 'draft', limit: 100 }),
      api.getEmails({ type: 'scheduled', limit: 100 }),
    ]);
    drafts.value = draftRes.emails;
    scheduled.value = scheduledRes.emails;
  } finally {
    isLoading.value = false;
  }
}

onMounted(load);

function editDraft(id: string) {
  router.push({ name: 'compose', query: { draft: id } });
}

async function deleteDraft(event: Event, id: string) {
  event.stopPropagation();
  if (!confirm('Delete this draft?')) return;
  await api.deleteEmail(id);
  await load();
}

function formatDate(dateStr: string): string {
  return new Date(dateStr.includes('T') ? dateStr : `${dateStr.replace(' ', 'T')}Z`).toLocaleString();
}

function queueLabel(email: Email): string {
  switch (email.delivery_status) {
    case 'failed':
      return 'Failed';
    case 'deferred':
      return 'Waiting for relay capacity';
    case 'queued':
      return 'Retrying now';
    default:
      return `Sends ${formatDate(email.scheduled_at || email.created_at)}`;
  }
}

function queueTone(email: Email): string {
  if (email.delivery_status === 'failed') return 'bg-danger-soft text-danger';
  if (email.delivery_status === 'queued' || email.delivery_status === 'deferred') return 'bg-warning-soft text-warning';
  return 'bg-accent-soft text-accent';
}
</script>

<template>
  <div class="p-8 max-w-6xl">
    <h1 class="page-title mb-6">Drafts</h1>

    <div v-if="isLoading" class="flex justify-center py-12">
      <div class="spinner"></div>
    </div>

    <template v-else>
      <div v-if="wasQueued" class="alert-success mb-6 flex items-start justify-between gap-3">
        <span>Every sending relay was busy, so JMail keeps retrying this message. It leaves the queue on its own — you don't need to do anything.</span>
        <button class="text-xs underline shrink-0" @click="router.replace({ name: 'drafts' })">Dismiss</button>
      </div>

      <!-- Scheduled queue -->
      <div v-if="scheduled.length > 0" class="card overflow-hidden mb-6">
        <div class="px-6 pt-5 pb-3">
          <h2 class="text-base font-semibold text-ink">Scheduled &amp; queued</h2>
          <p class="text-xs text-ink-3">Sent automatically at the scheduled time, or as soon as a relay has capacity</p>
        </div>
        <ul class="divide-y divide-edge">
          <li
            v-for="email in scheduled"
            :key="email.id"
            class="px-4 py-3.5 hover:bg-surface-2 cursor-pointer transition-colors flex items-center justify-between gap-3"
            @click="editDraft(email.id)"
          >
            <div class="min-w-0">
              <p class="text-sm text-ink truncate">To: {{ email.to_address || '(no recipient)' }}</p>
              <p class="text-sm text-ink-2 truncate">{{ email.subject || '(No Subject)' }}</p>
              <p v-if="email.last_error" class="text-xs text-ink-3 truncate">{{ email.last_error }}</p>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0">
              <span class="badge" :class="queueTone(email)">{{ queueLabel(email) }}</span>
              <button class="text-danger hover:opacity-80 text-sm" @click="(e) => deleteDraft(e, email.id)">Delete</button>
            </div>
          </li>
        </ul>
      </div>

      <!-- Drafts -->
      <div v-if="drafts.length === 0 && scheduled.length === 0" class="card text-center py-16">
        <h3 class="text-sm font-medium text-ink">No drafts</h3>
        <p class="mt-1 text-sm text-ink-3">Drafts you save while composing will appear here.</p>
      </div>

      <div v-else-if="drafts.length > 0" class="card overflow-hidden">
        <ul class="divide-y divide-edge">
          <li
            v-for="email in drafts"
            :key="email.id"
            class="px-4 py-3.5 hover:bg-surface-2 cursor-pointer transition-colors flex items-center justify-between gap-3"
            @click="editDraft(email.id)"
          >
            <div class="min-w-0">
              <p class="text-sm text-ink truncate">To: {{ email.to_address || '(no recipient)' }}</p>
              <p class="text-sm text-ink-2 truncate">{{ email.subject || '(No Subject)' }}</p>
              <p class="text-sm text-ink-3 truncate">{{ email.body_text?.substring(0, 120) || '' }}</p>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0">
              <span v-if="email.delivery_status === 'failed'" class="badge bg-danger-soft text-danger">Send failed</span>
              <p class="text-xs text-ink-3">{{ formatDate(email.created_at) }}</p>
              <button class="text-danger hover:opacity-80 text-sm" @click="(e) => deleteDraft(e, email.id)">Delete</button>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
