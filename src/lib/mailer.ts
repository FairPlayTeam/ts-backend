import nodemailer from 'nodemailer';
import {
  APP_PRODUCT_NAME,
  EMAIL_VERIFICATION_PATH,
} from './appInfo.js';

const requiredEnv = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'FRONTEND_URL', 'SMTP_PORT'] as const;

type MailerEnvKey = (typeof requiredEnv)[number];

type MailerConfig = {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  frontendUrl: string;
};

export class MailerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailerConfigurationError';
  }
}

let transporter: nodemailer.Transporter | null = null;

const getMissingEnv = (): MailerEnvKey[] =>
  requiredEnv.filter((key) => !process.env[key]);

const getMailerConfig = (): MailerConfig => {
  const missing = getMissingEnv();

  if (missing.length > 0) {
    throw new MailerConfigurationError(
      `Email delivery is not configured. Missing environment variables: ${missing.join(', ')}`,
    );
  }

  const smtpPort = Number(process.env.SMTP_PORT);

  if (Number.isNaN(smtpPort) || smtpPort <= 0 || smtpPort > 65535) {
    throw new MailerConfigurationError(
      `SMTP_PORT must be a valid port number, got: ${process.env.SMTP_PORT}`,
    );
  }

  return {
    smtpHost: process.env.SMTP_HOST!,
    smtpPort,
    smtpUser: process.env.SMTP_USER!,
    smtpPass: process.env.SMTP_PASS!,
    smtpFrom: process.env.SMTP_FROM!,
    frontendUrl: process.env.FRONTEND_URL!,
  };
};

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

function buildVerifyUrl(token: string, frontendUrl: string): string {
  const url = new URL(EMAIL_VERIFICATION_PATH, frontendUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

export const assertMailerConfigured = (): void => {
  void getMailerConfig();
};

function buildVerificationHtml(verifyUrl: string): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    </head>
    <body style="margin:0;padding:0;background:#fefefe;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fefefe;padding:32px 0;">
        <tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
            <tr>
              <td style="background:#111111;padding:20px 32px;border-radius:12px 12px 0 0;">
                <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.5px;">${APP_PRODUCT_NAME}</span>
              </td>
            </tr>
            <tr>
              <td style="background:#ffffff;padding:40px 32px 36px;text-align:center;">
                <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111111;">Confirm your email</h1>
                <p style="margin:0 0 28px;font-size:15px;color:#555555;line-height:1.6;">
                  Thanks for signing up! Click the button below to verify your email address and activate your account.<br/>
                  <span style="font-size:13px;color:#999999;">This link expires in <strong style="color:#555555;">24 hours</strong>.</span>
                </p>
                <a href="${verifyUrl}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 36px;border-radius:8px;">
                  Verify my email
                </a>
                <p style="margin:28px 0 0;font-size:12px;color:#aaaaaa;">
                  Or copy this link:<br/>
                  <a href="${verifyUrl}" style="color:#888888;word-break:break-all;">${verifyUrl}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="background:#111111;padding:16px 32px;border-radius:0 0 12px 12px;text-align:center;">
                <p style="margin:0;font-size:12px;color:#bbbbbb;">
                  You received this email because you created an account on ${APP_PRODUCT_NAME}.<br/>
                  If you didn't, you can safely ignore it.
                </p>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const config = getMailerConfig();
  const verifyUrl = buildVerifyUrl(token, config.frontendUrl);
  const mailer = getTransporter(config);

  try {
    await mailer.sendMail({
      from: `"${APP_PRODUCT_NAME}" <${config.smtpFrom}>`,
      to: email,
      subject: 'Verify your email',
      text: `Verify your ${APP_PRODUCT_NAME} account: ${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you didn't create an account, you can safely ignore this email.`,
      html: buildVerificationHtml(verifyUrl),
    });
  } catch (err) {
    console.error(`Failed to send verification email to ${email}:`, err);
    throw new Error(
      `Failed to send verification email to ${email}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
