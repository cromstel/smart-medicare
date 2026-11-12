import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import '../config/env.js';
import { isConfigured } from '../config/env.js';



/**
 * Built-in provider configurations.
 * Users can override these or add custom providers via EMAIL_PROVIDERS env var.
 */
const BUILTIN_PROVIDERS: Record<string, { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } }> = {
  gmail: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // TLS on port 587
  },
  outlook: {
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
  },
  outlook_com: {
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
  },
  yahoo: {
    host: 'smtp.mail.yahoo.com',
    port: 587,
    secure: false,
  },
  sendgrid: {
    host: 'smtp.sendgrid.net',
    port: 587,
    secure: false,
  },
  mailgun: {
    host: 'smtp.mailgun.org',
    port: 587,
    secure: false,
  },
  postmark: {
    host: 'smtp.postmarkapp.com',
    port: 587,
    secure: false,
  },
  amazon_ses: {
    host: 'email-smtp.us-east-1.amazonaws.com',
    port: 587,
    secure: false,
  },
  mailjet: {
    host: 'in-v3.mailjet.com',
    port: 587,
    secure: false,
  },
  sparkpost: {
    host: 'smtp.sparkpostmail.com',
    port: 587,
    secure: false,
  },
};

/**
 * Parses custom providers from EMAIL_PROVIDERS environment variable.
 * Format: JSON object with provider names as keys.
 * Example: {"custom": {"host": "smtp.custom.com", "port": 587, "secure": false}}
 */
function getCustomProviders(): Record<string, { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } }> {
  const envProviders = process.env.EMAIL_PROVIDERS?.trim();
  if (!envProviders) return {};

  try {
    const parsed = JSON.parse(envProviders);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } }>;
  } catch {
    console.warn('[mail] Failed to parse EMAIL_PROVIDERS, ignoring custom providers');
    return {};
  }
}

/**
 * Merges built-in and custom providers.
 * Custom providers override built-in ones with the same name.
 */
function getAllProviders(): Record<string, { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } }> {
  const custom = getCustomProviders();
  return { ...BUILTIN_PROVIDERS, ...custom };
}

/**
 * Resolves the email provider configuration.
 * Priority: explicit env vars > provider config > defaults
 */
function resolveTransportConfig(): { transporter: Transporter; fromAddress: string; fromName: string; defaultReplyTo: string } {
  // Check for explicit SMTP_* env vars (highest priority - backward compatibility)
  if (process.env.SMTP_HOST) {
    if (!isConfigured(process.env.SMTP_HOST)) {
      throw new Error('Email is not configured: set SMTP_HOST, SMTP_PORT and SMTP_USERNAME / SMTP_PASSWORD');
    }
    if (!process.env.SMTP_USER && !process.env.SMTP_USERNAME) {
      throw new Error('Email is not configured: set SMTP_USERNAME (or SMTP_USER) and SMTP_PASSWORD (or SMTP_PASS)');
    }

    const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.SMTP_USERNAME || 'noreply@example.com';
    const fromName = (process.env.MAIL_FROM_NAME || 'Smart MediCare').trim();
    const defaultReplyTo = process.env.SMTP_REPLY_TO?.trim() || fromAddress;

    return {
      transporter: nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER || process.env.SMTP_USERNAME!, pass: process.env.SMTP_PASS || process.env.SMTP_PASSWORD! },
      }),
      fromAddress,
      fromName,
      defaultReplyTo,
    };
  }

  // No explicit SMTP config - use provider-based configuration
  const providerName = process.env.EMAIL_PROVIDER?.toLowerCase().trim() || 'gmail';
  const providerConfig = getAllProviders()[providerName.toLowerCase()];

  if (!providerConfig) {
    const available = Object.keys(getAllProviders()).join(', ');
    throw new Error(`Unknown email provider: ${providerName}. Available: ${available}. Use EMAIL_PROVIDERS to add custom providers.`);
  }

  // Get credentials from environment
  const user = process.env.SMTP_USER || process.env.SMTP_USERNAME || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD || process.env.EMAIL_PASS;

  if (!isConfigured(providerConfig.host)) {
    throw new Error(`Email provider ${providerName} is not configured: host is missing`);
  }

  if (!isConfigured(process.env.EMAIL_FROM)) {
    throw new Error('Email is not configured: set EMAIL_FROM environment variable');
  }

  const transporter = nodemailer.createTransport({
    host: providerConfig.host,
    port: providerConfig.port,
    secure: providerConfig.secure,
    auth: providerConfig.auth || (user && pass ? { user, pass } : undefined),
  });

  const fromAddress = process.env.EMAIL_FROM || 'noreply@example.com';
  const fromName = (process.env.MAIL_FROM_NAME || 'Smart MediCare').trim();
  const defaultReplyTo = process.env.SMTP_REPLY_TO?.trim() || process.env.EMAIL_REPLY_TO?.trim() || fromAddress;

  return { transporter, fromAddress, fromName: fromName || 'Smart MediCare', defaultReplyTo };
}

/**
 * Sends an email using the configured transporter.
 */
interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  from?: string;
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }>;
}

export const sendEmail = async (options: MailOptions): Promise<void> => {
  try {
    const { transporter, fromAddress, fromName, defaultReplyTo } = resolveTransportConfig();

    const fromHeader = options.from
      ? (options.from.includes('<') ? options.from : `"${options.from}"`)
      : `${fromName ? `"${fromName}"` : ''} <${fromAddress}>`;

    const mailOptions = {
      from: fromHeader,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
      replyTo: options.replyTo ?? defaultReplyTo,
      attachments: options.attachments,
    };

    await transporter.sendMail(mailOptions);
    console.log('[mail] Email sent successfully to:', options.to);
  } catch (error) {
    console.error('[mail] Error sending email:', error);
    throw new Error('Failed to send email', { cause: error });
  }
};

export { resolveTransportConfig };