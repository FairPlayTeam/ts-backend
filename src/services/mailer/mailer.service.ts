import nodemailer from 'nodemailer';
import {
  APP_PRODUCT_NAME,
  EMAIL_VERIFICATION_CODE_TTL_MINUTES,
  PASSWORD_RESET_CODE_TTL_MINUTES,
} from '../../config/constants.js';
import { buildTransactionalEmailHtml, buildTransactionalEmailText } from './mailer.templates.js';
import { MailerConfigurationError, MailerDeliveryError } from './mailer.errors.js';
import type { MailerConfig } from './mailer.types.js';
import {
  noopOperationLogger,
  observeOperation,
  type OperationLogger,
} from '../../lib/operationMetrics.js';

type MailTransporter = Pick<nodemailer.Transporter, 'sendMail'> & {
  close?(): void;
};

type MailerDependencies = {
  config: MailerConfig | null;
  createTransporter?: (config: MailerConfig) => MailTransporter;
  logger?: OperationLogger;
};

type SmtpTransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  ignoreTLS?: true;
  requireTLS?: true;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  auth: {
    user: string;
    pass: string;
  };
};

type MailerTemplate = 'password-reset' | 'verification';

type SendAppEmailInput = {
  email: string;
  subject: string;
  template: MailerTemplate;
  text: string;
  html: string;
};

type SendCodeEmailInput = {
  code: string;
  email: string;
  expiryMinutes: number;
  footerText: string;
  htmlTitle: string;
  intro: string;
  subject: string;
  template: MailerTemplate;
  textTitle: string;
};

export const createSmtpTransportOptions = (config: MailerConfig): SmtpTransportOptions => {
  const tlsOptions = (() => {
    switch (config.smtpTlsMode) {
      case 'implicit':
        return { secure: true };
      case 'starttls':
        return { secure: false, requireTLS: true as const };
      case 'none':
        return { secure: false, ignoreTLS: true as const };
    }
  })();

  return {
    host: config.smtpHost,
    port: config.smtpPort,
    ...tlsOptions,
    connectionTimeout: config.operationTimeoutMs,
    greetingTimeout: config.operationTimeoutMs,
    socketTimeout: config.operationTimeoutMs,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  };
};

const createDefaultTransporter = (config: MailerConfig): MailTransporter =>
  nodemailer.createTransport(createSmtpTransportOptions(config));

const getMailerConfig = (mailerConfig: MailerConfig | null): MailerConfig => {
  if (!mailerConfig) {
    throw new MailerConfigurationError(
      'Email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_TLS_MODE, SMTP_USER, SMTP_PASS, and SMTP_FROM.',
    );
  }

  return mailerConfig;
};

export const createMailerService = (deps: MailerDependencies) => {
  let transporter: MailTransporter | null = null;
  const logger = deps.logger ?? noopOperationLogger;

  const getTransporter = (mailerConfig: MailerConfig): MailTransporter => {
    transporter ??= (deps.createTransporter ?? createDefaultTransporter)(mailerConfig);
    return transporter;
  };

  const abortActiveDelivery = (mailer: MailTransporter): void => {
    mailer.close?.();

    if (transporter === mailer) {
      transporter = null;
    }
  };

  const sendAppEmail = async (
    mailerConfig: MailerConfig,
    { email, subject, template, text, html }: SendAppEmailInput,
  ): Promise<void> => {
    const mailer = getTransporter(mailerConfig);

    await observeOperation({
      operation: 'smtp.sendMail',
      timeoutMs: mailerConfig.operationTimeoutMs,
      logger,
      data: {
        smtpHost: mailerConfig.smtpHost,
        smtpPort: mailerConfig.smtpPort,
        smtpTlsMode: mailerConfig.smtpTlsMode,
        subject,
        template,
      },
      successMessage: 'SMTP email delivery completed',
      failureMessage: 'SMTP email delivery failed',
      onAbort: () => {
        abortActiveDelivery(mailer);
      },
      run: () =>
        mailer.sendMail({
          from: `"${APP_PRODUCT_NAME}" <${mailerConfig.smtpFrom}>`,
          to: email,
          subject,
          text,
          html,
        }),
    });
  };

  const sendCodeEmail = async ({
    code,
    email,
    expiryMinutes,
    footerText,
    htmlTitle,
    intro,
    subject,
    template,
    textTitle,
  }: SendCodeEmailInput): Promise<void> => {
    const mailerConfig = getMailerConfig(deps.config);
    const expiryLabel = `This code expires in ${expiryMinutes} minutes.`;

    try {
      await sendAppEmail(mailerConfig, {
        email,
        subject,
        template,
        text: buildTransactionalEmailText({
          title: textTitle,
          actionCode: code,
          expiryLabel,
          footerText,
        }),
        html: buildTransactionalEmailHtml({
          title: htmlTitle,
          intro,
          actionCode: code,
          expiryLabel,
          footerText,
        }),
      });
    } catch (err) {
      throw new MailerDeliveryError(`Email delivery failed for ${template}`, err);
    }
  };

  return {
    async sendVerificationEmail(email: string, code: string): Promise<void> {
      await sendCodeEmail({
        code,
        email,
        expiryMinutes: EMAIL_VERIFICATION_CODE_TTL_MINUTES,
        footerText: `You received this email because you created an account on ${APP_PRODUCT_NAME}.\nIf you didn't, you can safely ignore it.`,
        htmlTitle: 'Confirm your email',
        intro:
          'Thanks for signing up! Enter the code below to verify your email address and activate your account.',
        subject: 'Verify your email',
        template: 'verification',
        textTitle: `Verify your ${APP_PRODUCT_NAME} account`,
      });
    },

    async sendPasswordResetEmail(email: string, code: string): Promise<void> {
      await sendCodeEmail({
        code,
        email,
        expiryMinutes: PASSWORD_RESET_CODE_TTL_MINUTES,
        footerText: `You received this email because you requested to reset your password on ${APP_PRODUCT_NAME}.\nIf you didn't, you can safely ignore it.`,
        htmlTitle: 'Reset your password',
        intro:
          'We received a request to reset your password. Enter the code below to choose a new one.',
        subject: 'Reset your password',
        template: 'password-reset',
        textTitle: `Reset your ${APP_PRODUCT_NAME} password`,
      });
    },
  };
};
