<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import api from '@/api/client';
import type { ApiToken, ProviderInfo, WebhookDeliveryInfo, WebhookEndpointInfo } from '@/api/types';

type Tab = 'relays' | 'tokens' | 'hooks';

const activeTab = ref<Tab>('relays');
const isLoading = ref(true);
const isSaving = ref(false);
const error = ref('');
const success = ref('');

function clearAlerts() {
  error.value = '';
  success.value = '';
}

// ---------- Relays ----------
const providers = ref<ProviderInfo[]>([]);
const remainingToday = ref(0);
const queue = ref<Record<string, number>>({});
const providerKeys = ref<Record<string, string>>({});
const providerQuota = ref<Record<string, { day: string; month: string }>>({});

async function loadProviders() {
  const data = await api.getProviders();
  providers.value = data.providers;
  remainingToday.value = data.total_remaining_today;
  queue.value = data.queue ?? {};
  providerQuota.value = Object.fromEntries(
    data.providers.map(p => [p.id, {
      day: p.quota_day ? String(p.quota_day) : '',
      month: p.quota_month ? String(p.quota_month) : '',
    }])
  );
}

async function saveRelay(provider: ProviderInfo) {
  clearAlerts();
  isSaving.value = true;
  try {
    const key = providerKeys.value[provider.id]?.trim();
    if (key !== undefined && key !== '') {
      await api.saveProviderKey(provider.id, key);
      providerKeys.value[provider.id] = '';
      success.value = `${provider.label} verified and saved.`;
    }
    const quota = providerQuota.value[provider.id];
    if (quota) {
      await api.saveProviderQuota(provider.id, {
        day: quota.day ? Number(quota.day) : null,
        month: quota.month ? Number(quota.month) : null,
      });
    }
    await loadProviders();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not save the relay.';
  } finally {
    isSaving.value = false;
  }
}

async function removeRelay(provider: ProviderInfo) {
  if (!confirm(`Remove the ${provider.label} key? Mail will fall back to the other relays.`)) return;
  clearAlerts();
  try {
    await api.saveProviderKey(provider.id, '');
    await loadProviders();
    success.value = `${provider.label} removed.`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not remove the relay.';
  }
}

async function moveProvider(index: number, direction: -1 | 1) {
  const order = providers.value.map(p => p.id);
  const target = index + direction;
  if (target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  clearAlerts();
  try {
    await api.saveProviderOrder(order);
    await loadProviders();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not reorder the relays.';
  }
}

// ---------- API tokens ----------
const tokens = ref<ApiToken[]>([]);
const newTokenName = ref('');
const newTokenIdentity = ref('');
const newTokenScopes = ref<string[]>(['send', 'status']);
const newTokenBudget = ref('200');
const createdSecret = ref('');

async function loadTokens() {
  tokens.value = (await api.getApiTokens()).tokens;
}

async function createToken() {
  clearAlerts();
  if (!newTokenName.value.trim()) {
    error.value = 'Give the token a name so you recognise it later.';
    return;
  }
  isSaving.value = true;
  try {
    const result = await api.createApiToken({
      name: newTokenName.value.trim(),
      scopes: newTokenScopes.value,
      identity_address: newTokenIdentity.value.trim() || null,
      daily_budget: Number(newTokenBudget.value) || 200,
    });
    createdSecret.value = result.secret;
    newTokenName.value = '';
    newTokenIdentity.value = '';
    await loadTokens();
    success.value = result.warning;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not create the token.';
  } finally {
    isSaving.value = false;
  }
}

async function revokeToken(token: ApiToken) {
  if (!confirm(`Revoke “${token.name}”? Projects using it will start failing with 401.`)) return;
  clearAlerts();
  try {
    await api.revokeApiToken(token.id);
    await loadTokens();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not revoke the token.';
  }
}

async function copySecret() {
  try {
    await navigator.clipboard.writeText(createdSecret.value);
    success.value = 'Copied to the clipboard.';
  } catch {
    error.value = 'Copy failed — select the text and copy it manually.';
  }
}

// ---------- Webhooks ----------
const hooks = ref<WebhookEndpointInfo[]>([]);
const hookEvents = ref<string[]>([]);
const newHookUrl = ref('');
const newHookEvents = ref<string[]>(['delivered', 'failed']);
const newHookToken = ref('');
const hookSecret = ref('');
const deliveriesFor = ref('');
const deliveries = ref<WebhookDeliveryInfo[]>([]);
const isTesting = ref('');

async function loadHooks() {
  const data = await api.getWebhooks();
  hooks.value = data.endpoints;
  hookEvents.value = data.events;
}

async function createHook() {
  clearAlerts();
  if (!newHookUrl.value.trim().startsWith('http')) {
    error.value = 'Enter the full https:// URL of your project’s endpoint.';
    return;
  }
  isSaving.value = true;
  try {
    const result = await api.createWebhook({
      url: newHookUrl.value.trim(),
      events: newHookEvents.value,
      token_id: newHookToken.value || null,
    });
    hookSecret.value = result.endpoint.secret;
    newHookUrl.value = '';
    await loadHooks();
    success.value = result.warning;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not create the webhook.';
  } finally {
    isSaving.value = false;
  }
}

async function toggleHook(hook: WebhookEndpointInfo) {
  clearAlerts();
  try {
    await api.updateWebhook(hook.id, { active: !hook.active });
    await loadHooks();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not update the webhook.';
  }
}

async function deleteHook(hook: WebhookEndpointInfo) {
  if (!confirm('Delete this webhook endpoint?')) return;
  clearAlerts();
  try {
    await api.deleteWebhook(hook.id);
    await loadHooks();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not delete the webhook.';
  }
}

async function testHook(hook: WebhookEndpointInfo) {
  clearAlerts();
  isTesting.value = hook.id;
  try {
    const result = await api.testWebhook(hook.id);
    if (result.success) {
      success.value = 'Your endpoint accepted the test event and the signature verified.';
    } else {
      error.value = `Test ${result.status}: ${result.last_error || 'your endpoint did not return 2xx'}`;
    }
    await loadHooks();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Webhook test failed.';
  } finally {
    isTesting.value = '';
  }
}

async function showDeliveries(hook: WebhookEndpointInfo) {
  clearAlerts();
  deliveriesFor.value = hook.url;
  try {
    deliveries.value = (await api.getWebhookDeliveries(hook.id)).deliveries;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load deliveries.';
  }
}

// ---------- Quickstart ----------
const apiBase = computed(() => `${window.location.origin}/api/v1`);
const curlSnippet = computed(() => `curl -X POST ${apiBase.value}/send \\
  -H "Authorization: Bearer $JMAIL_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "friend@example.com",
    "from": "you@yourdomain.com",
    "subject": "Hello from JMail",
    "text": "Your project sent this on its own."
  }'`);

const nodeSnippet = computed(() => `const response = await fetch('${apiBase.value}/send', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.JMAIL_TOKEN}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: 'friend@example.com',
    subject: 'Welcome',
    html: '<h1>Welcome!</h1>',
    text: 'Welcome!',
    idempotency_key: crypto.randomUUID(),
  }),
});
const message = await response.json();
console.log(message.status, message.provider);`);

async function copySnippet(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    success.value = 'Snippet copied.';
  } catch {
    error.value = 'Copy failed — select the text and copy it manually.';
  }
}

onMounted(async () => {
  try {
    await Promise.all([loadProviders(), loadTokens(), loadHooks()]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load mail server settings.';
  } finally {
    isLoading.value = false;
  }
});
</script>

<template>
  <div class="p-8 max-w-4xl">
    <h1 class="page-title">Your mail server.</h1>
    <p class="text-sm text-ink-2 mt-2 mb-8">
      Free relays, project tokens, and signed webhooks — everything another application needs to send and receive through your domain.
    </p>

    <div v-if="isLoading" class="flex justify-center py-12"><div class="spinner"></div></div>

    <template v-else>
      <div v-if="error" role="alert" class="alert-error mb-6">{{ error }}</div>
      <div v-if="success" role="status" class="alert-success mb-6">{{ success }}</div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div class="card p-4">
          <p class="text-xs uppercase tracking-wide text-ink-3">Capacity today</p>
          <p class="text-2xl font-semibold tabular-nums mt-1">{{ remainingToday }}</p>
          <p class="hint">sends left across relays</p>
        </div>
        <div class="card p-4">
          <p class="text-xs uppercase tracking-wide text-ink-3">Queued</p>
          <p class="text-2xl font-semibold tabular-nums mt-1">{{ (queue.queued ?? 0) + (queue.deferred ?? 0) }}</p>
          <p class="hint">waiting for a relay</p>
        </div>
        <div class="card p-4">
          <p class="text-xs uppercase tracking-wide text-ink-3">Failed</p>
          <p class="text-2xl font-semibold tabular-nums mt-1">{{ queue.failed ?? 0 }}</p>
          <p class="hint">rejected by every relay</p>
        </div>
        <div class="card p-4">
          <p class="text-xs uppercase tracking-wide text-ink-3">Tokens</p>
          <p class="text-2xl font-semibold tabular-nums mt-1">{{ tokens.filter(t => !t.revoked_at).length }}</p>
          <p class="hint">active project keys</p>
        </div>
      </div>

      <div class="border-b border-edge mb-6">
        <nav aria-label="Mail server sections" class="-mb-px flex gap-6 overflow-x-auto">
          <button
            v-for="tab in (['relays', 'tokens', 'hooks'] as const)"
            :key="tab"
            class="py-3 px-1 border-b-2 font-medium text-sm capitalize transition-colors"
            :class="activeTab === tab ? 'border-accent text-accent' : 'border-transparent text-ink-3 hover:text-ink-2'"
            :aria-pressed="activeTab === tab"
            @click="activeTab = tab; clearAlerts()"
          >
            {{ tab === 'relays' ? 'Sending relays' : tab === 'tokens' ? 'Project tokens' : 'Webhooks' }}
          </button>
        </nav>
      </div>

      <!-- ============ Relays ============ -->
      <div v-if="activeTab === 'relays'" class="space-y-6">
        <p class="hint">
          Cloudflare Workers cannot open SMTP ports, and outbound mail on the free plan is not available, so JMail sends through
          HTTPS relays. Each free tier is small on its own — pooled with automatic failover they add up, and mail that finds every
          relay at quota stays queued instead of being lost.
        </p>

        <div v-for="(provider, index) in providers" :key="provider.id" class="card p-6">
          <div class="connection-heading">
            <div class="telegram-mark flex items-center justify-center font-semibold text-accent" aria-hidden="true">
              {{ provider.label.slice(0, 1) }}
            </div>
            <div class="flex-1">
              <h2 class="text-lg font-semibold">{{ provider.label }}</h2>
              <p class="text-sm text-ink-2 mt-1">
                <span :class="provider.configured ? 'text-success' : 'text-ink-3'">
                  {{ provider.configured ? 'Connected' : 'Not configured' }}
                </span>
                <span v-if="provider.configured && provider.remaining_day !== null"> · {{ provider.remaining_day }} left today ({{ provider.used_day }} used)</span>
                <span v-if="provider.configured && provider.remaining_day === null"> · unlimited today</span>
              </p>
            </div>
            <div class="flex gap-1">
              <button class="btn-icon" :disabled="index === 0" title="Try this relay earlier" @click="moveProvider(index, -1)">↑</button>
              <button class="btn-icon" :disabled="index === providers.length - 1" title="Try this relay later" @click="moveProvider(index, 1)">↓</button>
            </div>
          </div>

          <form class="mt-5 space-y-4" @submit.prevent="saveRelay(provider)">
            <div>
              <label :for="`key-${provider.id}`" class="label">API key</label>
              <input
                :id="`key-${provider.id}`"
                v-model="providerKeys[provider.id]"
                type="password"
                autocomplete="off"
                spellcheck="false"
                class="input"
                :placeholder="provider.configured ? 'Saved · paste a new key to replace it' : 'Paste the relay API key'"
              />
              <p class="hint">Verified against the relay before saving, then stored on the server and never returned to your browser.</p>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label :for="`day-${provider.id}`" class="label">Daily cap</label>
                <input :id="`day-${provider.id}`" v-model="providerQuota[provider.id].day" type="text" inputmode="numeric" class="input" :placeholder="`default ${provider.quota_day ?? '—'}`" />
              </div>
              <div>
                <label :for="`month-${provider.id}`" class="label">Monthly cap</label>
                <input :id="`month-${provider.id}`" v-model="providerQuota[provider.id].month" type="text" inputmode="numeric" class="input" placeholder="optional" />
              </div>
            </div>
            <p class="hint">
              Max {{ provider.max_recipients }} recipients and {{ provider.max_message_mb }}MB per message on this relay —
              JMail routes around those limits instead of getting a rejection.
            </p>
            <div class="flex flex-wrap gap-3">
              <button class="btn btn-primary" type="submit" :disabled="isSaving">{{ isSaving ? 'Saving…' : 'Save' }}</button>
              <button v-if="provider.configured" class="btn btn-ghost" type="button" @click="removeRelay(provider)">Remove key</button>
            </div>
          </form>
        </div>
      </div>

      <!-- ============ Tokens ============ -->
      <div v-else-if="activeTab === 'tokens'" class="space-y-6">
        <div v-if="createdSecret" class="card p-5 border-accent">
          <p class="label mb-2">New token — copy it now, it is shown once</p>
          <div class="flex gap-2">
            <code class="input flex-1 font-mono text-xs select-all">{{ createdSecret }}</code>
            <button class="btn btn-ghost" @click="copySecret">Copy</button>
          </div>
        </div>

        <form class="card p-6 space-y-4" @submit.prevent="createToken">
          <h2 class="text-lg font-semibold">Add a project</h2>
          <div class="grid md:grid-cols-2 gap-4">
            <div>
              <label for="token-name" class="label">Project name</label>
              <input id="token-name" v-model="newTokenName" class="input" placeholder="billing-app" autocomplete="off" />
            </div>
            <div>
              <label for="token-identity" class="label">Pinned From address (optional)</label>
              <input id="token-identity" v-model="newTokenIdentity" class="input" placeholder="alerts@yourdomain.com" autocomplete="off" />
              <p class="hint">When set, this token can only ever send as that address.</p>
            </div>
          </div>
          <div>
            <span class="label">Scopes</span>
            <div class="flex flex-wrap gap-4 mt-1">
              <label v-for="scope in (['send', 'read', 'status'] as const)" :key="scope" class="flex items-center gap-2 text-sm">
                <input v-model="newTokenScopes" type="checkbox" :value="scope" class="h-4 w-4 accent-[var(--c-accent)]" />
                <span>{{ scope }}</span>
              </label>
            </div>
            <p class="hint">send = POST /v1/send · read = read inbound mail · status = /v1/quota</p>
          </div>
          <div class="max-w-xs">
            <label for="token-budget" class="label">Daily budget</label>
            <input id="token-budget" v-model="newTokenBudget" type="text" inputmode="numeric" class="input" />
            <p class="hint">Per project, independent of relay quota. Keeps one runaway cron out of your free tier.</p>
          </div>
          <button class="btn btn-primary" type="submit" :disabled="isSaving || newTokenScopes.length === 0">
            {{ isSaving ? 'Creating…' : 'Create token' }}
          </button>
        </form>

        <div class="card overflow-hidden">
          <table class="min-w-full divide-y divide-edge text-sm">
            <thead class="bg-surface-2 text-left">
              <tr>
                <th class="px-4 py-3 font-medium">Project</th>
                <th class="px-4 py-3 font-medium">Scopes</th>
                <th class="px-4 py-3 font-medium text-right">Today</th>
                <th class="px-4 py-3 font-medium">Last used</th>
                <th class="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-edge">
              <tr v-for="token in tokens" :key="token.id" :class="token.revoked_at ? 'opacity-50' : ''">
                <td class="px-4 py-3">
                  <span class="font-medium">{{ token.name }}</span>
                  <span class="block font-mono text-xs text-ink-3">{{ token.prefix }}…</span>
                  <span v-if="token.identity_address" class="block text-xs text-ink-3">as {{ token.identity_address }}</span>
                </td>
                <td class="px-4 py-3">
                  <span v-for="scope in token.scopes" :key="scope" class="badge mr-1">{{ scope }}</span>
                </td>
                <td class="px-4 py-3 text-right tabular-nums">{{ token.sent_today }}/{{ token.daily_budget }}</td>
                <td class="px-4 py-3 text-ink-2">{{ token.last_used_at ? new Date(token.last_used_at).toLocaleString() : 'never' }}</td>
                <td class="px-4 py-3 text-right">
                  <button v-if="!token.revoked_at" class="btn btn-ghost text-xs" @click="revokeToken(token)">Revoke</button>
                  <span v-else class="text-xs text-ink-3">revoked</span>
                </td>
              </tr>
              <tr v-if="tokens.length === 0">
                <td colspan="5" class="px-4 py-6 text-center text-ink-3">No project tokens yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ============ Webhooks ============ -->
      <div v-else class="space-y-6">
        <p class="hint">
          Your projects learn what happened to their mail without polling. Every delivery is signed
          (<code class="font-mono">X-JMail-Signature: t=…,v1=…</code>) with a per-endpoint secret.
        </p>

        <div v-if="hookSecret" class="card p-5 border-accent">
          <p class="label mb-2">Endpoint secret — copy it now, it is shown once</p>
          <div class="flex gap-2">
            <code class="input flex-1 font-mono text-xs select-all">{{ hookSecret }}</code>
            <button class="btn btn-ghost" @click="copySecret">Copy</button>
          </div>
        </div>

        <form class="card p-6 space-y-4" @submit.prevent="createHook">
          <h2 class="text-lg font-semibold">Receive events</h2>
          <div>
            <label for="hook-url" class="label">Endpoint URL</label>
            <input id="hook-url" v-model="newHookUrl" class="input" placeholder="https://yourapp.com/webhooks/jmail" autocomplete="off" />
            <p class="hint">Must be publicly reachable — private and loopback addresses are rejected.</p>
          </div>
          <div>
            <span class="label">Events</span>
            <div class="flex flex-wrap gap-4 mt-1">
              <label v-for="event in hookEvents" :key="event" class="flex items-center gap-2 text-sm">
                <input v-model="newHookEvents" type="checkbox" :value="event" class="h-4 w-4 accent-[var(--c-accent)]" />
                <span>{{ event }}</span>
              </label>
            </div>
          </div>
          <div class="max-w-xs">
            <label for="hook-token" class="label">Restrict to one project (optional)</label>
            <select id="hook-token" v-model="newHookToken" class="input">
              <option value="">All mail</option>
              <option v-for="token in tokens.filter(t => !t.revoked_at)" :key="token.id" :value="token.id">{{ token.name }}</option>
            </select>
          </div>
          <button class="btn btn-primary" type="submit" :disabled="isSaving || newHookEvents.length === 0">
            {{ isSaving ? 'Creating…' : 'Create endpoint' }}
          </button>
        </form>

        <div class="space-y-3">
          <div v-for="hook in hooks" :key="hook.id" class="card p-5">
            <div class="flex flex-wrap items-start gap-3">
              <div class="flex-1 min-w-0">
                <p class="font-medium truncate">{{ hook.url }}</p>
                <p class="text-xs text-ink-3 mt-1">
                  {{ hook.events.join(' · ') }}
                  <span v-if="!hook.active" class="text-ink-3"> · paused</span>
                </p>
              </div>
              <div class="flex gap-2">
                <button class="btn btn-ghost text-xs" :disabled="isTesting === hook.id" @click="testHook(hook)">
                  {{ isTesting === hook.id ? 'Testing…' : 'Send test' }}
                </button>
                <button class="btn btn-ghost text-xs" @click="toggleHook(hook)">{{ hook.active ? 'Pause' : 'Resume' }}</button>
                <button class="btn btn-ghost text-xs" @click="showDeliveries(hook)">Deliveries</button>
                <button class="btn btn-ghost text-xs" @click="deleteHook(hook)">Delete</button>
              </div>
            </div>
          </div>
          <p v-if="hooks.length === 0" class="card p-6 text-center text-ink-3">No webhook endpoints yet.</p>
        </div>

        <div v-if="deliveriesFor" class="card overflow-hidden">
          <p class="px-4 py-3 text-sm font-medium border-b border-edge">Recent deliveries to {{ deliveriesFor }}</p>
          <table class="min-w-full divide-y divide-edge text-sm">
            <tbody class="divide-y divide-edge">
              <tr v-for="delivery in deliveries" :key="delivery.id">
                <td class="px-4 py-2">{{ delivery.event }}</td>
                <td class="px-4 py-2">
                  <span class="badge" :class="delivery.status === 'delivered' ? 'text-success' : delivery.status === 'failed' ? 'text-danger' : ''">
                    {{ delivery.status }}
                  </span>
                </td>
                <td class="px-4 py-2 tabular-nums text-ink-2">{{ delivery.attempts }}×</td>
                <td class="px-4 py-2 text-ink-3">{{ delivery.last_error || '' }}</td>
                <td class="px-4 py-2 text-right text-xs text-ink-3">{{ new Date(delivery.created_at).toLocaleString() }}</td>
              </tr>
              <tr v-if="deliveries.length === 0"><td class="px-4 py-4 text-center text-ink-3">Nothing queued yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ============ Quickstart ============ -->
      <div class="card p-6 mt-8">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-lg font-semibold">Connect a project</h2>
            <p class="text-sm text-ink-2 mt-1">
              Base URL <code class="font-mono text-xs">{{ apiBase }}</code> — create a token above, then paste this in your app’s environment.
            </p>
            <p class="hint mt-1"><code class="font-mono">JMAIL_TOKEN</code> · <code class="font-mono">JMAIL_API_URL={{ apiBase }}</code></p>
          </div>
        </div>
        <div class="grid md:grid-cols-2 gap-4 mt-4">
          <div>
            <p class="label mb-2">curl</p>
            <pre class="bg-surface-2 rounded-lg p-4 text-xs overflow-auto"><code>{{ curlSnippet }}</code></pre>
            <button class="btn btn-ghost text-xs mt-2" @click="copySnippet(curlSnippet)">Copy</button>
          </div>
          <div>
            <p class="label mb-2">Node.js</p>
            <pre class="bg-surface-2 rounded-lg p-4 text-xs overflow-auto"><code>{{ nodeSnippet }}</code></pre>
            <button class="btn btn-ghost text-xs mt-2" @click="copySnippet(nodeSnippet)">Copy</button>
          </div>
        </div>
        <p class="hint mt-4">
          Full reference: <code class="font-mono">/docs/API.md</code> in the repository — send, receive, webhooks, rate limits, and SPF/DKIM/DMARC setup.
        </p>
      </div>
    </template>
  </div>
</template>
