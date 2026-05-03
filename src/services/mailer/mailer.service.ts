import { type MailerConfig } from './mailer.types.js';
import nodemailer from 'nodemailer';
import {
  APP_PRODUCT_NAME,
  EMAIL_VERIFICATION_PATH,
  EMAIL_VERIFICATION_TOKEN_TTL_DAYS,
} from '../../config/constants.js';
import { buildTransactionalEmailHtml, buildTransactionalEmailText } from './mailer.templates.js';
import { MailerConfigurationError, MailerDeliveryError } from './mailer.errors.js';
import config from '../../config/env.js';

let transporter: nodemailer.Transporter | null = null;

function buildVerifyUrl(token: string, frontendUrl: string): string {
  const url = new URL(EMAIL_VERIFICATION_PATH, frontendUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

const getTransporter = (config: MailerConfig): nodemailer.Transporter => {
  if (transporter) {
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });

  return transporter;
};

const getMailerConfig = (mailerConfig: MailerConfig | null): MailerConfig => {
  if (!mailerConfig) {
    throw new MailerConfigurationError(
      'Email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, and FRONTEND_URL.',
    );
  }

  return mailerConfig;
};

async function sendAppEmail(
  config: MailerConfig,
  {
    email,
    subject,
    text,
    html,
  }: {
    email: string;
    subject: string;
    text: string;
    html: string;
  },
): Promise<void> {
  const mailer = getTransporter(config);

  await mailer.sendMail({
    from: `"${APP_PRODUCT_NAME}" <${config.smtpFrom}>`,
    to: email,
    subject,
    text,
    html,
  });
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const mailerConfig = getMailerConfig(config.mailer);
  const verifyUrl = buildVerifyUrl(token, mailerConfig.frontendUrl);
  const title = 'Confirm your email';
  const intro =
    'Thanks for signing up! Click the button below to verify your email address and activate your account.';
  const expiryLabel = `This link expires in ${EMAIL_VERIFICATION_TOKEN_TTL_DAYS} days.`;
  const footerText = `You received this email because you created an account on ${APP_PRODUCT_NAME}.\nIf you didn't, you can safely ignore it.`;

  try {
    await sendAppEmail(mailerConfig, {
      email,
      subject: 'Verify your email',
      text: buildTransactionalEmailText({
        title: `Verify your ${APP_PRODUCT_NAME} account`,
        actionUrl: verifyUrl,
        expiryLabel,
        footerText,
      }),
      html: buildTransactionalEmailHtml({
        title,
        intro,
        actionLabel: 'Verify my email',
        actionUrl: verifyUrl,
        expiryLabel,
        footerText,
      }),
    });
  } catch (err) {
    throw new MailerDeliveryError('Email delivery failed', err);
  }
}
