import { useState, useEffect } from 'react';
import { api, type SamConfig, type SuperAdminBackup, type SuperAdminSetting } from '@/services/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, CheckCircle, HardDriveUpload, HardDriveDownload, HeartPulse, ShieldCheck, Copy, Check, Bot, Upload, RefreshCw, Trash2, Plug } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { resolveApiAssetUrl } from '@/config/api';
import { toast } from 'sonner';

/**
 * Two-factor enrolment for the super admin's own account.
 *
 * The seed deliberately leaves totp_secret NULL for this account (see
 * seed.sql), so the master session starts on credentials alone and the operator
 * chooses when two-factor becomes mandatory. Without this panel there would be
 * no way to turn it on: the enrolment endpoints exist and the staff settings
 * page uses them, but the super-admin console had no entry point, so the seeded
 * account would stay permanently unenrolled.
 */
function SuperAdminTwoFactor() {
  const { user, refreshUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');
  const [pairing, setPairing] = useState(false);
  const [confirmCode, setConfirmCode] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const enabled = Boolean(user?.totp_enabled);

  const startEnrolment = async () => {
    setBusy(true);
    try {
      const { secret: newSecret } = await api.totpEnroll();
      setSecret(newSecret);
      setPairing(true);
      setDisabling(false);
      toast.success('Secret generated. Add it to your authenticator app, then confirm a code.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start two-factor setup.');
    } finally {
      setBusy(false);
    }
  };

  const confirmEnrolment = async () => {
    const code = confirmCode.trim();
    if (!/^\d{6}$/.test(code)) {
      toast.error('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.totpConfirm(secret, code);
      setPairing(false);
      setConfirmCode('');
      setSecret('');
      setRecoveryCodes(result.recoveryCodes ?? []);
      toast.success('Two-factor authentication enabled for this master account.');
      await refreshUser();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Verification failed. Check the code.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    const code = disableCode.trim();
    if (!/^\d{6}$/.test(code)) {
      toast.error('Enter a current 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    try {
      await api.totpDisable(code);
      setDisabling(false);
      setDisableCode('');
      toast.success('Two-factor authentication disabled.');
      await refreshUser();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not disable two-factor.');
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy. Select the secret manually.');
    }
  };

  return (
    <Card className="border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <ShieldCheck className="h-5 w-5 text-accent" aria-hidden="true" />
          Two-Factor Authentication
        </CardTitle>
        <CardDescription>
          Protects the master session. Not enabled by default so a fresh
          environment can be signed into; enable it once your authenticator app
          is paired.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Status:{' '}
          <span className={enabled ? 'font-semibold text-success' : 'font-semibold text-warning'}>
            {enabled ? 'Enabled' : 'Not enabled'}
          </span>
        </p>

        {recoveryCodes.length > 0 && (
          <div className="space-y-2 rounded-md border border-warning/30 bg-warning/10 p-4">
            <p className="text-sm font-semibold text-foreground">
              Recovery codes — shown once
            </p>
            <ul className="grid grid-cols-2 gap-1 font-mono text-xs text-foreground">
              {recoveryCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Store these now. They are the only way back in if the authenticator
              is lost.
            </p>
          </div>
        )}

        {pairing && secret && (
          <div className="space-y-3 rounded-md border border-border bg-background p-4">
            <Label htmlFor="superadmin-totp-secret">Authenticator secret</Label>
            <div className="flex items-center gap-2">
              <code
                id="superadmin-totp-secret"
                className="flex-1 rounded border border-border bg-card px-3 py-2 font-mono text-xs break-all text-foreground"
              >
                {secret}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={copySecret}>
                {copied ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                <span className="sr-only">Copy secret</span>
              </Button>
            </div>
            <Label htmlFor="superadmin-totp-confirm">6-digit code</Label>
            <Input
              id="superadmin-totp-confirm"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={confirmCode}
              onChange={(e) => setConfirmCode(e.target.value)}
              className="font-mono"
            />
            <Button onClick={confirmEnrolment} disabled={busy}>
              {busy ? 'Verifying...' : 'Confirm and enable'}
            </Button>
          </div>
        )}

        {disabling && (
          <div className="space-y-3 rounded-md border border-border bg-background p-4">
            <Label htmlFor="superadmin-totp-disable">Current 6-digit code</Label>
            <Input
              id="superadmin-totp-disable"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value)}
              className="font-mono"
            />
            <div className="flex gap-2">
              <Button variant="destructive" onClick={disable} disabled={busy}>
                {busy ? 'Disabling...' : 'Confirm disable'}
              </Button>
              <Button variant="outline" onClick={() => setDisabling(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {!pairing && !disabling && (
          <div className="flex flex-wrap gap-2">
            {enabled ? (
              <Button variant="outline" onClick={() => setDisabling(true)} disabled={busy}>
                Disable two-factor
              </Button>
            ) : (
              <Button onClick={startEnrolment} disabled={busy}>
                {busy ? 'Working...' : 'Enable two-factor'}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The providers SAM can be pointed at.
 *
 * The list is a closed set on this deployment: each one names an API the
 * server holds a key for, and a provider that is not on this list has no
 * route through the server.
 */
const SAM_PROVIDERS = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'groq', label: 'Groq' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
];

/** The largest profile image the server accepts. */
const SAM_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** The formats the server accepts for a profile image. */
const SAM_IMAGE_TYPES = ['image/webp', 'image/avif'];

/**
 * Configuration for SAM, the AI support assistant.
 *
 * The section is here, in the operator's own console, because the settings
 * it holds decide what the assistant says and who can reach a human when it
 * cannot help: the provider and model that answer, the fallback for when
 * they fail, and the address a human support agent can be reached at.
 */
function SAMSettings() {
  const [config, setConfig] = useState<SamConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const [fallbackModels, setFallbackModels] = useState<string[]>([]);
  const [fallbackModelsError, setFallbackModelsError] = useState<string | null>(null);

  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(null);
  const [usingDefaultImage, setUsingDefaultImage] = useState(true);
  const [imageError, setImageError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const loaded = await api.getSAMConfig();
      setConfig(loaded);
      setProfileImageUrl(loaded.profileImageUrl ?? null);
      setUsingDefaultImage(!loaded.profileImageUrl);
    } catch (err: any) {
      setImageError(err?.message || 'Failed to load SAM configuration');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  // The model catalogue belongs to the provider, so it is fetched when the
  // provider changes rather than being a fixed list.
  const loadModels = async (provider: string, target: 'primary' | 'fallback') => {
    if (!provider) return;
    if (target === 'primary') {
      setLoadingModels(true);
      setModelsError(null);
    } else {
      setFallbackModelsError(null);
    }
    try {
      const result = await api.getSAMModels(provider);
      const list = Array.isArray(result?.models) ? result.models : [];
      if (target === 'primary') {
        setModels(list);
      } else {
        setFallbackModels(list);
      }
    } catch (err: any) {
      const message = err?.message || 'Could not load the model list';
      if (target === 'primary') {
        setModels([]);
        setModelsError(message);
      } else {
        setFallbackModels([]);
        setFallbackModelsError(message);
      }
    } finally {
      if (target === 'primary') setLoadingModels(false);
    }
  };

  useEffect(() => {
    const provider = config?.provider;
    if (!provider) return;
    void loadModels(provider, 'primary');
  }, [config?.provider]);

  useEffect(() => {
    const provider = config?.fallbackProvider;
    if (!provider) {
      setFallbackModels([]);
      return;
    }
    void loadModels(provider, 'fallback');
  }, [config?.fallbackProvider]);

  const update = <K extends keyof SamConfig>(key: K, value: SamConfig[K]) => {
    setConfig((current) => (current ? { ...current, [key]: value } : current));
  };

  const handleUpload = async (file: File | null | undefined) => {
    if (!file) return;
    setImageError(null);

    if (!SAM_IMAGE_TYPES.includes(file.type)) {
      setImageError('Choose a WebP or AVIF image.');
      return;
    }
    if (file.size > SAM_IMAGE_MAX_BYTES) {
      setImageError('The image must be 2 MB or smaller.');
      return;
    }

    setUploading(true);
    try {
      const result = await api.uploadSAMProfileImage(file);
      setProfileImageUrl(result?.url ?? null);
      setUsingDefaultImage(false);
      setSelectedFile(null);
      toast.success('SAM profile image uploaded.');
    } catch (err: any) {
      toast.error(err?.message || 'Could not upload the profile image.');
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveImage = async () => {
    setImageError(null);
    setUploading(true);
    try {
      const result = await api.deleteSAMProfileImage();
      setProfileImageUrl(result?.url ?? null);
      setUsingDefaultImage(true);
      toast.success('SAM is back to the default avatar.');
    } catch (err: any) {
      toast.error(err?.message || 'Could not remove the profile image.');
    } finally {
      setUploading(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const response = await api.sendSAMMessage([
        { role: 'user', content: 'Reply with the word "connected" so the operator knows the model answered.' },
      ]);
      toast.success(`SAM answered: ${response.text.slice(0, 120)}`);
    } catch (err: any) {
      toast.error(err?.message || 'SAM could not be reached.');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const saved = await api.updateSAMConfig(config);
      setConfig(saved);
      toast.success('SAM configuration saved.');
    } catch (err: any) {
      toast.error(err?.message || 'Could not save the SAM configuration.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Bot className="h-5 w-5 text-accent" aria-hidden="true" />
            AI Support Agent (SAM)
          </CardTitle>
          <CardDescription className="text-muted-foreground">Loading configuration…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Bot className="h-5 w-5 text-accent" aria-hidden="true" />
          AI Support Agent (SAM)
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Choose the model that answers support questions, the fallback used when
          it fails, and how a visitor reaches a human agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {imageError && (
          <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{imageError}</p>
          </div>
        )}

        {/* Profile image */}
        <div className="space-y-3">
          <Label htmlFor="sam-profile-image" className="text-muted-foreground">
            Profile image
          </Label>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <img
              src={resolveApiAssetUrl(profileImageUrl) || '/sam-avatar-default.svg'}
              alt="SAM profile image"
              className="h-14 w-14 rounded-full border border-border object-cover"
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id="sam-profile-image"
                type="file"
                accept=".webp,.avif"
                className="max-w-xs"
                onChange={(event) => {
                  setImageError(null);
                  setSelectedFile(event.target.files?.[0] ?? null);
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={uploading || !selectedFile}
                  onClick={() => void handleUpload(selectedFile)}
                >
                  <Upload className="w-4 h-4 mr-2" aria-hidden="true" />
                  {uploading ? 'Uploading...' : 'Upload'}
                </Button>
                {!usingDefaultImage && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={uploading}
                    onClick={handleRemoveImage}
                  >
                    <Trash2 className="w-4 h-4 mr-2" aria-hidden="true" />
                    Remove
                  </Button>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">WebP or AVIF only, up to 2 MB.</p>
        </div>

        {/* Primary provider and model */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sam-provider" className="text-muted-foreground">Model provider</Label>
            <Select
              value={config?.provider || 'openrouter'}
              onValueChange={(value) => update('provider', value)}
            >
              <SelectTrigger id="sam-provider" className="w-full" aria-label="Model provider">
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                {SAM_PROVIDERS.map((provider) => (
                  <SelectItem key={provider.value} value={provider.value}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sam-model" className="text-muted-foreground">Model</Label>
            <div className="flex items-center gap-2">
              <Select
                value={config?.model || ''}
                onValueChange={(value) => update('model', value)}
                disabled={loadingModels}
              >
                <SelectTrigger id="sam-model" className="w-full" aria-label="Model">
                  <SelectValue placeholder={loadingModels ? 'Loading models…' : 'Select a model'} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Refresh the model list"
                disabled={loadingModels}
                onClick={() => {
                  if (config?.provider) void loadModels(config.provider, 'primary');
                }}
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
              </Button>
            </div>
            {modelsError && (
              <p className="text-xs text-destructive">
                {modelsError}{' '}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => {
                    if (config?.provider) void loadModels(config.provider, 'primary');
                  }}
                >
                  Retry
                </button>
              </p>
            )}
          </div>
        </div>

        {/* Fallback provider and model */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sam-fallback-provider" className="text-muted-foreground">Fallback provider</Label>
            <Select
              value={config?.fallbackProvider || 'none'}
              onValueChange={(value) =>
                update('fallbackProvider', value === 'none' ? null : value)
              }
            >
              <SelectTrigger id="sam-fallback-provider" className="w-full" aria-label="Fallback provider">
                <SelectValue placeholder="No fallback" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No fallback</SelectItem>
                {SAM_PROVIDERS.map((provider) => (
                  <SelectItem key={provider.value} value={provider.value}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sam-fallback-model" className="text-muted-foreground">Fallback model</Label>
            <Select
              value={config?.fallbackModel || ''}
              onValueChange={(value) => update('fallbackModel', value)}
              disabled={!config?.fallbackProvider}
            >
              <SelectTrigger id="sam-fallback-model" className="w-full" aria-label="Fallback model">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {fallbackModels.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fallbackModelsError && (
              <p className="text-xs text-destructive">
                {fallbackModelsError}{' '}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => {
                    if (config?.fallbackProvider) void loadModels(config.fallbackProvider, 'fallback');
                  }}
                >
                  Retry
                </button>
              </p>
            )}
          </div>
        </div>

        {/* Human support */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sam-support-email" className="text-muted-foreground">Human support email</Label>
            <Input
              id="sam-support-email"
              type="email"
              placeholder="support@example.com"
              value={config?.humanSupportEmail ?? ''}
              onChange={(event) => update('humanSupportEmail', event.target.value)}
              className="bg-background border-border"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sam-support-url" className="text-muted-foreground">Human support URL</Label>
            <Input
              id="sam-support-url"
              type="url"
              placeholder="https://example.com/support"
              value={config?.humanSupportUrl ?? ''}
              onChange={(event) => update('humanSupportUrl', event.target.value)}
              className="bg-background border-border"
            />
          </div>
        </div>

        {/* Switch */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Label htmlFor="sam-enabled" className="text-muted-foreground">SAM enabled</Label>
          <Switch
            id="sam-enabled"
            checked={config?.enabled ?? false}
            onCheckedChange={(checked) => update('enabled', checked)}
            aria-label="SAM enabled"
          />
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="outline"
            onClick={handleTest}
            disabled={testing}
          >
            <Plug className="w-4 h-4 mr-2" aria-hidden="true" />
            {testing ? 'Testing...' : 'Test Connection'}
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="bg-accent hover:bg-accent/90 text-accent-foreground"
          >
            {saving ? 'Saving...' : 'Save SAM configuration'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SuperAdminSettings() {
  const [settings, setSettings] = useState<SuperAdminSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [backupLoading, setBackupLoading] = useState(false);
  const [backupSuccess, setBackupSuccess] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);

  const [restoreLoading, setRestoreLoading] = useState(false);
  const [backups, setBackups] = useState<SuperAdminBackup[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState(false);

  const [healthLoading, setHealthLoading] = useState(false);
  const [healthStatus, setHealthStatus] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
    loadBackups();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setSettings(await api.getSystemSettings());
      setError('');
    } catch (err: any) {
      setError(err.message || 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (settingId: string, value: string) => {
    try {
      setSaving(settingId);
      setSuccess(null);
      await api.updateSystemSetting(settingId, value);
      setSuccess(settingId);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err instanceof Error ? `Failed to update setting: ${err.message}` : 'Failed to update setting.');
    } finally {
      setSaving(null);
    }
  };

  const handleTriggerBackup = async () => {
    setBackupLoading(true);
    setBackupSuccess(false);
    setBackupError(null);
    try {
      await api.triggerBackup();
      setBackupSuccess(true);
    } catch (err: any) {
      setBackupError(err.message || 'Failed to trigger backup');
    } finally {
      setBackupLoading(false);
      setTimeout(() => setBackupSuccess(false), 3000);
    }
  };

  const loadBackups = async () => {
    try {
      setBackups(await api.getBackups());
    } catch (err: any) {
      console.error('Failed to load backups:', err?.message ?? err);
    }
  };
  const handleTriggerRestore = async () => {
    if (!selectedBackup) {
      setRestoreError('Please select a backup to restore.');
      return;
    }
    setRestoreLoading(true);
    setRestoreSuccess(false);
    setRestoreError(null);
    try {
      const path = `backups/${selectedBackup}`;
      await api.triggerRestore(path);
      setRestoreSuccess(true);
    } catch (err: any) {
      setRestoreError(err.message || 'Failed to trigger restore');
    } finally {
      setRestoreLoading(false);
      setTimeout(() => setRestoreSuccess(false), 3000);
    }
  };

  const handleGetSystemHealth = async () => {
    setHealthLoading(true);
    setHealthStatus(null);
    setHealthError(null);
    try {
      const response = await api.getSystemHealth() as { status?: string } | null;
      if (response && typeof response.status === 'string') {
        setHealthStatus(response.status);
      } else {
        setHealthError('Invalid response from health endpoint');
      }
    } catch (err: any) {
      setHealthError(err?.message || 'Failed to get system health');
    } finally {
      setHealthLoading(false);
    }
  };

  const groupedSettings = settings.reduce((acc, setting) => {
    if (!acc[setting.category]) {
      acc[setting.category] = [];
    }
    acc[setting.category].push(setting);
    return acc;
  }, {} as Record<string, SuperAdminSetting[]>);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 space-y-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold text-foreground">System Settings</h1>
        <p className="text-muted-foreground mt-1">Configure system-wide settings and preferences</p>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2">
          <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="space-y-6">
        {Object.entries(groupedSettings).map(([category, categorySettings]) => (
          <Card key={category} className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground capitalize">{category} Settings</CardTitle>
              <CardDescription className="text-muted-foreground">
                Manage {category} configuration
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {categorySettings.map((setting) => (
                <div key={setting.id} className="space-y-2">
                  <Label htmlFor={setting.id} className="text-muted-foreground capitalize">
                    {setting.setting_key.replace(/_/g, ' ')}
                  </Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id={setting.id}
                      defaultValue={setting.setting_value}
                      onBlur={(e) => {
                        if (e.target.value !== setting.setting_value) {
                          handleSave(setting.id, e.target.value);
                        }
                      }}
                      className="bg-background border-border"
                    />
                    {saving === setting.id && (
                      <Button disabled className="bg-accent/10 text-accent">
                        Saving...
                      </Button>
                    )}
                    {success === setting.id && (
                      <Button disabled className="bg-success/10 text-success">
                        <CheckCircle className="w-4 h-4 mr-2" />
                        Saved
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}

        {/* Two-factor for the master session. First, because it is the one
            control here that affects who can reach the console at all. */}
        <SuperAdminTwoFactor />

        {/* The AI support assistant's configuration. */}
        <SAMSettings />

        {/* System Operations */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground">System Operations</CardTitle>
            <CardDescription className="text-muted-foreground">
              Perform critical system operations like backup, restore, and health checks.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Label className="text-muted-foreground">Trigger System Backup</Label>
              <Button
                onClick={handleTriggerBackup}
                disabled={backupLoading}
                className="bg-accent hover:bg-accent/90 text-accent-foreground"
              >
                {backupLoading ? 'Backing up...' : <><HardDriveUpload className="w-4 h-4 mr-2" /> Trigger Backup</>}
              </Button>
            </div>
            {backupSuccess && <p className="text-success text-sm flex items-center"><CheckCircle className="w-4 h-4 mr-1" /> Backup successful!</p>}
            {backupError && <p className="text-destructive text-sm flex items-center"><AlertCircle className="w-4 h-4 mr-1" /> {backupError}</p>}

            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-foreground">Restore from Backup</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <Label htmlFor="backup-select" className="text-muted-foreground">Select a backup to restore</Label>
                  <select
                    id="backup-select"
                    aria-label="Select a backup to restore"
                    title="Select a backup to restore"
                    value={selectedBackup || ''}
                    onChange={(e) => setSelectedBackup(e.target.value)}
                    className="w-full p-2 rounded-md bg-background border-border text-foreground"
                  >
                    <option value="" disabled>Select a backup</option>
                    {backups.map((backup) => (
                      <option key={backup.name} value={backup.name}>
                        {backup.name} ({new Date(backup.createdAt).toLocaleString()})
                      </option>
                    ))}
                  </select>
                </div>
                <Button onClick={handleTriggerRestore} disabled={restoreLoading || !selectedBackup} className="mt-4 w-full bg-accent hover:bg-accent/90 text-accent-foreground">
                  {restoreLoading ? 'Restoring...' : <><HardDriveDownload className="w-4 h-4 mr-2" /> Restore Selected Backup</>}
                </Button>
                {restoreSuccess && <p className="mt-2 text-sm text-success flex items-center"><CheckCircle className="w-4 h-4 mr-2" />Restore successful!</p>}
                {restoreError && <p className="mt-2 text-sm text-destructive flex items-center"><AlertCircle className="w-4 h-4 mr-2" />{restoreError}</p>}
              </CardContent>
            </Card>
            {restoreSuccess && <p className="text-success text-sm flex items-center"><CheckCircle className="w-4 h-4 mr-1" /> Restore successful!</p>}
            {restoreError && <p className="text-destructive text-sm flex items-center"><AlertCircle className="w-4 h-4 mr-1" /> {restoreError}</p>}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Label className="text-muted-foreground">Check System Health</Label>
              <Button
                onClick={handleGetSystemHealth}
                disabled={healthLoading}
                className="bg-accent hover:bg-accent/90 text-accent-foreground"
              >
                {healthLoading ? 'Checking...' : <><HeartPulse className="w-4 h-4 mr-2" /> Check Health</>}
              </Button>
            </div>
            {healthStatus && <p className="text-success text-sm flex items-center"><CheckCircle className="w-4 h-4 mr-1" /> System Health: {healthStatus}</p>}
            {healthError && <p className="text-destructive text-sm flex items-center"><AlertCircle className="w-4 h-4 mr-1" /> {healthError}</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
