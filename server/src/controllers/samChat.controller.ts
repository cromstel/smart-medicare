/**
 * SAM support assistant controller.
 *
 * Validation and orchestration only -- the model calls and the sanitising
 * live in services/samChat.service.ts.
 *
 * Two rules shape this controller:
 *  1. The configuration is operator-owned. Reading it is open to any
 *     signed-in account, because the chat surface needs to know whether the
 *     assistant exists and which mark it wears; writing it is guarded by the
 *     super-admin permission.
 *  2. Every write goes through an explicit column whitelist. The settings
 *     table is the platform's, and `Object.keys(req.body)` fed into a write
 *     is how a caller ends up setting something they were not asked to set.
 */
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import pool from '../config/database.js';
import { resolveConfiguredPath, repositoryRoot } from '../config/paths.js';
import { safeFileName, isInsideDirectory } from '../utils/files.js';
import * as samChatService from '../services/samChat.service.js';
import type { SamProviderName } from '../services/samChat.service.js';
import type { AuthRequest } from '../middleware/auth.js';

/** The mark the assistant wears until an operator uploads one. */
const DEFAULT_PROFILE_IMAGE_URL = '/sam-avatar-default.svg';

/** The largest profile image the service accepts. */
const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;

/** The image formats the service accepts. */
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.webp', '.avif']);
const ALLOWED_IMAGE_MIMETYPES = new Set(['image/webp', 'image/avif']);

/** The category the SAM rows are stored under in the settings table. */
const SAM_SETTING_CATEGORY = 'ai_support';

/**
 * Where the uploaded mark is written.
 *
 * The uploads root is the same one the document service uses, so a backup
 * that copies the upload tree copies the mark with it. The path is resolved
 * through the same helper the rest of the platform uses, so a deployment can
 * move its upload store without editing code.
 */
const uploadsRoot = (): string =>
  resolveConfiguredPath(process.env.UPLOAD_DIR, path.join(repositoryRoot(), 'server', 'uploads'));

/**
 * Where one uploaded mark lives.
 *
 * The layout follows the document service: a directory per item, a version
 * inside it and the file inside that. The directory carries a generated
 * identifier rather than a name the client chose, so two uploads never
 * collide and a name cannot steer where the file is written.
 */
const profileImageDirectory = (itemId: string): string =>
  path.join(uploadsRoot(), 'unassigned', 'sam', itemId, 'version-1');

/**
 * The address the browser fetches a stored mark from.
 *
 * The path carries the identifier and the file name rather than the whole
 * relative path, so nothing about the server's directory layout is published
 * and the stored value can be checked against it when the file is removed.
 */
const profileImageUrl = (itemId: string, fileName: string): string =>
  `/api/sam/profile-image/file/${itemId}/${fileName}`;

/**
 * The settings the configuration is written to, and the key each one lives
 * under.
 *
 * The mapping is written out rather than derived from the request body: a
 * key the caller invents is a setting the platform did not ask for.
 */
const CONFIG_SETTING_KEYS = {
  enabled: 'sam.enabled',
  provider: 'sam.model_provider',
  model: 'sam.model_id',
  fallbackProvider: 'sam.fallback_provider',
  fallbackModel: 'sam.fallback_model_id',
  humanSupportEmail: 'sam.human_support_email',
  humanSupportUrl: 'sam.human_support_url',
  profileImageUrl: 'sam.profile_image_url',
} as const;

const handleValidation = (req: Request, res: Response): boolean => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
};

/**
 * Reads a boolean setting.
 *
 * A setting that is absent is not the same as a setting that is false, and
 * the assistant is switched on unless somebody switched it off.
 */
const readBooleanSetting = (settings: Record<string, string>, key: string, fallback: boolean): boolean => {
  const raw = settings[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return String(raw).trim().toLowerCase() === 'true';
};

/**
 * Upserts one SAM setting.
 *
 * `updated_by` is a foreign key to users, so an account that has since been
 * removed would make the write fail. The write is retried without the
 * attribution rather than losing the setting.
 */
const upsertSamSetting = async (
  settingKey: string,
  settingValue: string,
  userId: string | null
): Promise<void> => {
  const sql =
    `INSERT INTO super_admin_settings (setting_key, setting_value, category, updated_by, updated_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       setting_value = VALUES(setting_value),
       updated_at = NOW()`;

  const numericId = userId !== null && /^\d+$/.test(userId) ? Number(userId) : null;
  try {
    await pool.query(sql, [settingKey, settingValue, SAM_SETTING_CATEGORY, numericId]);
  } catch (error) {
    console.error(
      'Could not attribute the SAM setting update to a user, retrying without it:',
      error instanceof Error ? error.message : String(error)
    );
    await pool.query(sql, [settingKey, settingValue, SAM_SETTING_CATEGORY, null]);
  }
};

/** Removes one SAM setting. */
const deleteSamSetting = async (settingKey: string): Promise<void> => {
  await pool.query('DELETE FROM super_admin_settings WHERE setting_key = ?', [settingKey]);
};

/**
 * The configuration as the browser sees it.
 */
const readConfig = async (): Promise<Record<string, unknown>> => {
  const settings = await samChatService.getSamSettings();
  const resolved = await samChatService.resolveSamProvider();

  const storedFallbackProvider = String(settings[CONFIG_SETTING_KEYS.fallbackProvider] ?? '').trim();
  const storedFallbackModel = String(settings[CONFIG_SETTING_KEYS.fallbackModel] ?? '').trim();

  const fallbackProvider =
    storedFallbackProvider && Object.prototype.hasOwnProperty.call(samChatService.SAM_PROVIDERS, storedFallbackProvider)
      ? storedFallbackProvider
      : null;
  const fallbackModel = storedFallbackModel || null;

  const humanSupportEmail = String(settings[CONFIG_SETTING_KEYS.humanSupportEmail] ?? '').trim();
  const humanSupportUrl = String(settings[CONFIG_SETTING_KEYS.humanSupportUrl] ?? '').trim();

  return {
    enabled: readBooleanSetting(settings, CONFIG_SETTING_KEYS.enabled, true),
    provider: resolved.provider,
    model: resolved.model,
    fallbackProvider,
    fallbackModel,
    profileImageUrl: await samChatService.getSamProfileImageUrl(),
    humanSupportEmail: humanSupportEmail || null,
    humanSupportUrl: humanSupportUrl || null,
  };
};

/**
 * Records that a question has been handed to a person.
 *
 * Only the reason is written. The conversation is not: the trail records that
 * an escalation happened and why, so an operator can see that support is
 * being asked for, without the trail becoming a second copy of what was
 * said. The actor is attributed the way every other write in this platform is
 * attributed -- an audit row that names nobody cannot answer the question it
 * exists to answer.
 */
const recordEscalation = async (
  req: AuthRequest,
  reason: string | undefined
): Promise<void> => {
  try {
    const actorId = req.user?.id && /^\d+$/.test(req.user.id) ? Number(req.user.id) : null;
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, module, new_value, ip_address)
       VALUES (?, 'escalate', 'sam', ?, ?)`,
      [actorId, reason ? `Escalated to human support: ${reason}` : 'Escalated to human support', req.ip]
    );
  } catch (error) {
    // A trail that cannot be written must not cost the visitor their answer.
    console.error('Could not record the SAM escalation:', error instanceof Error ? error.message : error);
  }
};

/**
 * POST /api/sam/chat
 *
 * Body: { messages: [{ role, content }], currentPage? }
 * Response: { text, modelUsed, simulated, provider, escalate, escalateReason }
 */
export const chat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (handleValidation(req, res)) return;

    // An operator who switched the assistant off expects it to be off. The
    // browser hides the widget, but the browser is not the only client.
    const settings = await samChatService.getSamSettings();
    if (!readBooleanSetting(settings, CONFIG_SETTING_KEYS.enabled, true)) {
      res.status(403).json({ error: 'The support assistant is switched off on this deployment' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];

    const result = await samChatService.samChat({
      messages: rawMessages.map((message: any) => ({
        role: String(message?.role ?? 'user'),
        content: String(message?.content ?? ''),
      })),
      currentPage: body.currentPage ? String(body.currentPage) : undefined,
    });

    if (result.escalate) {
      await recordEscalation(req, result.escalateReason);
    }

    res.status(200).json({
      ...result,
      // The identifier the feedback endpoint refers the answer to. It is
      // generated here because the answer has no record of its own.
      messageId: uuidv4(),
      // The model is reported under both names: `modelUsed` is the service
      // contract, `model` is what the chat surface reads.
      model: result.modelUsed,
    });
  } catch (error) {
    console.error('Error handling the SAM chat request:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to handle the support request' });
  }
};

/**
 * GET /api/sam/config
 *
 * Any signed-in account may read this: the chat surface needs to know whether
 * the assistant is switched on, which model answers and which mark it wears.
 */
export const getConfig = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.status(200).json(await readConfig());
  } catch (error) {
    console.error('Error reading the SAM configuration:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to read the support assistant configuration' });
  }
};

/**
 * PUT /api/sam/config
 *
 * Body: { enabled?, provider?, model?, fallbackProvider?, fallbackModel?,
 *          humanSupportEmail?, humanSupportUrl? }
 */
export const updateConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (handleValidation(req, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = req.user?.id ?? null;

    const writes: { key: string; value: string }[] = [];

    // A value the client sends as null means "there is no value". The
    // settings table holds text, so null is stored as an empty string rather
    // than as the word "null".
    const asText = (value: unknown): string =>
      value === null || value === undefined ? '' : String(value).trim();

    if (body.enabled !== undefined && body.enabled !== null) {
      writes.push({
        key: CONFIG_SETTING_KEYS.enabled,
        value: body.enabled === true || String(body.enabled).toLowerCase() === 'true' ? 'true' : 'false',
      });
    }
    if (body.provider !== undefined && body.provider !== null) {
      const provider = asText(body.provider);
      if (!Object.prototype.hasOwnProperty.call(samChatService.SAM_PROVIDERS, provider)) {
        res.status(400).json({ error: 'Unknown provider' });
        return;
      }
      writes.push({ key: CONFIG_SETTING_KEYS.provider, value: provider });
    }
    if (body.fallbackProvider !== undefined) {
      const fallbackProvider = asText(body.fallbackProvider);
      if (
        fallbackProvider !== '' &&
        !Object.prototype.hasOwnProperty.call(samChatService.SAM_PROVIDERS, fallbackProvider)
      ) {
        res.status(400).json({ error: 'Unknown fallback provider' });
        return;
      }
      writes.push({ key: CONFIG_SETTING_KEYS.fallbackProvider, value: fallbackProvider });
    }

    // A model is checked against the provider it belongs to. The provider is
    // the one in the request when the request names one, and the one that is
    // stored otherwise, so a model cannot be stored for a provider it is not
    // offered by.
    const currentSettings = await samChatService.getSamSettings();
    const effectiveProvider =
      body.provider !== undefined && body.provider !== null
        ? asText(body.provider)
        : String(currentSettings[CONFIG_SETTING_KEYS.provider] ?? '').trim() ||
          (await samChatService.resolveSamProvider()).provider;

    if (body.model !== undefined) {
      const model = asText(body.model);
      if (model !== '' && !isKnownModel(effectiveProvider, model)) {
        res.status(400).json({ error: 'That model is not offered by the selected provider' });
        return;
      }
      writes.push({ key: CONFIG_SETTING_KEYS.model, value: model });
    }
    if (body.fallbackModel !== undefined) {
      const fallbackModel = asText(body.fallbackModel);
      const fallbackProvider =
        body.fallbackProvider !== undefined
          ? asText(body.fallbackProvider)
          : String(currentSettings[CONFIG_SETTING_KEYS.fallbackProvider] ?? '').trim();
      if (
        fallbackModel !== '' &&
        fallbackProvider !== '' &&
        !isKnownModel(fallbackProvider, fallbackModel)
      ) {
        res.status(400).json({ error: 'That model is not offered by the selected fallback provider' });
        return;
      }
      writes.push({ key: CONFIG_SETTING_KEYS.fallbackModel, value: fallbackModel });
    }
    if (body.humanSupportEmail !== undefined) {
      const email = asText(body.humanSupportEmail);
      if (email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'The support contact is not an email address' });
        return;
      }
      writes.push({ key: CONFIG_SETTING_KEYS.humanSupportEmail, value: email });
    }
    if (body.humanSupportUrl !== undefined) {
      const url = asText(body.humanSupportUrl);
      // The address is rendered as a link on the chat panel. A scheme that is
      // not http or https would run script in the page when the link is
      // followed, so it is refused rather than stored.
      if (url !== '') {
        let scheme: string;
        try {
          scheme = new URL(url).protocol.toLowerCase();
        } catch {
          res.status(400).json({ error: 'The support portal must be a full web address' });
          return;
        }
        if (scheme !== 'http:' && scheme !== 'https:') {
          res.status(400).json({ error: 'The support portal must be an http or https address' });
          return;
        }
      }
      writes.push({ key: CONFIG_SETTING_KEYS.humanSupportUrl, value: url });
    }

    if (writes.length === 0) {
      res.status(400).json({ error: 'No settings supplied' });
      return;
    }

    for (const write of writes) {
      await upsertSamSetting(write.key, write.value, userId);
    }

    // The read is cached, so the cache is dropped rather than leaving the
    // operator looking at the settings they have just replaced.
    samChatService.invalidateSamSettingsCache();

    res.status(200).json(await readConfig());
  } catch (error) {
    console.error('Error updating the SAM configuration:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to update the support assistant configuration' });
  }
};

/**
 * GET /api/sam/models?provider=
 *
 * The catalogue a provider offers. It is a convenience: the curated list is
 * returned when the live catalogue cannot be read.
 */
export const listModels = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (handleValidation(req, res)) return;

    const provider = String(req.query.provider ?? '').trim();
    if (!Object.prototype.hasOwnProperty.call(samChatService.SAM_PROVIDERS, provider)) {
      res.status(400).json({ error: 'Unknown provider' });
      return;
    }

    const models = await samChatService.listSamModels(provider);
    res.status(200).json({ provider, models });
  } catch (error) {
    console.error('Error listing the SAM models:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to list the available models' });
  }
};

/**
 * POST /api/sam/profile-image
 *
 * The mark the assistant wears. Only the two modern web formats are
 * accepted: both are smaller than the raster formats for the same picture,
 * and the file is served straight to a browser.
 */
export const uploadProfileImage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (handleValidation(req, res)) return;

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: 'No image was uploaded' });
      return;
    }

    if (file.size > MAX_PROFILE_IMAGE_BYTES) {
      res.status(400).json({ error: 'That image is larger than the service accepts' });
      return;
    }

    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
      res.status(400).json({ error: 'The image must be a WebP or an AVIF file' });
      return;
    }
    if (!ALLOWED_IMAGE_MIMETYPES.has(String(file.mimetype || '').toLowerCase())) {
      res.status(400).json({ error: 'The image must be a WebP or an AVIF file' });
      return;
    }

    // The name the client sent is not used as a path. It is reduced to
    // something that cannot mean anything to the filesystem.
    const storedName = safeFileName(file.originalname, `sam-avatar${extension}`);
    const itemId = uuidv4();
    const directory = profileImageDirectory(itemId);

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, storedName), file.buffer);

    // The previous mark is removed rather than left behind: a file nobody
    // can reach is disk that nobody notices it is using.
    await removeStoredProfileImage();

    await upsertSamSetting(CONFIG_SETTING_KEYS.profileImageUrl, profileImageUrl(itemId, storedName), req.user?.id ?? null);
    samChatService.invalidateSamSettingsCache();

    res.status(200).json({ url: profileImageUrl(itemId, storedName) });
  } catch (error) {
    console.error('Error uploading the SAM profile image:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to store the profile image' });
  }
};

/**
 * GET /api/sam/profile-image
 *
 * The address of the mark the assistant wears.
 */
export const getProfileImage = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const url = await samChatService.getSamProfileImageUrl();
    res.status(200).json({ url });
  } catch (error) {
    console.error('Error reading the SAM profile image:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to read the profile image' });
  }
};

/**
 * GET /api/sam/profile-image/file/:itemId/:fileName
 *
 * The stored mark itself.
 *
 * The path is the two segments the stored URL is made of, and both are
 * checked before anything is read: a name that is not a plain identifier or
 * a plain file name is refused rather than joined onto a directory.
 */
export const getProfileImageFile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const itemId = String(req.params.itemId ?? '');
    const fileName = String(req.params.fileName ?? '');

    if (!/^[0-9a-f-]{36}$/i.test(itemId) || !/^[A-Za-z0-9._-]{1,180}$/.test(fileName)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const directory = profileImageDirectory(itemId);
    const filePath = path.join(directory, fileName);

    // The path is checked against the directory it belongs to as well as
    // being pattern-checked. The pattern is the first line of defence; the
    // check is the one that cannot be talked out of.
    if (!isInsideDirectory(directory, filePath)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.setHeader('Content-Type', fileName.endsWith('.avif') ? 'image/avif' : 'image/webp');
    // The mark is not a record: it is the same for everybody and it carries
    // nothing about a person.
    res.setHeader('Cache-Control', 'public, max-age=300');
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error('Error serving the SAM profile image:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to read the profile image' });
  }
};

/**
 * DELETE /api/sam/profile-image
 *
 * Removes the stored mark and restores the default one.
 */
export const deleteProfileImage = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    await removeStoredProfileImage();
    await deleteSamSetting(CONFIG_SETTING_KEYS.profileImageUrl);
    samChatService.invalidateSamSettingsCache();

    res.status(200).json({ url: DEFAULT_PROFILE_IMAGE_URL });
  } catch (error) {
    console.error('Error deleting the SAM profile image:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to remove the profile image' });
  }
};

/**
 * Removes the stored mark from disk, if there is one.
 *
 * The stored setting names the file, so the file that is removed is the one
 * that was stored and not one named by the request.
 */
const removeStoredProfileImage = async (): Promise<void> => {
  const settings = await samChatService.getSamSettings();
  const stored = String(settings[CONFIG_SETTING_KEYS.profileImageUrl] ?? '').trim();
  if (!stored) return;

  const match = /^\/api\/sam\/profile-image\/file\/([0-9a-f-]{36})\/([A-Za-z0-9._-]{1,180})$/i.exec(stored);
  if (!match) return;

  const directory = profileImageDirectory(match[1]);
  try {
    fs.rmSync(path.join(directory, match[2]), { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.error('Could not remove the stored SAM profile image:', error instanceof Error ? error.message : error);
  }
};

/**
 * POST /api/sam/feedback
 *
 * Whether an answer was useful. It is recorded as an analytics event: the
 * answer itself is not kept, because it is a conversation about the
 * platform and nothing in it needs to be retained.
 */
export const recordFeedback = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (handleValidation(req, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const helpful = body.helpful === true || String(body.helpful).toLowerCase() === 'true';

    await pool.query(
      `INSERT INTO analytics_events
         (event_name, event_data, user_id, session_id, page_url, occurred_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        'sam_feedback',
        JSON.stringify({ helpful, messageId: body.messageId ? String(body.messageId) : null }),
        req.user?.id ? Number(req.user.id) : null,
        null,
        null,
      ]
    );

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error recording the SAM feedback:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to record the feedback' });
  }
};

/**
 * The provider names the service accepts.
 *
 * Exposed so the routes can validate against the same list the service
 * uses, rather than a second list that can drift from it.
 */
export const knownProviders = (): SamProviderName[] =>
  Object.keys(samChatService.SAM_PROVIDERS) as SamProviderName[];

/**
 * Whether a model belongs to a provider.
 *
 * The curated list is what the settings screen validates against. OpenRouter
 * publishes a far larger catalogue, so a free model that is not in the
 * curated list is accepted for that provider as well.
 */
export const isKnownModel = (provider: string, model: string): boolean => {
  const descriptor = samChatService.SAM_PROVIDERS[provider as SamProviderName];
  if (!descriptor) return false;
  if (descriptor.models.includes(model)) return true;
  if (provider === 'openrouter') {
    return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:free$/.test(model);
  }
  return false;
};


