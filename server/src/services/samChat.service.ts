/**
 * SAM -- the in-product support assistant.
 *
 * The service is deliberately separate from the clinical AI service
 * (gemini.service.ts): that one reasons about patient data, this one answers
 * questions about the platform itself and is therefore deliberately kept away
 * from anything that identifies a person.
 *
 * Four rules shape the module:
 *  1. The model never sees account data. The system prompt says so, the
 *     sanitiser removes anything that looks like an instruction to override
 *     it, and the sanitiser on the way out removes anything that looks like a
 *     secret the model might have produced.
 *  2. Every provider goes through one adapter shape, so a new provider is a
 *     new entry in a table rather than a new branch in the request path.
 *  3. A missing key produces a clearly labelled placeholder rather than an
 *     error, so the chat surface shows the degraded state instead of a dead
 *     panel. This mirrors the contract of the clinical AI service.
 *  4. A request that needs a person is escalated, never answered. The
 *     escalation is detected on the server as well as asked for in the
 *     prompt, because the prompt is an instruction and the detection is the
 *     guarantee.
 */
import pool from '../config/database.js';
import { APP_NAME } from '../config/app.js';
import { isConfigured } from '../config/env.js';

export type SamProviderName = 'openrouter' | 'gemini' | 'groq' | 'openai' | 'anthropic';

export interface SamChatResponse {
  text: string;
  modelUsed: string;
  /** True when the answer was produced by this server rather than by a model. */
  simulated: boolean;
  provider: string;
  /** True when the question has to be answered by a person. */
  escalate: boolean;
  escalateReason?: string;
}

/** The provider used when nothing has been configured. */
export const DEFAULT_PROVIDER: SamProviderName = 'openrouter';

/** The model used when nothing has been configured. */
export const DEFAULT_MODEL = 'google/gemma-4-31b-it:free';

/**
 * The environment variable that holds each provider's key.
 *
 * The key itself is never read from the settings table: an operator can
 * choose which provider to talk to, but only the deployment can decide which
 * credentials exist.
 */
export const PROVIDER_ENV_KEYS: Record<SamProviderName, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export interface SamProviderDescriptor {
  label: string;
  defaultModel: string;
  models: string[];
  envKey: string;
  endpoint: string;
  modelsEndpoint?: string;
}

/**
 * The providers the assistant can talk to.
 *
 * The model lists are the ones the deployment is expected to offer. OpenRouter
 * publishes more, and the live list is fetched when it is reachable, but the
 * curated list is what the settings screen validates against, so a typo
 * cannot be stored.
 */
export const SAM_PROVIDERS: Record<SamProviderName, SamProviderDescriptor> = {
  openrouter: {
    label: 'OpenRouter',
    defaultModel: 'google/gemma-4-31b-it:free',
    // The curated list is a fallback for when the live catalogue cannot be
    // read. It is refreshed against the catalogue periodically: OpenRouter
    // withdraws free models, and a list that names a withdrawn model is a
    // list that cannot answer anything.
    models: [
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
      'nvidia/nemotron-3.5-lightning:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'nvidia/nemotron-3.5-super-vl:free',
      'liquid/lfm-3-1.7b:free',
    ],
    envKey: PROVIDER_ENV_KEYS.openrouter,
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    modelsEndpoint: 'https://openrouter.ai/api/v1/models',
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    envKey: PROVIDER_ENV_KEYS.gemini,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}',
  },
  groq: {
    label: 'Groq',
    defaultModel: 'llama-3.1-8b-instant',
    models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
    envKey: PROVIDER_ENV_KEYS.groq,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini'],
    envKey: PROVIDER_ENV_KEYS.openai,
    endpoint: 'https://api.openai.com/v1/chat/completions',
  },
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
    envKey: PROVIDER_ENV_KEYS.anthropic,
    endpoint: 'https://api.anthropic.com/v1/messages',
  },
};

/** The reasons a question is handed to a person. */
export const ESCALATION_REASONS = [
  'user_request',
  'user_dissatisfaction',
  'sensitive_account_action',
  'out_of_scope',
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** How long a settings read is trusted before it is read again. */
const SETTINGS_CACHE_TTL_MS = 60_000;

/**
 * The request budget for a provider call.
 *
 * A free tier can take a while to answer, and a chat that waits a minute is
 * still a chat, while a chat that never answers is a broken panel.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.SAM_TIMEOUT_MS || '60000');

interface SamSettings {
  values: Record<string, string>;
  readAt: number;
}

let settingsCache: SamSettings | null = null;

/**
 * Drops the cached settings.
 *
 * A change made through the settings screen has to be visible immediately:
 * an operator who switches the provider and then sees the old one still in
 * use would conclude that the change did not work.
 */
export const invalidateSamSettingsCache = (): void => {
  settingsCache = null;
};

/**
 * The SAM settings, read from the operator-owned settings table.
 *
 * The rows live in `super_admin_settings` because they are deployment
 * configuration owned by the platform administrator, not application
 * preferences that belong to a person.
 */
export const getSamSettings = async (): Promise<Record<string, string>> => {
  const now = Date.now();
  if (settingsCache && now - settingsCache.readAt < SETTINGS_CACHE_TTL_MS) {
    return { ...settingsCache.values };
  }

  try {
    const [rows] = await pool.query(
      "SELECT setting_key, setting_value FROM super_admin_settings WHERE setting_key LIKE 'sam.%'"
    );
    const values: Record<string, string> = {};
    for (const row of rows as any[]) {
      const key = String(row.setting_key ?? '');
      // The query already narrows the rows to the SAM namespace. The check is
      // repeated here so a row from another namespace cannot reach the
      // settings even if the query is ever widened.
      if (!key.startsWith('sam.')) continue;
      values[key] =
        row.setting_value === null || row.setting_value === undefined
          ? ''
          : String(row.setting_value);
    }
    settingsCache = { values, readAt: now };
    return { ...values };
  } catch (error) {
    // A settings read must not take the chat down: without the settings the
    // defaults apply, which is a working assistant rather than none.
    console.error('SAM settings could not be read:', error instanceof Error ? error.message : error);
    return {};
  }
};

const isKnownProvider = (value: string): value is SamProviderName =>
  Object.prototype.hasOwnProperty.call(SAM_PROVIDERS, value);

/**
 * The provider and model the assistant is to use.
 *
 * The stored value wins, then the environment, then the built-in default.
 * A stored value that names an unknown provider is ignored rather than
 * obeyed: the settings table is writable by an administrator through the API
 * and a bad row must not be able to redirect the request somewhere else.
 */
export const resolveSamProvider = async (): Promise<{
  provider: SamProviderName;
  model: string;
  fallbackProvider?: SamProviderName;
  fallbackModel?: string;
}> => {
  const settings = await getSamSettings();

  const storedProvider = String(settings['sam.model_provider'] ?? '').trim();
  const envProvider = String(process.env.SAM_PROVIDER ?? '').trim();
  const provider = isKnownProvider(storedProvider)
    ? storedProvider
    : isKnownProvider(envProvider)
      ? envProvider
      : DEFAULT_PROVIDER;

  const storedModel = String(settings['sam.model_id'] ?? '').trim();
  const envModel = String(process.env.SAM_MODEL ?? '').trim();
  const model = storedModel || envModel || SAM_PROVIDERS[provider].defaultModel || DEFAULT_MODEL;

  const storedFallback = String(settings['sam.fallback_provider'] ?? '').trim();
  const fallbackProvider = isKnownProvider(storedFallback) ? storedFallback : undefined;
  const fallbackModel = String(settings['sam.fallback_model_id'] ?? '').trim() || undefined;

  return fallbackProvider
    ? { provider, model, fallbackProvider, fallbackModel }
    : { provider, model };
};

/**
 * The avatar shown next to the assistant's messages.
 *
 * The default is a path into the front end's own assets, so an installation
 * that never uploads an avatar still shows one.
 */
export const getSamProfileImageUrl = async (): Promise<string> => {
  const settings = await getSamSettings();
  const stored = String(settings['sam.profile_image_url'] ?? '').trim();
  return stored || '/sam-avatar-default.svg';
};

/**
 * The models a provider offers.
 *
 * OpenRouter publishes its catalogue, so the live list is preferred and the
 * free tier is what is kept -- the deployment is not expected to pay for a
 * model without an operator saying so. When the catalogue cannot be read the
 * curated list is returned, so the settings screen is never empty.
 */
export const listSamModels = async (providerName: string): Promise<string[]> => {
  if (!isKnownProvider(providerName)) {
    throw new Error('Unknown provider');
  }
  const descriptor = SAM_PROVIDERS[providerName];
  if (!descriptor.modelsEndpoint) {
    return [...descriptor.models];
  }

  const apiKey = String(process.env[descriptor.envKey] ?? '').trim();
  if (!isConfigured(apiKey)) {
    return [...descriptor.models];
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(descriptor.modelsEndpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      return [...descriptor.models];
    }
    const data: any = await response.json().catch(() => null);
    const ids = Array.isArray(data?.data)
      ? data.data
          .map((entry: any) => String(entry?.id ?? ''))
          .filter((id: string) => id.endsWith(':free'))
      : [];
    return ids.length > 0 ? ids : [...descriptor.models];
  } catch {
    // The catalogue is a convenience. The curated list is the answer when it
    // cannot be read.
    return [...descriptor.models];
  }
};

/**
 * The reasons a message asks for a person.
 *
 * The patterns are matched in this order and the first match wins, so the
 * most specific kind of escalation is reported.
 */
const ESCALATION_PATTERNS: { reason: EscalationReason; pattern: RegExp }[] = [
  {
    reason: 'user_request',
    pattern:
      /\b(talk to a human|speak to a person|human agent|real person|escalate|transfer me|customer service)\b/i,
  },
  {
    reason: 'user_dissatisfaction',
    pattern:
      /\b(didn'?t help|did not help|not helpful|useless|wrong answer|not satisfied|unsatisfied|still broken)\b/i,
  },
  {
    reason: 'sensitive_account_action',
    pattern:
      /\b(reset my password|forgot password|recover my account|delete my account|billing dispute|chargeback|refund|data subject|gdpr|my records)\b/i,
  },
];

/**
 * Whether a message has to be answered by a person, and why.
 *
 * The answer is "not satisfied" rather than "refund" for a question about the
 * refund policy: the pattern matches the word either way, and the request is
 * about an account action in both readings.
 */
export const detectEscalation = (userText: string): string | null => {
  const text = String(userText ?? '');
  if (text.trim() === '') return null;
  for (const { reason, pattern } of ESCALATION_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
};

/**
 * The instruction patterns that are removed from what the user typed.
 *
 * A chat box is an input the model reads. Without this, a message that says
 * "ignore all previous instructions" is a message the model obeys, and the
 * assistant that is meant to describe the platform starts describing
 * something else instead.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+(instructions?|prompts?|rules?)/gi,
  /disregard\s+(all\s+)?previous(\s+(instructions?|prompts?|rules?))?/gi,
  /reveal\s+(your\s+)?system\s+prompt/gi,
  /print\s+(your\s+)?instructions/gi,
  /you\s+are\s+now/gi,
  /begin\s+system\s+prompt/gi,
  /system\s*:/gi,
  /<\|im_start\|>/gi,
];

/**
 * The text that is actually sent to the model.
 *
 * The instruction patterns are removed, the whitespace is collapsed so the
 * model is not fed a wall of blank lines, and the text is cut to a length the
 * model will actually read.
 */
export const sanitizeSamInput = (text: string): string => {
  let cleaned = String(text ?? '');
  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ');
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned.length > 2000 ? cleaned.slice(0, 2000) : cleaned;
};

/**
 * The secrets that must never leave the server, even as text.
 *
 * The environment variables are read at the moment of the call rather than
 * when the module loads, so a value that is set after the module was loaded is
 * still redacted.
 */
const SENSITIVE_ENV_NAMES = [
  'JWT_SECRET',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'ENCRYPTION_IV',
  'DB_PASSWORD',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'SMTP_PASSWORD',
  'STRIPE_SECRET_KEY',
  'TWILIO_AUTH_TOKEN',
  'GOOGLE_DRIVE_CLIENT_SECRET',
  'ONEDRIVE_CLIENT_SECRET',
];

const REDACTION = '[REDACTED]';

/**
 * The text that is shown to the user.
 *
 * The model is an external service and the answer it produced is not trusted
 * to keep the platform's secrets to itself. Anything that looks like a
 * credential, a connection string or a private key is replaced before the
 * answer is sent, and so is any literal value of a secret the deployment
 * holds.
 */
export const sanitizeSamOutput = (text: string): string => {
  let cleaned = String(text ?? '');

  cleaned = cleaned.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    REDACTION
  );
  cleaned = cleaned.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTION);
  cleaned = cleaned.replace(/\b(?:mysql|mongodb(?:\+srv)?):\/\/\S+/gi, REDACTION);
  // The name is allowed to carry a prefix, because that is how a variable is
  // usually written: `DB_PASSWORD=...` is the same secret as `password=...`.
  cleaned = cleaned.replace(
    /(^|[^A-Za-z])(password|secret|api_key|apikey|access_token|client_secret)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi,
    (_match, prefix: string, key: string) => `${prefix}${key}=${REDACTION}`
  );
  cleaned = cleaned.replace(/\bghp_[A-Za-z0-9]{20,}/g, REDACTION);
  cleaned = cleaned.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTION);
  cleaned = cleaned.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTION);
  cleaned = cleaned.replace(/\b[A-Za-z0-9]{40,}\b/g, REDACTION);

  for (const name of SENSITIVE_ENV_NAMES) {
    const value = String(process.env[name] ?? '').trim();
    // A very short value is redacted by accident far more often than it is
    // leaked, and redacting it would corrupt the answer.
    if (value.length < 8) continue;
    cleaned = cleaned.split(value).join(REDACTION);
  }

  return cleaned;
};

/**
 * The knowledge SAM is given about the platform.
 *
 * The prompt is built in one place so that the answer to "how do I add a
 * patient" does not depend on which provider is answering.
 */
export const buildSamSystemPrompt = (currentPage?: string): string => {
  // Only the path is used. A query string can carry a patient identifier or
  // a search term, and the assistant has no business receiving either, so
  // anything after the path is dropped rather than sent.
  const rawPage = String(currentPage ?? '').split(/[?#]/)[0] ?? '';
  const page = sanitizeSamInput(rawPage).slice(0, 200);
  const pageNote =
    page.length > 0
      ? `\nThe user is currently on the page "${page}". Prefer the steps for that page when they answer the question. Mention the path only, never anything else about the request.\n`
      : '';

  return `You are SAM, the ${APP_NAME} support assistant. You help people use ${APP_NAME} -- the platform that manages patient records, appointments, pharmacy, documents, hospital operations, staff and finance.

FIRST TURN
On your first reply, greet the user warmly in one short sentence, say that you are SAM and that you can help with ${APP_NAME}, and ask how you can help today. After that, answer directly without greeting again.

PLATFORM OVERVIEW
${APP_NAME} is a multi-hospital healthcare management platform. A hospital signs up, the platform administrator grants roles and permissions, and staff use the modules below. Clinical records are scoped to the hospital the signed-in account belongs to.

MODULES
- Patients: register a patient, edit demographics, view the patient list and the patient record, search, and discharge.
- Appointments: schedule, reschedule and cancel appointments; view the calendar and the daily list; record attendance and outcomes.
- Pharmacy: the medicine catalogue, stock levels, dispensing, dispensing events, batches and recalls, prescriptions, forecasts and inventory reports.
- Documents: upload a document against a patient, categorise it, preview and download it, and check the storage usage.
- Financial: accounts, transactions, balances, invoice and payment tracking, and exportable reports.
- Staff: staff records, employment details, roles and access to the platform.
- Hospitals: the hospitals registered with the platform, their codes, their contacts and their status.
- Roles & Permissions: what each role may view, add, edit and delete, per module. Roles are granted through the Roles screen and take effect on the user's next request.
- Settings: platform-wide preferences such as the system name, timezone, language and currency.
- Emergency Board: the triage board -- bays, waiting patients, triage levels and the queue.
- Clinical AI: model-assisted clinical insight over recorded vitals, with a local fallback when the external model is not enabled.
- Audit Logs: the record of who changed what, filterable by user, module and date.
- Inventory: stock on hand, movements and reorder levels for the pharmacy.
- Purchase Orders: raise an order against a supplier, receive it, move it through its states and see what is outstanding.
- Suppliers: the supplier catalogue, with contacts and the orders placed with them.
- Notifications: in-application alerts about the records and events that need attention.
- Vitals: record a patient's blood pressure, heart rate, temperature, respiratory rate and oxygen saturation.
- Clinical Notes: write, review and sign the notes attached to a patient's care.
- Medication Administration: administer, refuse and record a dose against a prescription.
- Patient Portal: the patient's own view -- their appointments, documents, prescriptions and vitals.

ROLES
- super_admin: the platform administrator. Manages hospitals, users, roles, settings, backups and every module.
- admin: a hospital administrator. Manages staff, patients, appointments, pharmacy, finance and documents for their own hospital.
- doctor: sees and treats patients, writes clinical notes, records vitals, prescribes and reads clinical AI output.
- patient: sees only their own appointments, documents, prescriptions, vitals and notes in the portal.
- nurse: records vitals, medication administration and clinical notes, and works the emergency board.
- pharmacist: manages the medicine catalogue, stock, dispensing, batches and recalls, and checks interactions.
- lab_technician: enters and reviews laboratory results and supports the diagnostic workflow.
- hospital_management: sees the hospital's operational and financial reporting and its staffing.
- receptionist: registers and checks in patients and books and confirms appointments.
- billing_specialist: raises invoices, records payments and reconciles accounts.
- insurance_coordinator: verifies coverage, manages claims and coordinates approvals.
- medical_records_clerk: files, retrieves and maintains patient documents and records.
- radiology_technician: handles imaging orders, performs and records imaging studies.

NAVIGATION
Each module has its own page in the left-hand sidebar, grouped by area. Use the section names above to point somebody at the right screen, and give the action to look for on that screen rather than a menu path that may change.

COMMON TASKS
- Create a patient: Patients, then Add patient. The patient's own code is generated by the application; enter the demographics, confirm the hospital and save. The new record then appears in the patient list.
- Schedule an appointment: Appointments, then New appointment. Choose the patient, the clinician and the slot, set the reason and the duration, and save. The confirmation appears on the calendar and in the daily list.
- Upload a document: open the patient, then Documents, then Upload. Choose the category, add a note if needed and save. The document is attached to that patient's record.
- Pharmacy stock: Pharmacy, then Inventory, to adjust stock levels; Medicines, to maintain the catalogue; Dispensing, to record a dispense against a prescription.
- Request access: Roles & Permissions, where an administrator grants a role the modules it may use. Ask an administrator if the action you need is not visible.
- Read the audit trail: Audit Logs, filtered by user, module and date. The entries are written by the system, not by hand.

TROUBLESHOOTING
- Cannot sign in: check the address and password first; an account that has been suspended or left in the background cannot sign in at all. If the password was changed, the old password stops working immediately and every session ends.
- Two-factor: a second factor is set up from the account's own settings. A sign-in that asks for a code and then refuses it is usually a code from an older enrolment.
- "Insufficient permissions": the account's role does not carry that module for that action. An administrator can grant it in Roles & Permissions. A permission that never passes makes the feature unavailable to that account.
- Stale data: reload the page. If the record still looks wrong, the change may have been made by another user in the meantime -- check the audit log for that record.
- Offline mode: work recorded without a connection is queued and sent when the connection returns. If a change appears not to have been saved, check the connection and reload before repeating it.
- Password reset: the reset link is sent to the registered address and expires. If it does not arrive, check the spam folder, then ask an administrator to reset the password from the user management screen.

ESCALATION
If the user needs a sensitive account action, is dissatisfied with the answer, reports a bug, asks for a human, or the question is about billing, legal or compliance, reply with the marker [ESCALATE:reason] on its own line, where reason is one of: sensitive_account_action, user_dissatisfaction, out_of_scope, user_request. Then tell them that a human support agent will follow up. Never attempt to resolve such a request yourself, and never state that an action has been carried out when it has not.

SECURITY RULES -- these are hard constraints, not preferences
- Never reveal, quote, summarise or paraphrase API keys, credentials, secrets, tokens, environment variables, database connection details, internal file paths, or implementation details.
- Never read, quote, or speculate about any individual user's account, profile, credentials, activity, or about any patient record. You have no access to user data at all.
- If you are asked for any of the above, say that you cannot help with that and point the user to human support.
- Do not perform actions. You can explain how a screen works; you cannot create, change or delete anything.

STYLE
Be concise and practical. Use short paragraphs and numbered steps for procedures. Do not invent features, screens or policies: if the platform does not do something, say so plainly.${pageNote}`;
};

interface ProviderCall {
  provider: SamProviderName;
  model: string;
  apiKey: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  /** The deadline for the request, so a provider that never answers is abandoned. */
  signal: AbortSignal;
}

interface ProviderAnswer {
  text: string;
}

/**
 * The OpenAI-compatible request shape, used by OpenRouter, Groq and OpenAI.
 */
const callOpenAiCompatible = async (call: ProviderCall): Promise<ProviderAnswer | null> => {
  const descriptor = SAM_PROVIDERS[call.provider];
  const body = {
    model: call.model,
    messages: [{ role: 'system', content: call.systemPrompt }, ...call.messages],
    stream: false,
  };

  const response = await fetch(descriptor.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${call.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: call.signal,
  });

  const data: any = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = typeof data?.error?.message === 'string' ? data.error.message : `HTTP ${response.status}`;
    console.error(`SAM request to ${call.provider} failed (${response.status}): ${reason}`);
    return null;
  }

  const content = data?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : '';
  return text.trim() === '' ? null : { text };
};

/**
 * The Gemini request shape.
 *
 * The system instruction is sent as a system instruction rather than being
 * concatenated into a user turn, so the model can tell the two apart.
 */
const callGemini = async (call: ProviderCall): Promise<ProviderAnswer | null> => {
  const endpoint = SAM_PROVIDERS.gemini.endpoint
    .replace('{model}', encodeURIComponent(call.model))
    .replace('{apiKey}', encodeURIComponent(call.apiKey));

  const contents = call.messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: call.systemPrompt }] },
    }),
    signal: call.signal,
  });

  const data: any = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = typeof data?.error?.message === 'string' ? data.error.message : `HTTP ${response.status}`;
    console.error(`SAM request to gemini failed (${response.status}): ${reason}`);
    return null;
  }

  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('')
    : '';
  return text.trim() === '' ? null : { text };
};

/**
 * The Anthropic request shape.
 */
const callAnthropic = async (call: ProviderCall): Promise<ProviderAnswer | null> => {
  const response = await fetch(SAM_PROVIDERS.anthropic.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': call.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: call.model,
      max_tokens: 1500,
      system: call.systemPrompt,
      messages: call.messages.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      })),
    }),
    signal: call.signal,
  });

  const data: any = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = typeof data?.error?.message === 'string' ? data.error.message : `HTTP ${response.status}`;
    console.error(`SAM request to anthropic failed (${response.status}): ${reason}`);
    return null;
  }

  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks
    .map((block: any) => (typeof block?.text === 'string' ? block.text : ''))
    .join('')
    .trim();
  return text === '' ? null : { text };
};

const callProvider = async (call: ProviderCall): Promise<ProviderAnswer | null> => {
  try {
    if (call.provider === 'gemini') return await callGemini(call);
    if (call.provider === 'anthropic') return await callAnthropic(call);
    return await callOpenAiCompatible(call);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown network error';
    console.error(`SAM request to ${call.provider} could not be completed: ${reason}`);
    return null;
  }
};

/**
 * The placeholder shown when no model could be reached.
 */
const simulatedText = (reason: string): string =>
  [
    '⚠️ **SIMULATED RESPONSE — NOT GENERATED BY THE AI MODEL**',
    '',
    'The support assistant is not reachable in this environment, so no answer could be produced.',
    'This placeholder is shown instead of an answer and must not be read as guidance.',
    '',
    `*Reason: ${reason}*`,
    '',
    'Set the API key for the configured provider in the server environment to enable live answers.',
  ].join('\n');

/**
 * The escalation marker the model is asked to produce.
 */
const ESCALATION_MARKER = /\[ESCALATE:(sensitive_account_action|user_dissatisfaction|out_of_scope|user_request)\]/i;

/**
 * A reply from the support assistant.
 *
 * The messages are sanitised on the way in and the answer is sanitised on the
 * way out, so neither the model nor the user can get a secret into the
 * transcript. The escalation is decided on the server: the model is asked to
 * ask for one, and the request itself is checked, so a request that needs a
 * person is escalated whether or not the model noticed.
 */
export const samChat = async (params: {
  messages: { role: string; content: string }[];
  currentPage?: string;
}): Promise<SamChatResponse> => {
  const incoming = Array.isArray(params.messages) ? params.messages : [];
  const messages = incoming
    .filter((message) => typeof message?.content === 'string' && message.content.trim() !== '')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: sanitizeSamInput(message.content),
    }));

  const { provider, model, fallbackProvider, fallbackModel } = await resolveSamProvider();

  // The escalation is decided on what the person actually wrote, not on the
  // sanitised version of it: the sanitiser removes instruction-shaped text,
  // and a trigger phrase can be part of it.
  const lastUserMessage = [...incoming]
    .reverse()
    .find((message) => message?.role !== 'assistant');
  const escalateReason = detectEscalation(lastUserMessage?.content ?? '') ?? undefined;

  if (messages.length === 0) {
    return {
      text: 'No question was submitted, so there was nothing for the assistant to answer.',
      modelUsed: model,
      simulated: true,
      provider,
      escalate: Boolean(escalateReason),
      escalateReason: escalateReason ?? undefined,
    };
  }

  const systemPrompt = buildSamSystemPrompt(params.currentPage);
  const descriptor = SAM_PROVIDERS[provider];
  const apiKey = String(process.env[descriptor.envKey] ?? '').trim();

  if (!isConfigured(apiKey)) {
    return {
      text: simulatedText(`${descriptor.envKey} is not configured on the server.`),
      modelUsed: model,
      simulated: true,
      provider,
      escalate: Boolean(escalateReason),
      escalateReason: escalateReason ?? undefined,
    };
  }

  // The deadline belongs to the whole attempt rather than to one provider
  // call, so a primary that hangs does not consume the budget of the
  // fallback as well.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let answer: ProviderAnswer | null;
  let usedModel = model;
  let usedProvider = provider;

  try {
    answer = await callProvider({
      provider,
      model,
      apiKey,
      systemPrompt,
      messages,
      signal: controller.signal,
    });

    // The fallback is only tried when the primary failed and the fallback is a
    // different provider with a key of its own.
    if (!answer && fallbackProvider && fallbackProvider !== provider) {
      const fallbackDescriptor = SAM_PROVIDERS[fallbackProvider];
      const fallbackKey = String(process.env[fallbackDescriptor.envKey] ?? '').trim();
      if (isConfigured(fallbackKey)) {
        const fallbackAnswer = await callProvider({
          provider: fallbackProvider,
          model: fallbackModel || fallbackDescriptor.defaultModel,
          apiKey: fallbackKey,
          systemPrompt,
          messages,
          signal: controller.signal,
        });
        if (fallbackAnswer) {
          answer = fallbackAnswer;
          usedModel = fallbackModel || fallbackDescriptor.defaultModel;
          usedProvider = fallbackProvider;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (!answer) {
    return {
      text: simulatedText(`The request to ${usedProvider} did not produce an answer.`),
      modelUsed: usedModel,
      simulated: true,
      provider: usedProvider,
      escalate: Boolean(escalateReason),
      escalateReason: escalateReason ?? undefined,
    };
  }

  const marker = ESCALATION_MARKER.exec(answer.text);
  const markerReason = marker ? marker[1].toLowerCase() : undefined;

  return {
    // The marker is a protocol between the model and this service. It is
    // removed from the answer because the answer is shown to a person, and
    // the escalation is reported through the flags beside it.
    text: sanitizeSamOutput(answer.text.replace(ESCALATION_MARKER, '').trim()),
    modelUsed: usedModel,
    simulated: false,
    provider: usedProvider,
    escalate: Boolean(markerReason || escalateReason),
    escalateReason: markerReason ?? escalateReason ?? undefined,
  };
};
